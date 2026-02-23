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

async function sleep(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

async function sendKeys(
	proc: ResultPromise,
	keySequence: string[],
	delay = 500,
): Promise<void> {
	for (const key of keySequence) {
		proc.stdin!.write(key);
		// eslint-disable-next-line no-await-in-loop
		await sleep(delay);
	}
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

test.serial('add a package via config-interactive', async t => {
	await using handle = await createTemporaryConfigDir();

	const proc = execa('node', [ cliPath, 'config-interactive' ], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		reject: false,
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: handle.configDir,
		},
	});

	await sendKeys(proc, [
		keys.enter, // Select "packages"
		keys.enter, // Select "Add value"
		'vim\r', // Type value and confirm
		keys.down, // Skip "Project" → "Global"
		keys.enter, // Select "Global" placement
	]);

	const result = await proc;
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'vim' ]);
});

test.serial('set a boolean via config-interactive', async t => {
	await using handle = await createTemporaryConfigDir();

	// Pre-create the config dir so getMergedConfig finds it
	await mkdir(path.join(handle.configDir, 'claudex'), { recursive: true });

	const proc = execa('node', [ cliPath, 'config-interactive' ], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
		reject: false,
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: handle.configDir,
		},
	});

	// Menu order: packages(0), volumes(1), env(2), ssh(3), hostPorts(4),
	// extraHosts(5), shareVolumes(6)
	await sendKeys(proc, [
		keys.down,
		keys.down,
		keys.down,
		keys.down,
		keys.down,
		keys.down,
		keys.enter, // Select "shareVolumes"
		keys.enter, // Select "Set to true"
		keys.down, // Skip "Project" → "Global"
		keys.enter, // Select "Global" placement
	]);

	const result = await proc;
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { shareVolumes: boolean }).shareVolumes, true);
});
