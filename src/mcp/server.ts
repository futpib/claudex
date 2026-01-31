import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools/index.js';
// Import tools to register them
// eslint-disable-next-line import-x/no-unassigned-import
import './tools/requirements.js';

export async function startServer() {
	// eslint-disable-next-line @typescript-eslint/no-deprecated
	const server = new Server(
		{ name: 'claudex', version: '1.0.0' },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [ ...tools.values() ].map(t => t.definition),
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const handler = tools.get(request.params.name);
		if (!handler) {
			throw new Error(`Unknown tool: ${request.params.name}`);
		}

		const content = await handler.handle(request.params.arguments);
		return { content };
	});

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
