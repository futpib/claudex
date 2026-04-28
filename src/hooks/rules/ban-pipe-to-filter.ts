import type { Rule } from './index.js';

export const banPipeToFilter: Rule = {
	meta: {
		name: 'ban-pipe-to-filter',
		configKey: 'banPipeToFilter',
		recommended: true,
		phase: 'main',
		description: 'Do not pipe output to grep, head, tail, awk, sed, cut, sort, uniq, wc, tr; use Read/Grep tools instead',
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
					`Banned filter commands: ${[ ...context.helpers.filterCommands ].join(', ')}.`,
					'Run the command first, then read its output file using the Read tool.',
					'For long output, the command result will include an output file path you can read.',
				],
			};
		}

		return { type: 'pass' };
	},
};
