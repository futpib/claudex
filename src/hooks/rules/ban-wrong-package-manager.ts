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

		const commands = await context.helpers.extractCommandNames(context.command);
		const allowed = allowedCommands[detectedPm];
		const wrongCommands = [ ...commands ].filter(cmd => allPmCommands.has(cmd) && !allowed.has(cmd));

		if (wrongCommands.length === 0) {
			return { type: 'pass' };
		}

		return {
			type: 'violation',
			messages: [
				`❌ Wrong package manager: ${wrongCommands.join(', ')} used in a ${detectedPm} project`,
				`This project uses ${detectedPm} (detected from lock file). Use ${[ ...allowed ].join('/')} instead.`,
			],
		};
	},
};
