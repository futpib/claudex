import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools } from './tools/index.js';
// Import tools to register them
// eslint-disable-next-line import-x/no-unassigned-import
import './tools/requirements.js';

export async function startServer() {
	const server = new McpServer(
		{ name: 'claudex', version: '1.0.0' },
		{ capabilities: { tools: {} } },
	);

	// Register all tools
	for (const [ name, handler ] of tools) {
		server.registerTool(name, {
			title: handler.definition.name,
			description: handler.definition.description,
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
			inputSchema: handler.definition.inputSchema as any,
		}, async (args: unknown) => {
			const content = await handler.handle(args as Record<string, unknown>);
			return { content };
		});
	}

	const transport = new StdioServerTransport();
	await server.connect(transport);
}
