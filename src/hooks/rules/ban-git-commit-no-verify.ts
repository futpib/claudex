import type { Rule } from './index.js';

export const banGitCommitNoVerify: Rule = {
	name: 'ban-git-commit-no-verify',
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
