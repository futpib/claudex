import process from 'node:process';
import path from 'node:path';
import {
	mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import test from 'ava';

const hookPath = path.join(import.meta.dirname, '../../../build/hooks/pre-tool-use.js');

type HookResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

async function createHooksConfig(hooks: Record<string, boolean>) {
	const configDir = await mkdtemp(path.join(tmpdir(), 'claudex-hook-test-'));
	const claudexDir = path.join(configDir, 'claudex');
	await mkdir(claudexDir, { recursive: true });
	await writeFile(
		path.join(claudexDir, 'config.json'),
		JSON.stringify({ hooks }),
	);
	return {
		configDir,
		async [Symbol.asyncDispose]() {
			await rm(configDir, { recursive: true });
		},
	};
}

async function runHook(input: Record<string, unknown>, env?: Record<string, string>): Promise<HookResult> {
	const result = await execa('node', [ hookPath ], {
		input: JSON.stringify(input),
		reject: false,
		env: { ...process.env, ...env },
	});
	return {
		exitCode: result.exitCode ?? 0,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

function createBashToolInput(command: string): Record<string, unknown> {
	return {
		session_id: 'test-session', // eslint-disable-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript', // eslint-disable-line @typescript-eslint/naming-convention
		tool_name: 'Bash', // eslint-disable-line @typescript-eslint/naming-convention
		tool_input: { command }, // eslint-disable-line @typescript-eslint/naming-convention
	};
}

function createMcpToolInput(toolName: string): Record<string, unknown> {
	return {
		session_id: 'test-session', // eslint-disable-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript', // eslint-disable-line @typescript-eslint/naming-convention
		tool_name: toolName, // eslint-disable-line @typescript-eslint/naming-convention
		tool_input: {}, // eslint-disable-line @typescript-eslint/naming-convention
	};
}

function env(config: { configDir: string }) {
	return { XDG_CONFIG_HOME: config.configDir }; // eslint-disable-line @typescript-eslint/naming-convention
}

// --- gh api ---

test('rejects gh api -X POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/pulls/123/comments -X POST -f body=\'message\''),
		env(config),
	);
	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('write operation'));
});

test('rejects gh api -X PUT', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/issues/1 -X PUT -f state=closed'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects gh api -X PATCH', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/issues/1 -X PATCH -f state=closed'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects gh api -X DELETE', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/comments/123 -X DELETE'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects gh api graphql mutation', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api graphql -f query=\'mutation { resolveReviewThread(input: {threadId: "PRRT_123"}) { thread { isResolved } } }\''),
		env(config),
	);
	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('GraphQL mutation'));
});

test('rejects gh api with -f flag (implicit POST)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/pulls/123/comments -f body=\'hello\''),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('allows gh api GET (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/pulls/123/comments'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- glab api ---

test('rejects glab api -X POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('glab api projects/123/merge_requests/456/notes -X POST -f body=\'message\''),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects glab api graphql mutation', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('glab api graphql -f query=\'mutation { mergeRequestSetDraft(input: {iid: "456"}) { mergeRequest { draft } } }\''),
		env(config),
	);
	t.is(result.exitCode, 2);
});

// --- curl ---

test('rejects curl -X POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.github.com/repos/owner/repo/issues/1/comments -d \'{"body":"message"}\''),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl -X PUT', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X PUT https://api.example.com/resource/1 -d \'{"key":"value"}\''),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl --data (implicit POST)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --data \'{"body":"hello"}\' https://api.github.com/repos/owner/repo/issues/1/comments'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl -d (implicit POST)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -d @payload.json https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl --json', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --json \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl -F (multipart form)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -F file=@upload.txt https://api.example.com/upload'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl --form', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --form file=@upload.txt https://api.example.com/upload'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl -T (upload/PUT)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -T file.tar.gz https://api.example.com/upload'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl --upload-file', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --upload-file file.tar.gz https://api.example.com/upload'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl --data-binary', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --data-binary @payload.bin https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl --data-raw', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --data-raw \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects curl --data-urlencode', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --data-urlencode \'name=hello world\' https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('allows curl GET (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl https://api.github.com/repos/owner/repo/issues'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows curl -X GET', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X GET https://api.github.com/repos/owner/repo/issues'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- wget ---

test('rejects wget --post-data', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --post-data=\'{"body":"message"}\' https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects wget --post-file', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --post-file=payload.json https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects wget --method=POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --method=POST --body-data=\'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects wget --method=PUT', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --method=PUT --body-data=\'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects wget --body-data', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --body-data=\'{"key":"value"}\' --method=PATCH https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects wget --body-file', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --body-file=payload.json --method=DELETE https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('allows wget GET (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget https://example.com/file.tar.gz'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- httpie ---

test('rejects http POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('http POST https://api.github.com/repos/owner/repo/issues/1/comments body=\'message\''),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects http PUT', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('http PUT https://api.example.com/resource/1 key=value'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects http PATCH', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('http PATCH https://api.example.com/resource/1 status=closed'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects http DELETE', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('http DELETE https://api.example.com/resource/1'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects https POST (httpie shortcut)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('https POST api.example.com/endpoint key=value'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

// --- MCP tools ---

test('rejects Slack MCP send_message', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_send_message'),
		env(config),
	);
	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('MCP write tool'));
});

test('rejects Slack MCP schedule_message', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_schedule_message'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects Slack MCP create_canvas', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_create_canvas'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects Slack MCP send_message_draft', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_send_message_draft'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('allows Slack MCP read_channel', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_read_channel'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows Slack MCP search_public', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_search_public'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows Slack MCP read_user_profile', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_read_user_profile'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('rejects Notion MCP create page', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__notion__notion_create_page'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects Notion MCP update page', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__notion__notion_update_page'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects Notion MCP delete block', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__notion__notion_delete_block'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects Notion MCP append block', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__notion__notion_append_block_children'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects generic MCP write tool', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__some_server__upload_file'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects camelCase MCP write tool', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__server__createFooEntity'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects kebab-case MCP write tool', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__server__delete-item'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('allows generic MCP read tool', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__some_server__get_status'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- generic fallback (unknown commands with write flags) ---

test('rejects unknown command with -X POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('xh -X POST https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('xh'));
});

test('rejects unknown command with --data flag', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('mycurl --data \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects unknown command with --json flag', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('apicli --json \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects unknown command with --request POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('fetcher --request POST https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('rejects unknown command with mutation in args', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('graphql-client \'mutation { deleteUser(id: "123") { id } }\''),
		env(config),
	);
	t.is(result.exitCode, 2);
});

test('allows unknown command without write flags', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('xh GET https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- disabled rule ---

test('allows write operations when rule is disabled', async t => {
	await using config = await createHooksConfig({ banWriteOperations: false });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.example.com/endpoint -d \'{"key":"value"}\''),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows MCP write operations when rule is disabled', async t => {
	await using config = await createHooksConfig({ banWriteOperations: false });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_send_message'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- error message content ---

test('error message nudges toward seeking user approval', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('explicit approval'));
});
