/* eslint-disable @typescript-eslint/naming-convention */
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'ava';
import { setupHookSymlinks } from './in-docker.js';

async function mkTemporaryDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), 'claudex-in-docker-test-'));
}

async function writeSettings(claudeDir: string, hooks: unknown): Promise<void> {
	await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ hooks }));
}

function preToolUse(command: string) {
	return { PreToolUse: [ { matcher: '.*', hooks: [ { type: 'command', command } ] } ] };
}

test('setupHookSymlinks creates a wrapper for a claudex hook command', async t => {
	const claudeDir = await mkTemporaryDir();
	const binDir = await mkTemporaryDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));
	t.teardown(async () => fs.rm(binDir, { recursive: true }));

	const claudexBin = path.join(binDir, 'claudex');
	await writeSettings(claudeDir, preToolUse(`${claudexBin} hook pre-tool-use`));

	await setupHookSymlinks(claudeDir);

	const content = await fs.readFile(claudexBin, 'utf8');
	t.true(content.startsWith('#!/bin/sh'));
	t.true(content.includes('cli.js'));
});

// Reproduces the clobber bug: a foreign hook command pointing at an absolute
// path (e.g. slopctl's lifecycle hooks) used to have its real binary unlinked
// and replaced with a claudex node wrapper.
test('setupHookSymlinks leaves a non-claudex hook binary untouched', async t => {
	const claudeDir = await mkTemporaryDir();
	const binDir = await mkTemporaryDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));
	t.teardown(async () => fs.rm(binDir, { recursive: true }));

	const slopctlBin = path.join(binDir, 'slopctl');
	const original = '#!/bin/sh\necho real-slopctl\n';
	await fs.writeFile(slopctlBin, original, { mode: 0o755 });

	await writeSettings(claudeDir, preToolUse(`${slopctlBin} hook PreToolUse`));

	await setupHookSymlinks(claudeDir);

	t.is(await fs.readFile(slopctlBin, 'utf8'), original);
});

test('setupHookSymlinks refuses to overwrite a pre-existing non-wrapper file', async t => {
	const claudeDir = await mkTemporaryDir();
	const binDir = await mkTemporaryDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));
	t.teardown(async () => fs.rm(binDir, { recursive: true }));

	// A real file whose basename happens to be "claudex" but which isn't our
	// wrapper must be preserved, not destroyed.
	const claudexBin = path.join(binDir, 'claudex');
	const original = '#!/bin/sh\necho a-real-claudex-binary\n';
	await fs.writeFile(claudexBin, original, { mode: 0o755 });

	await writeSettings(claudeDir, preToolUse(`${claudexBin} hook pre-tool-use`));

	await setupHookSymlinks(claudeDir);

	t.is(await fs.readFile(claudexBin, 'utf8'), original);
});

test('setupHookSymlinks rewrites its own wrapper on a second run', async t => {
	const claudeDir = await mkTemporaryDir();
	const binDir = await mkTemporaryDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));
	t.teardown(async () => fs.rm(binDir, { recursive: true }));

	const claudexBin = path.join(binDir, 'claudex');
	await writeSettings(claudeDir, preToolUse(`${claudexBin} hook pre-tool-use`));

	await setupHookSymlinks(claudeDir);
	const first = await fs.readFile(claudexBin, 'utf8');
	await setupHookSymlinks(claudeDir);
	const second = await fs.readFile(claudexBin, 'utf8');

	t.is(second, first);
	t.true(second.startsWith('#!/bin/sh'));
});

test('setupHookSymlinks ignores a relative claudex command rather than writing into cwd', async t => {
	const claudeDir = await mkTemporaryDir();
	t.teardown(async () => fs.rm(claudeDir, { recursive: true }));

	await writeSettings(claudeDir, preToolUse('claudex hook pre-tool-use'));

	await setupHookSymlinks(claudeDir);

	await t.throwsAsync(fs.access(path.join(process.cwd(), 'claudex')));
});
