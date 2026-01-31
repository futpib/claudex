import type { Rule } from './index.js';

export const banGitC: Rule = {
	name: 'ban-git-c',
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
