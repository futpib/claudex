import type { Rule } from './index.js';

export const banCommandChaining: Rule = {
	meta: {
		name: 'ban-command-chaining',
		configKey: 'banCommandChaining',
		recommended: true,
		phase: 'main',
		description: 'Do not chain bash commands with &&, ||, ;, or newline; run commands separately',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (await context.helpers.hasChainOperators(context.command)) {
			return {
				type: 'violation',
				messages: [
					'❌ Chaining bash commands with &&, ||, ;, or newline is not allowed',
					'Please run commands separately for better tracking and error handling.',
				],
			};
		}

		return { type: 'pass' };
	},
};
