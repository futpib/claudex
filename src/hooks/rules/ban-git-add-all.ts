import type { Rule } from './index.js';

export const banGitAddAll: Rule = {
	meta: {
		name: 'ban-git-add-all',
		configKey: 'banGitAddAll',
		recommended: true,
		phase: 'main',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const actualCommands = await context.helpers.extractCommandNames(context.command);
		if (actualCommands.has('git')) {
			const gitAddPattern = /\bgit\s+add\s+/;
			if (gitAddPattern.test(context.command)) {
				const bannedFlagPattern = /\bgit\s+add\s+(?:[^|;&]*?\s)?(?:-[a-zA-Z]*A(?:\s|$)|--all\b|--no-ignore-removal\b)/;
				if (bannedFlagPattern.test(context.command)) {
					return {
						type: 'violation',
						messages: [
							'❌ git add -A/--all/--no-ignore-removal is not allowed',
							'These flags stage all changes including deletions across the entire repository.',
							'Please use "git add ." to stage changes in the current directory instead.',
						],
					};
				}
			}
		}

		return { type: 'pass' };
	},
};
