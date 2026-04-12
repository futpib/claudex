import process from 'node:process';
import path from 'node:path';
import {
	mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import test, { type ExecutionContext } from 'ava';

const hookPath = path.join(import.meta.dirname, '../../../build/hooks/pre-tool-use.js');

type HookResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
	json?: Record<string, unknown>;
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
	const stdout = String(result.stdout);
	let json: Record<string, unknown> | undefined;
	try {
		json = JSON.parse(stdout) as Record<string, unknown>;
	} catch {}

	return {
		exitCode: result.exitCode ?? 0,
		stdout,
		stderr: String(result.stderr),
		json,
	};
}

function assertViolation(t: ExecutionContext, result: HookResult, reasonPattern?: string | RegExp) {
	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('claudex confirm'), 'expected stderr to include claudex confirm instructions');
	if (reasonPattern) {
		if (typeof reasonPattern === 'string') {
			t.true(result.stderr.includes(reasonPattern), `expected stderr to include "${reasonPattern}", got "${result.stderr}"`);
		} else {
			t.regex(result.stderr, reasonPattern);
		}
	}
}

function createBashToolInput(command: string, permissionMode?: string): Record<string, unknown> {
	return {
		session_id: 'test-session', // eslint-disable-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript', // eslint-disable-line @typescript-eslint/naming-convention
		permission_mode: permissionMode, // eslint-disable-line @typescript-eslint/naming-convention
		tool_name: 'Bash', // eslint-disable-line @typescript-eslint/naming-convention
		tool_input: { command }, // eslint-disable-line @typescript-eslint/naming-convention
	};
}

function createMcpToolInput(toolName: string, permissionMode?: string): Record<string, unknown> {
	return {
		session_id: 'test-session', // eslint-disable-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript', // eslint-disable-line @typescript-eslint/naming-convention
		permission_mode: permissionMode, // eslint-disable-line @typescript-eslint/naming-convention
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
	assertViolation(t, result, 'write operation');
});

test('rejects gh api -X PUT', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/issues/1 -X PUT -f state=closed'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects gh api -X PATCH', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/issues/1 -X PATCH -f state=closed'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects gh api -X DELETE', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/comments/123 -X DELETE'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects gh api graphql mutation', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api graphql -f query=\'mutation { resolveReviewThread(input: {threadId: "PRRT_123"}) { thread { isResolved } } }\''),
		env(config),
	);
	assertViolation(t, result, 'GraphQL');
});

test('rejects gh api with -f flag (implicit POST)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/pulls/123/comments -f body=\'hello\''),
		env(config),
	);
	assertViolation(t, result);
});

test('allows gh api GET (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh api repos/owner/repo/pulls/123/comments'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- ghx ---

test('rejects ghx api -X POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('ghx api repos/owner/repo/pulls/123/comments -X POST -f body=\'message\''),
		env(config),
	);
	assertViolation(t, result, 'write operation');
});

test('allows ghx pr view --json (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('ghx pr view --json reviews,reviewRequests,comments'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows ghx api GET (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('ghx api repos/owner/repo/pulls/123/comments'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- gh/ghx write subcommands ---

test('rejects gh pr create', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh pr create --title "Fix bug" --body "Details"'),
		env(config),
	);
	assertViolation(t, result, 'write subcommand');
});

test('rejects ghx pr create', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('ghx pr create --repo owner/repo --head feature --title "Fix"'),
		env(config),
	);
	assertViolation(t, result, 'write subcommand');
});

test('rejects gh issue close', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh issue close 123'),
		env(config),
	);
	assertViolation(t, result, 'write subcommand');
});

test('rejects gh pr merge', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh pr merge 123'),
		env(config),
	);
	assertViolation(t, result, 'write subcommand');
});

test('rejects gh release create', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh release create v1.0.0'),
		env(config),
	);
	assertViolation(t, result, 'write subcommand');
});

test('rejects gh repo create', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh repo create my-repo --public'),
		env(config),
	);
	assertViolation(t, result, 'write subcommand');
});

test('allows gh pr view (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh pr view 123'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows gh pr list (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh pr list'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows gh issue view (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh issue view 123'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows gh pr diff (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh pr diff'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows gh pr checkout (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh pr checkout 123'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows gh auth login (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh auth login'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows gh repo clone (read-only)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('gh repo clone owner/repo'),
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
	assertViolation(t, result);
});

test('rejects glab api graphql mutation', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('glab api graphql -f query=\'mutation { mergeRequestSetDraft(input: {iid: "456"}) { mergeRequest { draft } } }\''),
		env(config),
	);
	assertViolation(t, result);
});

// --- curl ---

