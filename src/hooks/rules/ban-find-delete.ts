import type { Rule } from './index.js';

export const banFindDelete: Rule = {
	meta: {
		name: 'ban-find-delete',
		configKey: 'banFindDelete',
		recommended: true,
		phase: 'main',
		description: 'Do not use find -delete; list matches first, review them, then remove with rm',
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
					'Run find without -delete first, review the matched files, then remove them explicitly with rm.',
				],
			};
		}

		return { type: 'pass' };
	},
};
