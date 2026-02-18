import type { Rule } from './index.js';

export const banBashMinusC: Rule = {
	meta: {
		name: 'ban-bash-minus-c',
		configKey: 'banBashMinusC',
		recommended: true,
		phase: 'main',
		description: 'Do not use bash -c or sh -c; run the command directly',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (await context.helpers.hasBashMinusCWrapper(context.command)) {
			return {
				type: 'violation',
				messages: [
					'❌ Using bash -c or sh -c is not allowed',
					'Run the command directly instead of wrapping it in bash -c.',
				],
			};
		}

		return { type: 'pass' };
	},
};
