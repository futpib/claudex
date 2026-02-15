import type { Rule } from './index.js';

export const banFindExec: Rule = {
	meta: {
		name: 'ban-find-exec',
		configKey: 'banFindExec',
		recommended: true,
		phase: 'main',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const execCommand = await context.helpers.getFindExecCommand(context.command);
		if (execCommand) {
			if (execCommand === 'grep') {
				return {
					type: 'violation',
					messages: [
						'❌ find -exec grep is not allowed',
						'Use rg (ripgrep) or the Grep tool instead, which recursively search directories by default.',
					],
				};
			}

			return {
				type: 'violation',
				messages: [
					`❌ find -exec is not allowed`,
					'Use the Glob tool to find files by pattern, and the Grep tool to search file contents.',
				],
			};
		}

		return { type: 'pass' };
	},
};
