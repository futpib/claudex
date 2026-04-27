import process from 'node:process';
import path from 'node:path';
import {
	mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import test, { type ExecutionContext } from 'ava';

const cliPath = path.join(import.meta.dirname, '../../../build/cli.js');

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

async function createProjectDir(lockFile: string) {
	const projectDir = await mkdtemp(path.join(tmpdir(), 'claudex-pm-project-'));
	await writeFile(path.join(projectDir, lockFile), '');
	return {
		projectDir,
		async [Symbol.asyncDispose]() {
			await rm(projectDir, { recursive: true });
		},
	};
}

async function runHook(
	command: string,
	options: { configDir: string; projectDir: string },
): Promise<HookResult> {
	const input = {
		session_id: 'test-session', // eslint-disable-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript', // eslint-disable-line @typescript-eslint/naming-convention
		tool_name: 'Bash', // eslint-disable-line @typescript-eslint/naming-convention
		tool_input: { command }, // eslint-disable-line @typescript-eslint/naming-convention
	};
	const result = await execa('node', [ cliPath, 'hook', 'pre-tool-use' ], {
		input: JSON.stringify(input),
		reject: false,
		cwd: options.projectDir,
		env: { ...process.env, XDG_CONFIG_HOME: options.configDir }, // eslint-disable-line @typescript-eslint/naming-convention
	});
	return {
		exitCode: result.exitCode ?? 0,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

function assertBlocked(t: ExecutionContext, result: HookResult, pattern?: string) {
	t.is(result.exitCode, 2);
	if (pattern) {
		t.true(result.stderr.includes(pattern), `expected stderr to include "${pattern}", got "${result.stderr}"`);
	}
}

function assertAllowed(t: ExecutionContext, result: HookResult) {
	t.is(result.exitCode, 0, `expected pass (exit 0), got ${result.exitCode} with stderr "${result.stderr}"`);
}

// --- still blocks project-local mismatched package manager ---

test('blocks npm install in a pnpm project', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('pnpm-lock.yaml');
	const result = await runHook('npm install lodash', { configDir: config.configDir, projectDir: project.projectDir });
	assertBlocked(t, result, 'Wrong package manager');
});

test('blocks yarn add in an npm project', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('package-lock.json');
	const result = await runHook('yarn add lodash', { configDir: config.configDir, projectDir: project.projectDir });
	assertBlocked(t, result, 'Wrong package manager');
});

// --- allows global invocations ---

test('allows npm install -g in a pnpm project', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('pnpm-lock.yaml');
	const result = await runHook('npm install -g @openai/codex', { configDir: config.configDir, projectDir: project.projectDir });
	assertAllowed(t, result);
});

test('allows npm i -g in a yarn project', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('yarn.lock');
	const result = await runHook('npm i -g typescript', { configDir: config.configDir, projectDir: project.projectDir });
	assertAllowed(t, result);
});

test('allows npm install --global in a pnpm project', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('pnpm-lock.yaml');
	const result = await runHook('npm install --global typescript', { configDir: config.configDir, projectDir: project.projectDir });
	assertAllowed(t, result);
});

test('allows npm install --location=global in a pnpm project', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('pnpm-lock.yaml');
	const result = await runHook('npm install --location=global typescript', { configDir: config.configDir, projectDir: project.projectDir });
	assertAllowed(t, result);
});

test('allows yarn global add in a pnpm project', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('pnpm-lock.yaml');
	const result = await runHook('yarn global add prettier', { configDir: config.configDir, projectDir: project.projectDir });
	assertAllowed(t, result);
});

test('allows bun add -g in a pnpm project', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('pnpm-lock.yaml');
	const result = await runHook('bun add -g typescript', { configDir: config.configDir, projectDir: project.projectDir });
	assertAllowed(t, result);
});

test('still blocks when one invocation is global and another is project-local', async t => {
	await using config = await createHooksConfig({ banWrongPackageManager: true });
	await using project = await createProjectDir('pnpm-lock.yaml');
	const result = await runHook('npm install -g foo && npm install bar', { configDir: config.configDir, projectDir: project.projectDir });
	assertBlocked(t, result, 'Wrong package manager');
});
