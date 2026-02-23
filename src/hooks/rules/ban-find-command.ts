import type { Rule } from './index.js';

// Find flags that the Glob tool cannot handle.
// If a find invocation uses any of these, it's allowed through.
const unsupportedFlags = new Set([
	'-type',
	'-mtime',
	'-ctime',
	'-atime',
	'-newer',
	'-newermt',
	'-newerct',
	'-newerat',
	'-size',
	'-empty',
	'-user',
	'-group',
	'-perm',
	'-readable',
	'-writable',
	'-executable',
	'-links',
	'-inum',
	'-samefile',
	'-regex',
	'-iregex',
	'-delete',
	'-print0',
	'-printf',
	'-ls',
	'-fls',
	'-exec',
	'-execdir',
	'-ok',
	'-okdir',
	'-prune',
	'-quit',
]);

function hasUnsupportedFlags(args: string[]): boolean {
	for (const arg of args) {
		if (unsupportedFlags.has(arg)) {
			return true;
		}
	}

	return false;
}

export const banFindCommand: Rule = {
	meta: {
		name: 'ban-find-command',
		configKey: 'banFindCommand',
		recommended: true,
		phase: 'main',
		description: 'Do not use find to search for files by name; use the builtin Glob tool instead',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const args = await context.helpers.getFindCommandArgs(context.command);
		if (!args) {
			return { type: 'pass' };
		}

		if (hasUnsupportedFlags(args)) {
			return { type: 'pass' };
		}

		return {
			type: 'violation',
			messages: [
				'❌ Using find to search for files by name is not allowed',
				'Use the builtin Glob tool instead, which supports recursive glob patterns like "**/*.ts".',
			],
		};
	},
};
