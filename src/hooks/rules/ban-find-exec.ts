import type { Rule } from './index.js';

export const banFindExec: Rule = {
	meta: {
		name: 'ban-find-exec',
		configKey: 'banFindExec',
		recommended: true,
		phase: 'main',
		description: 'Do not use find -exec; list matches first, then operate on them with explicit commands (use rg for search)',
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
						'Use rg (ripgrep) directly instead — it recursively searches directories by default.',
					],
				};
			}

			return {
				type: 'violation',
				messages: [
					'❌ find -exec is not allowed',
					'Run find without -exec to list matching files, then operate on them with explicit commands.',
				],
			};
		}

		return { type: 'pass' };
	},
};
