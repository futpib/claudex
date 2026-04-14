import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'ava';
import { ensureHookSetup } from './hooks.js';

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
