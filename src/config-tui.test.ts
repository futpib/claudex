import {
	mkdtemp, rm, readFile, mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'ava';
import { execa, type ResultPromise } from 'execa';

const cliPath = path.join(import.meta.dirname, '../build/cli.js');

const keys = {
	enter: '\r',
	down: '\u001B[B',
};

/**
 * Wait for the process stdout to contain a specific string, then send a key.
 * This is more robust than fixed delays — works regardless of CI speed.
 */
async function waitForPromptAndSend(
	proc: ResultPromise,
	waitFor: string,
	key: string,
	timeoutMs = 10_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		let buffer = '';
		let resolved = false;

		const timer = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				reject(new Error(`Timed out waiting for "${waitFor}" in stdout. Buffer so far:\n${buffer}`));
			}
		}, timeoutMs);

		const onData = (chunk: Uint8Array) => {
			buffer += new TextDecoder().decode(chunk);
			if (!resolved && buffer.includes(waitFor)) {
				resolved = true;
				clearTimeout(timer);
				proc.stdout!.off('data', onData);
				proc.stdin!.write(key);
				resolve();
			}
		};

		proc.stdout!.on('data', onData);
	});
}

async function createTemporaryConfigDir() {
	const configDir = await mkdtemp(path.join(tmpdir(), 'claudex-tui-test-'));
	return {
		configDir,
		async [Symbol.asyncDispose]() {
			await rm(configDir, { recursive: true });
		},
	};
}

async function readJsonFile(filePath: string): Promise<unknown> {
	const content = await readFile(filePath, 'utf8');
	return JSON.parse(content);
}

// 30s timeout: enough for the TUI interaction in CI
const tuiTimeout = 30_000;

test.serial('add a package via config-interactive', async t => {
	t.timeout(tuiTimeout + 5000);
	await using handle = await createTemporaryConfigDir();

	const proc = execa('node', [ cliPath, 'config-interactive' ], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		reject: false,
		timeout: tuiTimeout,
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: handle.configDir,
		},
	});

	await waitForPromptAndSend(proc, 'Select a configuration key:', keys.enter); // Select "packages"
	await waitForPromptAndSend(proc, 'Action for packages', keys.enter); // Select "Add value"
	await waitForPromptAndSend(proc, 'Value(s) to add to packages', 'vim\r'); // Type value and confirm
	await waitForPromptAndSend(proc, 'Where should this change be written?', keys.down + keys.enter); // Skip "Project" → "Global"

	const result = await proc;
	t.false(result.timedOut, `Process timed out.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
	t.is(result.exitCode, 0, `Exit code ${result.exitCode}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'vim' ]);
});

test.serial('set a boolean via config-interactive', async t => {
	t.timeout(tuiTimeout + 5000);
	await using handle = await createTemporaryConfigDir();

	// Pre-create the config dir so getMergedConfig finds it
	await mkdir(path.join(handle.configDir, 'claudex'), { recursive: true });

	const proc = execa('node', [ cliPath, 'config-interactive' ], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		reject: false,
		timeout: tuiTimeout,
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: handle.configDir,
		},
	});

	// Navigate to shareVolumes: 6 downs from packages(0)
	const downKeys = keys.down.repeat(6);
	await waitForPromptAndSend(proc, 'Select a configuration key:', downKeys + keys.enter); // Select "shareVolumes"
	await waitForPromptAndSend(proc, 'Action for shareVolumes', keys.enter); // Select "Set to true"
	await waitForPromptAndSend(proc, 'Where should this change be written?', keys.down + keys.enter); // Skip "Project" → "Global"

	const result = await proc;
	t.false(result.timedOut, `Process timed out.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
	t.is(result.exitCode, 0, `Exit code ${result.exitCode}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { shareVolumes: boolean }).shareVolumes, true);
});
