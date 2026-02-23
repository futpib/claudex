import type { Rule } from './index.js';

function hasAnyFlags(args: string[]): boolean {
	for (const arg of args) {
		if (arg.startsWith('-')) {
			return true;
		}
	}

	return false;
}

export const banLsCommand: Rule = {
	meta: {
		name: 'ban-ls-command',
		configKey: 'banLsCommand',
		recommended: true,
		phase: 'main',
		description: 'Do not use ls to list files; use the builtin Glob tool instead',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const args = await context.helpers.getLsCommandArgs(context.command);
		if (!args) {
			return { type: 'pass' };
		}

		// Allow ls with any flags (e.g. -la, -R, -s) since Glob can't replicate that output
		if (hasAnyFlags(args)) {
			return { type: 'pass' };
		}

		return {
			type: 'violation',
			messages: [
				'❌ Using ls to list files is not allowed',
				'Use the builtin Glob tool instead (e.g. pattern "dir/*" to list directory contents).',
				'If you need detailed file info (permissions, sizes, etc.), use ls with flags like -la.',
			],
		};
	},
};
