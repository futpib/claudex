import type { Rule } from './index.js';

export const banCommandChaining: Rule = {
	name: 'ban-command-chaining',
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (await context.helpers.hasChainOperators(context.command)) {
			return {
				type: 'violation',
				messages: [
					'❌ Chaining bash commands with &&, ||, or ; is not allowed',
					'Please run commands separately for better tracking and error handling.',
				],
			};
		}

		return { type: 'pass' };
	},
};
