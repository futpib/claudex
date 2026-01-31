import type { Rule } from './index.js';

export const banGitCommitAmend: Rule = {
	name: 'ban-git-commit-amend',
	fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (context.command.toLowerCase().includes('git commit') && context.command.toLowerCase().includes('--amend')) {
			return {
				type: 'violation',
				messages: [
					'❌ git commit --amend is not allowed',
					'Amending commits can alter git history and is not permitted.',
				],
			};
		}

		return { type: 'pass' };
	},
};
