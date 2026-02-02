import type { Rule } from './index.js';

export const banBackgroundBash: Rule = {
	meta: {
		name: 'ban-background-bash',
		configKey: 'banBackgroundBash',
		recommended: true,
		phase: 'main',
	},
	fn(context) {
		if (context.knownInput?.tool_name !== 'Bash') {
			return { type: 'pass' };
		}

		if (context.knownInput.tool_input.run_in_background === true) {
			return {
				type: 'violation',
				messages: [
					'❌ Running bash commands in background is not allowed',
					'Background bash processes cannot be monitored properly and may cause issues.',
				],
			};
		}

		return { type: 'pass' };
	},
};
