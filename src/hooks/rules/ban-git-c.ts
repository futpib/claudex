import type { Rule } from './index.js';

export const banGitC: Rule = {
	meta: {
		name: 'ban-git-c',
		configKey: 'banGitC',
		recommended: true,
		phase: 'main',
		description: 'Do not use git -C; run git commands in the current directory',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (await context.helpers.hasGitChangeDirectoryFlag(context.command)) {
			return {
				type: 'violation',
				messages: [
					'❌ git -C is not allowed',
					'Running git commands in a different directory is not permitted.',
					'Please cd to the target directory and run git commands there instead.',
				],
			};
		}

		return { type: 'pass' };
	},
};
