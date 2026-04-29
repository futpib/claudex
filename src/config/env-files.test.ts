import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import test from 'ava';
import {
	resolveEnvFileSources,
	loadEnvFileSources,
} from './env-files.js';

async function makeTemporaryDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), 'claudex-env-test-'));
}

test('resolveEnvFileSources returns empty when nothing configured', async t => {
	const cwd = await makeTemporaryDir();
	try {
		const sources = await resolveEnvFileSources({
			envFile: undefined,
			envFiles: undefined,
			cliEnvFiles: [],
			cwd,
		});
		t.deepEqual(sources, []);
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test('resolveEnvFileSources auto-loads .env and sorted .env.* when envFile is true', async t => {
	const cwd = await makeTemporaryDir();
	try {
		await fs.writeFile(path.join(cwd, '.env'), 'A=1\n');
		await fs.writeFile(path.join(cwd, '.env.local'), 'B=2\n');
		await fs.writeFile(path.join(cwd, '.env.development'), 'C=3\n');
		await fs.writeFile(path.join(cwd, '.env.example'), 'D=4\n');
		await fs.writeFile(path.join(cwd, 'unrelated.txt'), 'E=5\n');

		const sources = await resolveEnvFileSources({
			envFile: true,
			envFiles: undefined,
			cliEnvFiles: [],
			cwd,
		});

		t.deepEqual(
			sources.map(s => path.basename(s.path)),
			[ '.env', '.env.development', '.env.local' ],
		);
		t.true(sources.every(s => s.optional));
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test('resolveEnvFileSources resolves explicit envFile (string), envFiles, and cliEnvFiles', async t => {
	const cwd = await makeTemporaryDir();
	try {
		const sources = await resolveEnvFileSources({
			envFile: 'one.env',
			envFiles: [ 'two.env', '/abs/three.env' ],
			cliEnvFiles: [ 'four.env' ],
			cwd,
		});

		t.deepEqual(
			sources.map(s => ({ name: path.basename(s.path), optional: s.optional })),
			[
				{ name: 'one.env', optional: false },
				{ name: 'two.env', optional: false },
				{ name: 'three.env', optional: false },
				{ name: 'four.env', optional: false },
			],
		);
		t.is(sources[0].path, path.join(cwd, 'one.env'));
		t.is(sources[2].path, '/abs/three.env');
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test('loadEnvFileSources merges files with last-wins precedence', async t => {
	const cwd = await makeTemporaryDir();
	try {
		await fs.writeFile(path.join(cwd, 'a.env'), 'X=1\nY=a\n');
		await fs.writeFile(path.join(cwd, 'b.env'), 'X=2\nZ=b\n');

		const values = await loadEnvFileSources([
			{ path: path.join(cwd, 'a.env'), optional: false },
			{ path: path.join(cwd, 'b.env'), optional: false },
		]);

		t.deepEqual(values, { X: '2', Y: 'a', Z: 'b' });
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test('loadEnvFileSources silently skips missing optional files', async t => {
	const cwd = await makeTemporaryDir();
	try {
		const values = await loadEnvFileSources([
			{ path: path.join(cwd, 'missing.env'), optional: true },
		]);
		t.deepEqual(values, {});
	} finally {
		await fs.rm(cwd, { recursive: true, force: true });
	}
});

test('loadEnvFileSources warns and continues on missing required files', async t => {
	const cwd = await makeTemporaryDir();
	const originalError = console.error;
	const messages: string[] = [];
	console.error = (...args: unknown[]) => {
		messages.push(args.join(' '));
	};

	try {
		await fs.writeFile(path.join(cwd, 'present.env'), 'KEEP=1\n');
		const values = await loadEnvFileSources([
			{ path: path.join(cwd, 'missing.env'), optional: false },
			{ path: path.join(cwd, 'present.env'), optional: false },
		]);
		t.deepEqual(values, { KEEP: '1' });
		t.true(messages.some(m => m.includes('missing.env')));
	} finally {
		console.error = originalError;
		await fs.rm(cwd, { recursive: true, force: true });
	}
});
