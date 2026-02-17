import type { Rule } from './index.js';

export const banGitCommitAmend: Rule = {
	meta: {
		name: 'ban-git-commit-amend',
		configKey: 'banGitCommitAmend',
		recommended: true,
		phase: 'main',
		description: 'Do not use git commit --amend; create new commits instead',
	},
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
