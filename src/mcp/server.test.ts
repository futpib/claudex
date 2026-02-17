import test from 'ava';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tools } from './tools/index.js';
// Import tools to register them
// eslint-disable-next-line import-x/no-unassigned-import
import './tools/requirements.js';

async function createTestClientServer() {
	const server = new McpServer(
		{ name: 'claudex-test', version: '1.0.0' },
		{ capabilities: { tools: {} } },
	);

	for (const [ name, handler ] of tools) {
		server.registerTool(name, {
			title: handler.definition.name,
			description: handler.definition.description,
			inputSchema: handler.definition.inputSchema,
		}, async (args: unknown) => {
			const content = await handler.handle(args as Record<string, unknown>);
			return { content };
		});
	}

	const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();

	const client = new Client({ name: 'test-client', version: '1.0.0' });

	await server.connect(serverTransport);
	await client.connect(clientTransport);

	return { client, server };
}

test('listTools returns all registered tools', async t => {
	const { client } = await createTestClientServer();

	const result = await client.listTools();
	const toolNames = result.tools.map(tool => tool.name).sort();

	t.deepEqual(toolNames, [ 'requirements_add', 'requirements_list', 'requirements_remove' ]);
});

test('requirements_list returns empty list initially', async t => {
	const { client } = await createTestClientServer();

	const result = await client.callTool({ name: 'requirements_list', arguments: {} });

	t.is(result.isError, undefined);
	t.deepEqual(result.content, [ { type: 'text', text: 'No requirements.' } ]);
});

test('requirements_add adds a requirement', async t => {
	const { client } = await createTestClientServer();

	const result = await client.callTool({ name: 'requirements_add', arguments: { requirement: 'Test requirement' } });

	t.is(result.isError, undefined);
	t.deepEqual(result.content, [ { type: 'text', text: 'Added requirement #1: Test requirement' } ]);
});

test('requirements_remove removes a requirement', async t => {
	const { client } = await createTestClientServer();

	await client.callTool({ name: 'requirements_add', arguments: { requirement: 'To be removed' } });

	const listResult = await client.callTool({ name: 'requirements_list', arguments: {} });
	const listText = (listResult.content as Array<{ text: string }>)[0].text;
	const lastIndex = listText.trim().split('\n').length;

	const result = await client.callTool({ name: 'requirements_remove', arguments: { index: lastIndex } });

	t.is(result.isError, undefined);
	t.deepEqual(result.content, [ { type: 'text', text: `Removed requirement #${lastIndex}: To be removed` } ]);
});
