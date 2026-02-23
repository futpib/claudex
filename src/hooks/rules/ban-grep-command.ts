import type { Rule } from './index.js';

// Flags that the builtin Grep tool can handle (mapped from rg flags).
// Flags not in this set indicate the invocation needs real grep/rg.
const supportedShortFlags = new Set([
	'-A', // After context
	'-B', // Before context
	'-C', // Context
	'-i', // Case insensitive
	'-n', // Line numbers
	'-l', // Files with matches
	'-c', // Count
	'-U', // Multiline
	'-e', // Pattern (positional equivalent exists)
	'-r', // Recursive (default behavior)
	'-R', // Recursive (default behavior)
]);

const supportedLongFlags = new Set([
	'--after-context',
	'--before-context',
	'--context',
	'--ignore-case',
	'--line-number',
	'--files-with-matches',
	'--count',
	'--multiline',
	'--multiline-dotall',
	'--glob',
	'--type',
	'--regexp',
	'--recursive',
	'--include', // Grep --include maps to glob
	'--no-filename',
	'--with-filename',
	'--color',
	'--colour',
	'--no-line-number',
]);

// Long flags that take a value via --flag=value or --flag value
const longFlagsWithValue = new Set([
	'--after-context',
	'--before-context',
	'--context',
	'--glob',
	'--type',
	'--regexp',
	'--include',
	'--color',
	'--colour',
]);

// Short flags that take a value as the next argument
const shortFlagsWithValue = new Set([
	'-A',
	'-B',
	'-C',
	'-e',
]);

function hasUnsupportedFlags(args: string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === '--') {
			// Everything after -- is positional
			break;
		}

		if (arg.startsWith('--')) {
			const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
			if (!supportedLongFlags.has(flagName)) {
				return true;
			}

			// Skip value argument for flags that take one (when not using = syntax)
			if (!arg.includes('=') && longFlagsWithValue.has(flagName)) {
				i++;
			}
		} else if (arg.startsWith('-') && arg.length > 1) {
			// Could be combined short flags like -rni or a flag with value like -A3
			const flagChars = arg.slice(1);
			for (let j = 0; j < flagChars.length; j++) {
				const flag = `-${flagChars[j]}`;
				if (!supportedShortFlags.has(flag)) {
					return true;
				}

				// If this short flag takes a value and there are remaining chars, they are the value
				if (shortFlagsWithValue.has(flag) && j + 1 < flagChars.length) {
					break;
				}

				// If this short flag takes a value and it's the last char, skip next arg
				if (shortFlagsWithValue.has(flag) && j + 1 === flagChars.length) {
					i++;
				}
			}
		}

		// Positional args (pattern, path) are fine
	}

	return false;
}

export const banGrepCommand: Rule = {
	meta: {
		name: 'ban-grep-command',
		configKey: 'banGrepCommand',
		recommended: true,
		phase: 'main',
		description: 'Do not use grep or rg to search file contents; use the builtin Grep tool instead',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const result = await context.helpers.getGrepCommandArgs(context.command);
		if (!result) {
			return { type: 'pass' };
		}

		// Allow if the invocation uses flags the Grep tool can't handle
		if (hasUnsupportedFlags(result.args)) {
			return { type: 'pass' };
		}

		return {
			type: 'violation',
			messages: [
				`❌ Using ${result.command} to search file contents is not allowed`,
				'Use the builtin Grep tool instead, which runs ripgrep with correct permissions and access.',
				'The Grep tool supports: regex patterns, glob/type filtering, context lines, match counts, and file-only output.',
			],
		};
	},
};
