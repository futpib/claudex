/* eslint-disable @typescript-eslint/naming-convention */
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'ava';
import toml from '@iarna/toml';
import {
	ensureHookSetup,
	ensureCodexHookSetup,
	ensureCodexMcpConfig,
	ensureOpencodeMcpConfig,
} from './hooks.js';

async function mkTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), 'claudex-hooks-test-'));
}

async function readSettings(claudeDir: string): Promise<Record<string, unknown>> {
	const content = await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8');
	return JSON.parse(content) as Record<string, unknown>;
}

test('ensureHookSetup writes claudeSettings overlay into settings.json', async t => {
	const claudeDir = await mkTempDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));

	await ensureHookSetup(claudeDir, {
		showThinkingSummaries: true,
		includeCoAuthoredBy: false,
	});

	const settings = await readSettings(claudeDir);
	t.is(settings.showThinkingSummaries, true);
	t.is(settings.includeCoAuthoredBy, false);
});

test('ensureHookSetup preserves pre-existing unknown keys in settings.json', async t => {
	const claudeDir = await mkTempDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));

	await fs.writeFile(
		path.join(claudeDir, 'settings.json'),
		JSON.stringify({ showThinkingSummaries: true, userSetKey: 'keep-me' }),
	);

	await ensureHookSetup(claudeDir);

	const settings = await readSettings(claudeDir);
	t.is(settings.showThinkingSummaries, true);
	t.is(settings.userSetKey, 'keep-me');
});

test('ensureHookSetup writes per-account settings.json independently', async t => {
	const accountA = await mkTempDir();
	const accountB = await mkTempDir();
	t.teardown(async () => fs.rm(accountA, { recursive: true }));
	t.teardown(async () => fs.rm(accountB, { recursive: true }));

	await ensureHookSetup(accountA, { showThinkingSummaries: true });
	await ensureHookSetup(accountB, { showThinkingSummaries: false });

	const a = await readSettings(accountA);
	const b = await readSettings(accountB);
	t.is(a.showThinkingSummaries, true);
	t.is(b.showThinkingSummaries, false);
});

test('ensureHookSetup ignores hooks key in claudeSettings overlay', async t => {
	const claudeDir = await mkTempDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));

	await ensureHookSetup(claudeDir, {
		hooks: { PreToolUse: [ { matcher: '.*', hooks: [] } ] },
		showThinkingSummaries: true,
	});

	const settings = await readSettings(claudeDir);
	t.is(settings.showThinkingSummaries, true);
	const hooks = settings.hooks as Record<string, unknown> | undefined;
	t.truthy(hooks);
	// Claudex adds its own PreToolUse hook; the overlay's empty one is not adopted
	const preToolUse = (hooks as Record<string, Array<{ hooks: unknown[] }>>).PreToolUse;
	t.truthy(preToolUse?.[0]?.hooks?.length);
});

test('ensureHookSetup writes PostToolUse alongside the other four events', async t => {
	const claudeDir = await mkTempDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));

	await ensureHookSetup(claudeDir);

	const settings = await readSettings(claudeDir);
	const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
	t.truthy(hooks.PreToolUse?.[0]?.hooks?.[0]?.command);
	t.truthy(hooks.PostToolUse?.[0]?.hooks?.[0]?.command);
	t.truthy(hooks.UserPromptSubmit?.[0]?.hooks?.[0]?.command);
	t.truthy(hooks.Notification?.[0]?.hooks?.[0]?.command);
	t.truthy(hooks.Stop?.[0]?.hooks?.[0]?.command);
	t.regex(hooks.PostToolUse[0].hooks[0].command, /hook post-tool-use$/);
});

