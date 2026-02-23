import type { Rule } from './index.js';

export const banFindDelete: Rule = {
	meta: {
		name: 'ban-find-delete',
		configKey: 'banFindDelete',
		recommended: true,
		phase: 'main',
		description: 'Do not use find -delete; use Glob to find files and remove them explicitly',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const args = await context.helpers.getFindCommandArgs(context.command);
		if (!args) {
			return { type: 'pass' };
		}

		if (args.includes('-delete')) {
			return {
				type: 'violation',
				messages: [
					'❌ find -delete is not allowed',
					'Use the Glob tool to find files by pattern, then remove them explicitly with rm.',
				],
			};
		}

		return { type: 'pass' };
	},
};
