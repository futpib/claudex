import type { Rule } from './index.js';

export const banPkillF: Rule = {
	meta: {
		name: 'ban-pkill-f',
		configKey: 'banPkillF',
		recommended: true,
		phase: 'main',
		description: 'Do not use pkill -f; the full-command-line match can hit unintended processes',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const invocations = await context.helpers.extractSimpleCommandInvocations(context.command);
		for (const invocation of invocations) {
			if (invocation.name !== 'pkill') {
				continue;
			}

			for (const arg of invocation.args) {
				if (arg === '--full' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) {
					return {
						type: 'violation',
						messages: [
							'❌ pkill -f is not allowed',
							'The -f/--full flag matches the full command line, which can match patterns far broader than intended and kill unrelated processes.',
							'Use pgrep -f to inspect matches first, then kill specific PIDs — or pkill without -f to match only by process name.',
						],
					};
				}
			}
		}

		return { type: 'pass' };
	},
};
