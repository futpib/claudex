import type { Rule } from './index.js';

export const banPipeToFilter: Rule = {
	meta: {
		name: 'ban-pipe-to-filter',
		configKey: 'banPipeToFilter',
		recommended: true,
		phase: 'main',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const pipedFilter = await context.helpers.getPipedFilterCommand(context.command);
		if (pipedFilter) {
			return {
				type: 'violation',
				messages: [
					`❌ Piping output to ${pipedFilter} is not allowed`,
					'Run the command first, then search its output file using the Read or Grep tools.',
					'For long output, the command result will include an output file path you can search.',
				],
			};
		}

		return { type: 'pass' };
	},
};
