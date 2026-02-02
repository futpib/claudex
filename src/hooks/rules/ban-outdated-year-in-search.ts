import type { Rule } from './index.js';

export const banOutdatedYearInSearch: Rule = {
	meta: {
		name: 'ban-outdated-year-in-search',
		configKey: 'banOutdatedYearInSearch',
		recommended: true,
		phase: 'pre-exit',
	},
	fn(context) {
		if (context.knownInput?.tool_name !== 'WebSearch') {
			return { type: 'pass' };
		}

		const { query } = context.knownInput.tool_input;
		const currentYear = new Date().getFullYear();
		const yearMatch = /\b(20[2-9]\d)\b/.exec(query);
		if (yearMatch && Number(yearMatch[1]) < currentYear) {
			return {
				type: 'violation',
				messages: [
					`❌ Web searches containing outdated year "${yearMatch[1]}" are not allowed`,
					`The current year is ${currentYear}. Please update your search query to use the current year.`,
				],
			};
		}

		return { type: 'pass' };
	},
};
