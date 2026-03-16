import process from 'node:process';
import path from 'node:path';
import {
	mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import test, { type ExecutionContext } from 'ava';
import { hashAction, storeConfirmation, createConfirmationToken } from '../../confirm.js';

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

function createBashToolInput(command: string, permissionMode?: string): Record<string, unknown> {
	return {
		session_id: 'test-session', // eslint-disable-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript', // eslint-disable-line @typescript-eslint/naming-convention
		permission_mode: permissionMode, // eslint-disable-line @typescript-eslint/naming-convention
		tool_name: 'Bash', // eslint-disable-line @typescript-eslint/naming-convention
		tool_input: { command }, // eslint-disable-line @typescript-eslint/naming-convention
	};
}

function env(config: { configDir: string }) {
	return { XDG_CONFIG_HOME: config.configDir }; // eslint-disable-line @typescript-eslint/naming-convention
}

function assertBlocked(t: ExecutionContext, result: HookResult, pattern?: string) {
	t.is(result.exitCode, 2);
	if (pattern) {
		t.true(result.stderr.includes(pattern), `expected stderr to include "${pattern}", got "${result.stderr}"`);
	}
}

// --- blocked mutations ---

test('blocks git commit', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git commit -m "test"'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

test('blocks git push', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git push origin main'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

test('blocks git merge', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git merge feature-branch'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

test('blocks git rebase', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git rebase main'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

test('blocks git tag', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git tag v1.0.0'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

test('blocks git stash drop', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git stash drop'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

test('blocks git branch -d', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git branch -d feature'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

test('blocks git branch -D', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git branch -D feature'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

test('blocks git reset', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git reset --hard HEAD~1'),
		env(config),
	);
	assertBlocked(t, result, 'git mutation');
});

// --- allowed read-only commands ---

test('allows git status', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git status'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows git log', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git log --oneline'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows git diff', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git diff'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows git checkout', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git checkout main'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows git fetch', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git fetch origin'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

test('allows git pull', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const result = await runHook(
		createBashToolInput('git pull'),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- after confirmation ---

test('allows git commit after confirmation', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: true });
	const command = 'git commit -m "confirmed test"';
	const actionHash = hashAction(command);
	const token = await createConfirmationToken(actionHash, 'test', '/tmp/test', 'test-session');
	await storeConfirmation(actionHash, 'test-session', token, 'user approved');

	const result = await runHook(
		createBashToolInput(command),
		env(config),
	);
	t.is(result.exitCode, 0);
});

// --- disabled rule ---

test('allows git mutations when rule is disabled', async t => {
	await using config = await createHooksConfig({ requireGitMutationConfirmation: false });
	const result = await runHook(
		createBashToolInput('git push origin main'),
		env(config),
	);
	t.is(result.exitCode, 0);
});
