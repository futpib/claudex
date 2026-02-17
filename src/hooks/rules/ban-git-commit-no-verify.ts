import type { Rule } from './index.js';

export const banGitCommitNoVerify: Rule = {
	meta: {
		name: 'ban-git-commit-no-verify',
		configKey: 'banGitCommitNoVerify',
		recommended: true,
		phase: 'main',
		description: 'Do not use git commit --no-verify; always run pre-commit hooks',
	},
	fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (context.command.toLowerCase().includes('git commit') && context.command.toLowerCase().includes('--no-verify')) {
			return {
				type: 'violation',
				messages: [
					'❌ git commit --no-verify is not allowed',
					'Bypassing pre-commit hooks can introduce code quality issues and is not permitted.',
				],
			};
		}

		return { type: 'pass' };
	},
};