test('ensureCodexHookSetup writes hooks.json with all six events and flips feature flag', async t => {
	const codexDir = await mkTempDir();
	t.teardown(async () => fs.rm(codexDir, { recursive: true }));

	await ensureCodexHookSetup(codexDir);

	const hooksFile = JSON.parse(await fs.readFile(path.join(codexDir, 'hooks.json'), 'utf8')) as {
		hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
	};
	const events = [ 'SessionStart', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PermissionRequest', 'Stop' ];
	for (const event of events) {
		t.truthy(hooksFile.hooks[event], `missing ${event}`);
		t.truthy(hooksFile.hooks[event][0].hooks[0].command.includes('claudex hook '), `${event} command: ${hooksFile.hooks[event][0].hooks[0].command}`);
	}

	const tomlContent = await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8');
	const config = toml.parse(tomlContent) as { features?: { codex_hooks?: boolean } };
	t.is(config.features?.codex_hooks, true);
});

test('ensureCodexHookSetup preserves user-added hook entries and unrelated config.toml keys', async t => {
	const codexDir = await mkTempDir();
	t.teardown(async () => fs.rm(codexDir, { recursive: true }));

	await fs.writeFile(
		path.join(codexDir, 'hooks.json'),
		JSON.stringify({
			hooks: {
				PreToolUse: [ { matcher: 'Bash', hooks: [ { type: 'command', command: 'python3 /mine.py' } ] } ],
			},
		}),
	);
	await fs.writeFile(
		path.join(codexDir, 'config.toml'),
		'model = "gpt-5"\n[features]\nanother_flag = true\n',
	);

	await ensureCodexHookSetup(codexDir);

	const hooksFile = JSON.parse(await fs.readFile(path.join(codexDir, 'hooks.json'), 'utf8')) as {
		hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
	};
	const preToolUseGroups = hooksFile.hooks.PreToolUse;
	t.true(preToolUseGroups.some(g => g.hooks.some(h => h.command === 'python3 /mine.py')), 'user entry preserved');
	t.true(preToolUseGroups.some(g => g.hooks.some(h => h.command.includes('claudex hook pre-tool-use'))), 'claudex entry added');

	const config = toml.parse(await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8')) as {
		model?: string;
		features?: { codex_hooks?: boolean; another_flag?: boolean };
	};
	t.is(config.model, 'gpt-5');
	t.is(config.features?.another_flag, true);
	t.is(config.features?.codex_hooks, true);
});

test('ensureOpencodeMcpConfig merges without clobbering existing opencode.json keys', async t => {
	const configDir = await mkTempDir();
	t.teardown(async () => fs.rm(configDir, { recursive: true }));

	await fs.writeFile(
		path.join(configDir, 'opencode.json'),
		JSON.stringify({
			theme: 'catppuccin',
			mcp: {
				other: { type: 'remote', url: 'https://example.com' },
			},
		}),
	);

	await ensureOpencodeMcpConfig(configDir, '/tmp/fake-project-root');

	const opencodeJson = JSON.parse(await fs.readFile(path.join(configDir, 'opencode.json'), 'utf8')) as {
		theme?: string;
		mcp?: Record<string, { type: string; command?: string[] }>;
	};
	t.is(opencodeJson.theme, 'catppuccin');
	t.is(opencodeJson.mcp?.other?.type, 'remote');
	t.is(opencodeJson.mcp?.claudex?.type, 'local');
	t.deepEqual(opencodeJson.mcp?.claudex?.command, [ 'node', '/tmp/fake-project-root/build/mcp/cli.js' ]);
});

test('ensureCodexMcpConfig preserves other mcp_servers tables and unrelated sections', async t => {
	const codexDir = await mkTempDir();
	t.teardown(async () => fs.rm(codexDir, { recursive: true }));

	await fs.writeFile(
		path.join(codexDir, 'config.toml'),
		'model = "gpt-5"\n[mcp_servers.other]\ncommand = "node"\nargs = ["/other.js"]\n',
	);

	await ensureCodexMcpConfig(codexDir, '/tmp/fake-project-root');

	const config = toml.parse(await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8')) as {
		model?: string;
		mcp_servers?: Record<string, { command?: string; args?: string[] }>;
	};
	t.is(config.model, 'gpt-5');
	t.is(config.mcp_servers?.other?.command, 'node');
	t.deepEqual(config.mcp_servers?.other?.args, [ '/other.js' ]);
	t.is(config.mcp_servers?.claudex?.command, 'node');
	t.deepEqual(config.mcp_servers?.claudex?.args, [ '/tmp/fake-project-root/build/mcp/cli.js' ]);
});