test('rejects curl -X POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.github.com/repos/owner/repo/issues/1/comments -d \'{"body":"message"}\''),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl -X PUT', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X PUT https://api.example.com/resource/1 -d \'{"key":"value"}\''),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl --data (implicit POST)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --data \'{"body":"hello"}\' https://api.github.com/repos/owner/repo/issues/1/comments'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl -d (implicit POST)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -d @payload.json https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl --json', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --json \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl -F (multipart form)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -F file=@upload.txt https://api.example.com/upload'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl --form', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --form file=@upload.txt https://api.example.com/upload'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl -T (upload/PUT)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -T file.tar.gz https://api.example.com/upload'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl --upload-file', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --upload-file file.tar.gz https://api.example.com/upload'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl --data-binary', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --data-binary @payload.bin https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl --data-raw', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --data-raw \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects curl --data-urlencode', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl --data-urlencode \'name=hello world\' https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
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
	assertViolation(t, result);
});

test('rejects wget --post-file', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --post-file=payload.json https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects wget --method=POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --method=POST --body-data=\'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects wget --method=PUT', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --method=PUT --body-data=\'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects wget --body-data', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --body-data=\'{"key":"value"}\' --method=PATCH https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects wget --body-file', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('wget --body-file=payload.json --method=DELETE https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
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
	assertViolation(t, result);
});

test('rejects http PUT', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('http PUT https://api.example.com/resource/1 key=value'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects http PATCH', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('http PATCH https://api.example.com/resource/1 status=closed'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects http DELETE', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('http DELETE https://api.example.com/resource/1'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects https POST (httpie shortcut)', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('https POST api.example.com/endpoint key=value'),
		env(config),
	);
	assertViolation(t, result);
});

// --- MCP tools ---

test('rejects Slack MCP send_message', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_send_message'),
		env(config),
	);
	assertViolation(t, result, 'MCP write tool');
});

test('rejects Slack MCP schedule_message', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_schedule_message'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects Slack MCP create_canvas', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_create_canvas'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects Slack MCP send_message_draft', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_send_message_draft'),
		env(config),
	);
	assertViolation(t, result);
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
	assertViolation(t, result);
});

test('rejects Notion MCP update page', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__notion__notion_update_page'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects Notion MCP delete block', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__notion__notion_delete_block'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects Notion MCP append block', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__notion__notion_append_block_children'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects generic MCP write tool', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__some_server__upload_file'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects camelCase MCP write tool', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__server__createFooEntity'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects kebab-case MCP write tool', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__server__delete-item'),
		env(config),
	);
	assertViolation(t, result);
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
	assertViolation(t, result, 'xh');
});

test('rejects unknown command with --data flag', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('mycurl --data \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects unknown command with --json flag', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('apicli --json \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects unknown command with --request POST', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('fetcher --request POST https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects unknown command with mutation in args', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('graphql-client \'mutation { deleteUser(id: "123") { id } }\''),
		env(config),
	);
	assertViolation(t, result);
});

test('rejects unknown command with -d flag and URL', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('xh -d \'{"key":"value"}\' https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result);
});

test('allows unknown command with -d flag but no URL', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('tmux new-session -d -s test "sleep 3600"'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows unknown command without write flags', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('xh GET https://api.example.com/endpoint'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows rm of file with mutation in name', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('rm spec/domains/crm/gql/shop_items/update_campaigns_mutation_spec.rb'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows git rm of file with mutation in name', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('git rm spec/domains/crm/gql/shop_items/update_campaigns_mutation_spec.rb'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows git commit with mutation in message', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('git commit -m "Replace fan-out mutations with atomic updateShopItemCampaigns"'),
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

test('violation includes reason describing the write operation', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.example.com/endpoint'),
		env(config),
	);
	assertViolation(t, result, 'write operation');
});

// --- permission modes ---

test('requires confirmation in default permission mode', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.example.com/endpoint', 'default'),
		env(config),
	);
	assertViolation(t, result);
});

test('requires confirmation for MCP in default permission mode', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_send_message', 'default'),
		env(config),
	);
	assertViolation(t, result);
});

test('uses exit code 2 in bypassPermissions mode for bash', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.example.com/endpoint', 'bypassPermissions'),
		env(config),
	);
	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('write operation'));
	t.falsy(result.json, 'should not output JSON in bypass mode');
});

test('uses exit code 2 in bypassPermissions mode for MCP', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createMcpToolInput('mcp__plugin_slack_slack__slack_send_message', 'bypassPermissions'),
		env(config),
	);
	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('MCP write tool'));
	t.falsy(result.json, 'should not output JSON in bypass mode');
});

test('requires confirmation in acceptEdits permission mode', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.example.com/endpoint', 'acceptEdits'),
		env(config),
	);
	assertViolation(t, result);
});

test('requires confirmation in dontAsk permission mode', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.example.com/endpoint', 'dontAsk'),
		env(config),
	);
	assertViolation(t, result);
});

test('requires confirmation in plan permission mode', async t => {
	await using config = await createHooksConfig({ banWriteOperations: true });
	const result = await runHook(
		createBashToolInput('curl -X POST https://api.example.com/endpoint', 'plan'),
		env(config),
	);
	assertViolation(t, result);
});
