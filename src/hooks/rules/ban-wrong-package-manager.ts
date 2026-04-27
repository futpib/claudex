import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Rule } from './index.js';

type PackageManager = 'yarn' | 'bun' | 'pnpm' | 'npm';

const lockFiles: Array<{ file: string; pm: PackageManager }> = [
	{ file: 'yarn.lock', pm: 'yarn' },
	{ file: 'bun.lockb', pm: 'bun' },
	{ file: 'bun.lock', pm: 'bun' },
	{ file: 'pnpm-lock.yaml', pm: 'pnpm' },
	{ file: 'package-lock.json', pm: 'npm' },
];

const allPmCommands = new Set([ 'npm', 'npx', 'yarn', 'bun', 'bunx', 'pnpm', 'pnpx' ]);

const allowedCommands: Record<PackageManager, Set<string>> = {
	yarn: new Set([ 'yarn' ]),
	bun: new Set([ 'bun', 'bunx' ]),
	pnpm: new Set([ 'pnpm', 'pnpx' ]),
	npm: new Set([ 'npm', 'npx' ]),
};

function detectPackageManager(cwd: string): PackageManager | undefined {
	for (const { file, pm } of lockFiles) {
		if (existsSync(join(cwd, file))) {
			return pm;
		}
	}

	return undefined;
}

function isGlobalInvocation(name: string, args: string[]): boolean {
	if (name === 'yarn') {
		return args[0] === 'global';
	}

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '-g' || arg === '--global') {
			return true;
		}

		if (arg === '--location=global') {
			return true;
		}

		if (arg === '--location' && args[i + 1] === 'global') {
			return true;
		}
	}

	return false;
}

export const banWrongPackageManager: Rule = {
	meta: {
		name: 'ban-wrong-package-manager',
		configKey: 'banWrongPackageManager',
		recommended: true,
		phase: 'main',
		description: 'Do not use the wrong package manager; use the one matching the project lock file',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const detectedPm = detectPackageManager(context.cwd);
		if (!detectedPm) {
			return { type: 'pass' };
		}

		const invocations = await context.helpers.extractSimpleCommandInvocations(context.command);
		const allowed = allowedCommands[detectedPm];

		const wrongCommands = new Set<string>();
		for (const { name, args } of invocations) {
			if (!allPmCommands.has(name) || allowed.has(name)) {
				continue;
			}

			if (isGlobalInvocation(name, args)) {
				continue;
			}

			wrongCommands.add(name);
		}

		if (wrongCommands.size === 0) {
			return { type: 'pass' };
		}

		return {
			type: 'violation',
			messages: [
				`❌ Wrong package manager: ${[ ...wrongCommands ].join(', ')} used in a ${detectedPm} project`,
				`cwd: ${context.cwd}`,
				`This project uses ${detectedPm} (detected from lock file). Use ${[ ...allowed ].join('/')} instead.`,
			],
		};
	},
};
