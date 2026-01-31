import { execa } from 'execa';

let gitleaksAvailable: boolean | undefined;
let gitleaksWarningShown = false;

async function isGitleaksAvailable(): Promise<boolean> {
	if (gitleaksAvailable !== undefined) {
		return gitleaksAvailable;
	}

	try {
		await execa('gitleaks', [ 'version' ]);
		gitleaksAvailable = true;
	} catch {
		gitleaksAvailable = false;
		if (!gitleaksWarningShown) {
			console.error('Warning: gitleaks not installed, shielding all environment values as secrets');
			gitleaksWarningShown = true;
		}
	}

	return gitleaksAvailable;
}

/**
 * Check if a value looks like a secret using gitleaks.
 * If gitleaks is not installed, assumes the value is a secret (safe default).
 */
export async function isSecret(value: string): Promise<boolean> {
	if (!await isGitleaksAvailable()) {
		// Safe default: assume everything is a secret
		return true;
	}

	try {
		// Gitleaks stdin exits with 0 if no secrets found, non-zero if secrets found
		await execa('gitleaks', [ 'stdin', '--no-banner' ], {
			input: value,
		});
		return false;
	} catch {
		// Non-zero exit code means secrets were found (or other error - assume secret to be safe)
		return true;
	}
}

/**
 * Check multiple values for secrets in parallel.
 * Returns a Map of value -> isSecret.
 */
export async function checkSecrets(values: string[]): Promise<Map<string, boolean>> {
	const uniqueValues = [ ...new Set(values) ];
	const results = await Promise.all(uniqueValues.map(async value => [ value, await isSecret(value) ] as const));
	return new Map(results);
}

/**
 * Shield a value if it's a secret, otherwise return it unchanged.
 */
export function shieldValue(value: string, isSecretValue: boolean): string {
	if (!isSecretValue) {
		return value;
	}

	return '****';
}

/**
 * Shield environment variables, checking each value with gitleaks.
 * Returns entries formatted as "KEY=value" or "KEY=sh****ed" for secrets.
 */
export async function shieldEnvVars(env: Record<string, string>): Promise<string[]> {
	const entries = Object.entries(env);
	const values = entries.map(([ _, value ]) => value);
	const secretMap = await checkSecrets(values);

	return entries.map(([ key, value ]) => {
		const isSecretValue = secretMap.get(value) ?? true;
		return `${key}=${shieldValue(value, isSecretValue)}`;
	});
}
