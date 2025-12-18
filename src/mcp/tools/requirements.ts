import { registerTool } from './index.js';

// In-memory storage - resets when claudex session ends
const requirements: string[] = [];

function formatRequirements(): string {
	if (requirements.length === 0) {
		return 'No requirements.';
	}

	return requirements.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

registerTool({
	definition: {
		name: 'requirements_add',
		description: 'Add a requirement that must be satisfied for the task to be complete.',
		inputSchema: {
			type: 'object',
			properties: {
				requirement: { type: 'string', description: 'The requirement text' },
			},
			required: [ 'requirement' ],
		},
	},
	async handle(args) {
		const { requirement } = args as { requirement: string };
		requirements.push(requirement);
		return [ { type: 'text', text: `Added requirement #${requirements.length}: ${requirement}` } ];
	},
});

registerTool({
	definition: {
		name: 'requirements_remove',
		description: 'Remove a requirement by its number (1-indexed).',
		inputSchema: {
			type: 'object',
			properties: {
				index: { type: 'number', description: 'The requirement number to remove (1-indexed)' },
			},
			required: [ 'index' ],
		},
	},
	async handle(args) {
		const { index } = args as { index: number };
		if (index < 1 || index > requirements.length) {
			return [ { type: 'text', text: `Invalid index: ${index}. Valid range: 1-${requirements.length}` } ];
		}

		const removed = requirements.splice(index - 1, 1)[0];
		return [ { type: 'text', text: `Removed requirement #${index}: ${removed}` } ];
	},
});

registerTool({
	definition: {
		name: 'requirements_list',
		description: 'List all current requirements.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},
	async handle() {
		return [ { type: 'text', text: formatRequirements() } ];
	},
});
