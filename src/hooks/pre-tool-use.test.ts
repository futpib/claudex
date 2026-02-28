import {
	mkdir, mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import test from 'ava';

const hookPath = path.join(import.meta.dirname, '../../build/hooks/pre-tool-use.js');

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

async function runHook(input: Record<string, unknown>, cwd?: string, env?: Record<string, string>): Promise<HookResult> {
	const result = await execa('node', [ hookPath ], {
		input: JSON.stringify(input),
		cwd,
		reject: false,
		// eslint-disable-next-line n/prefer-global/process
		env: { ...process.env, ...env },
	});
	return {
		exitCode: result.exitCode ?? 0,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

function createBashToolInput(command: string, options: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'Bash',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			command,
			...options,
		},
	};
}

async function createTemporaryGitRepo() {
	const dir = await mkdtemp(path.join(tmpdir(), 'claudex-test-'));
	await execa('git', [ 'init' ], { cwd: dir });
	await execa('git', [ 'config', 'user.email', 'test@test.com' ], { cwd: dir });
	await execa('git', [ 'config', 'user.name', 'Test' ], { cwd: dir });
	await writeFile(path.join(dir, 'README.md'), '# Test');
	await execa('git', [ 'add', '.' ], { cwd: dir });
	await execa('git', [ 'commit', '-m', 'Initial commit' ], { cwd: dir });
	return {
		dir,
		async [Symbol.asyncDispose]() {
			await rm(dir, { recursive: true });
		},
	};
}

test('rejects git checkout -b with redundant start-point on detached HEAD', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banGitCheckoutRedundantStartPoint: true });

	// Create a branch to use as start-point
	await execa('git', [ 'branch', 'feature-branch' ], { cwd: repo.dir });

	// Detach HEAD at feature-branch
	await execa('git', [ 'checkout', '--detach', 'feature-branch' ], { cwd: repo.dir });

	const result = await runHook(
		createBashToolInput('git checkout -b new-branch feature-branch'),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Unnecessary start-point'));
	t.true(result.stderr.includes('git checkout -b <branch-name>'));
});

test('allows git checkout -b with start-point on detached HEAD at different point', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banGitCheckoutRedundantStartPoint: true });

	// Create two branches
	await execa('git', [ 'branch', 'branch-a' ], { cwd: repo.dir });
	await writeFile(path.join(repo.dir, 'file.txt'), 'content');
	await execa('git', [ 'add', '.' ], { cwd: repo.dir });
	await execa('git', [ 'commit', '-m', 'Second commit' ], { cwd: repo.dir });
	await execa('git', [ 'branch', 'branch-b' ], { cwd: repo.dir });

	// Detach HEAD at branch-a
	await execa('git', [ 'checkout', '--detach', 'branch-a' ], { cwd: repo.dir });

	// Try to create branch from branch-b (different point)
	const result = await runHook(
		createBashToolInput('git checkout -b new-branch branch-b'),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

test('allows git checkout -b without start-point', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banGitCheckoutRedundantStartPoint: true });

	const result = await runHook(
		createBashToolInput('git checkout -b new-branch'),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

test('allows git checkout -b with start-point when on regular branch', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banGitCheckoutRedundantStartPoint: true });

	const result = await runHook(
		createBashToolInput('git checkout -b new-branch master'),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

test('rejects git -C flag', async t => {
	await using config = await createHooksConfig({ banGitC: true });

	const result = await runHook(
		createBashToolInput('git -C /some/path status'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('git -C is not allowed'));
});

test('rejects git -C to cwd with "not needed" message', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banGitC: true });

	const result = await runHook(
		createBashToolInput(`git -C ${repo.dir} status`),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('not needed'));
	t.true(result.stderr.includes('already the current working directory'));
});

test('rejects cargo --manifest-path flag', async t => {
	await using config = await createHooksConfig({ banCargoManifestPath: true });

	const result = await runHook(
		createBashToolInput('cargo build --manifest-path /some/path/Cargo.toml'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('cargo --manifest-path is not allowed'));
});

test('rejects yarn --cwd flag', async t => {
	await using config = await createHooksConfig({ banYarnCwd: true });

	const result = await runHook(
		createBashToolInput('yarn --cwd /some/path install'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('yarn --cwd is not allowed'));
});

test('rejects git add -A', async t => {
	await using config = await createHooksConfig({ banGitAddAll: true });

	const result = await runHook(
		createBashToolInput('git add -A'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('git add -A'));
});

test('rejects git add --all', async t => {
	await using config = await createHooksConfig({ banGitAddAll: true });

	const result = await runHook(
		createBashToolInput('git add --all'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('git add -A'));
});

test('rejects git commit --amend', async t => {
	await using config = await createHooksConfig({ banGitCommitAmend: true });

	const result = await runHook(
		createBashToolInput('git commit --amend -m "message"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('--amend is not allowed'));
});

test('rejects git commit --no-verify', async t => {
	await using config = await createHooksConfig({ banGitCommitNoVerify: true });

	const result = await runHook(
		createBashToolInput('git commit --no-verify -m "message"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('--no-verify is not allowed'));
});

test('rejects run_in_background', async t => {
	await using config = await createHooksConfig({ banBackgroundBash: true });

	const result = await runHook(
		// eslint-disable-next-line @typescript-eslint/naming-convention
		createBashToolInput('sleep 10', { run_in_background: true }),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('background'));
});

test('rejects chained commands with &&', async t => {
	await using config = await createHooksConfig({ banCommandChaining: true });

	const result = await runHook(
		createBashToolInput('npm install && npm test'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Chaining'));
});

test('rejects chained commands with ||', async t => {
	await using config = await createHooksConfig({ banCommandChaining: true });

	const result = await runHook(
		createBashToolInput('npm test || echo "failed"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Chaining'));
});

test('rejects chained commands with ;', async t => {
	await using config = await createHooksConfig({ banCommandChaining: true });

	const result = await runHook(
		createBashToolInput('cd /tmp; ls'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Chaining'));
});

test('rejects cd to cwd with "not needed" message', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banCommandChaining: true });

	const result = await runHook(
		createBashToolInput(`cd ${repo.dir} && git status`),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('not needed'));
	t.true(result.stderr.includes('already the current working directory'));
});

test('rejects cat command', async t => {
	await using config = await createHooksConfig({ banFileOperationCommands: true });

	const result = await runHook(
		createBashToolInput('cat file.txt'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('cat'));
});

test('rejects sed command', async t => {
	await using config = await createHooksConfig({ banFileOperationCommands: true });

	const result = await runHook(
		createBashToolInput('sed -i "s/foo/bar/" file.txt'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('sed'));
});

test('rejects head command', async t => {
	await using config = await createHooksConfig({ banFileOperationCommands: true });

	const result = await runHook(
		createBashToolInput('head -n 10 file.txt'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('head'));
});

test('rejects tail command', async t => {
	await using config = await createHooksConfig({ banFileOperationCommands: true });

	const result = await runHook(
		createBashToolInput('tail -f log.txt'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('tail'));
});

test('rejects awk command', async t => {
	await using config = await createHooksConfig({ banFileOperationCommands: true });

	const result = await runHook(
		createBashToolInput('awk \'{print $1}\' file.txt'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('awk'));
});

test('allows cat with heredoc', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banFileOperationCommands: true });

	const result = await runHook(
		createBashToolInput(`git commit -m "$(cat <<'EOF'
Test message
EOF
)"`),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	// Should not be rejected for cat usage (may fail for other reasons like nothing to commit)
	t.false(result.stderr.includes('cat, sed, head, tail, awk'));
});

test('allows tail with negative line offset and filename', async t => {
	await using config = await createHooksConfig({ banFileOperationCommands: true });

	const result = await runHook(
		createBashToolInput('tail -100 /var/log/syslog'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.not(result.exitCode, 2);
	t.false(result.stderr.includes('tail'));
});

test('rejects tail with extra flags', async t => {
	await using config = await createHooksConfig({ banFileOperationCommands: true });

	const result = await runHook(
		createBashToolInput('tail -f -100 log.txt'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('tail'));
});

test('allows Grep tool', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'Grep',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			pattern: 'test',
			path: '/tmp',
		},
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 0);
});

test('allows git status', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banGitC: true });

	const result = await runHook(
		createBashToolInput('git status'),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);
	t.is(result.exitCode, 0);
});

test('allows git add .', async t => {
	await using repo = await createTemporaryGitRepo();
	await using config = await createHooksConfig({ banGitAddAll: true });

	const result = await runHook(
		createBashToolInput('git add .'),
		repo.dir,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);
	t.is(result.exitCode, 0);
});

test('rejects WebSearch with 2024', async t => {
	await using config = await createHooksConfig({ banOutdatedYearInSearch: true });

	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'WebSearch',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			query: 'react documentation 2024',
		},
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('2024'));
});

test('rejects WebSearch with any outdated year', async t => {
	await using config = await createHooksConfig({ banOutdatedYearInSearch: true });

	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'WebSearch',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			query: 'python tutorial 2023',
		},
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('2023'));
});

test('allows WebSearch with current year', async t => {
	await using config = await createHooksConfig({ banOutdatedYearInSearch: true });

	const currentYear = new Date().getFullYear();
	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'WebSearch',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			query: `react documentation ${currentYear}`,
		},
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 0);
});

test('allows WebSearch with old non-recent year', async t => {
	await using config = await createHooksConfig({ banOutdatedYearInSearch: true });

	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'WebSearch',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			query: 'history of computing 1995',
		},
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 0);
});

test('allows git commit --amend when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('git commit --amend -m "message"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);
	t.is(result.exitCode, 0);
});

test('allows git commit --no-verify when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('git commit --no-verify -m "message"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);
	t.is(result.exitCode, 0);
});

test('allows cat command when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('cat file.txt'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);
	t.is(result.exitCode, 0);
});

test('allows chained commands when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('npm install && npm test'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);
	t.is(result.exitCode, 0);
});

test('enables all checks with hooks: true', async t => {
	const configDir = await mkdtemp(path.join(tmpdir(), 'claudex-hook-test-'));
	const claudexDir = path.join(configDir, 'claudex');
	await mkdir(claudexDir, { recursive: true });
	await writeFile(
		path.join(claudexDir, 'config.json'),
		JSON.stringify({ hooks: true }),
	);
	try {
		const result = await runHook(
			createBashToolInput('git commit --amend -m "message"'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);
		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('--amend is not allowed'));
	} finally {
		await rm(configDir, { recursive: true });
	}
});

test('rejects piping to grep', async t => {
	await using config = await createHooksConfig({ banPipeToFilter: true });

	const result = await runHook(
		createBashToolInput('ls | grep foo'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Piping output to'));
});

test('allows piping to grep when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('ls | grep foo'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

test('accepts TaskCreate tool', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'TaskCreate',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			subject: 'Test task',
			description: 'Test description',
			activeForm: 'Creating test task',
		},
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 0);
});

test('accepts TaskCreate tool with logToolUse enabled', async t => {
	await using config = await createHooksConfig({ logToolUse: true });

	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'TaskCreate',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			subject: 'Test task',
			description: 'Test description',
			activeForm: 'Creating test task',
		},
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 0);
});

test('accepts TaskUpdate tool', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'TaskUpdate',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			taskId: '1',
			status: 'in_progress',
		},
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 0);
});

test('rejects find -exec grep', async t => {
	await using config = await createHooksConfig({ banFindExec: true });

	const result = await runHook(
		createBashToolInput(String.raw`find /home -name "*.h" -exec grep -l "json" {} \;`),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('find -exec grep'));
	t.true(result.stderr.includes('rg'));
});

test('rejects find -exec with non-grep command', async t => {
	await using config = await createHooksConfig({ banFindExec: true });

	const result = await runHook(
		createBashToolInput(String.raw`find . -name "*.tmp" -exec rm {} \;`),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('find -exec is not allowed'));
});

test('rejects find -execdir', async t => {
	await using config = await createHooksConfig({ banFindExec: true });

	const result = await runHook(
		createBashToolInput(String.raw`find . -name "*.log" -execdir gzip {} \;`),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('find -exec is not allowed'));
});

test('allows find without -exec', async t => {
	await using config = await createHooksConfig({ banFindExec: true });

	const result = await runHook(
		createBashToolInput('find . -name "*.txt"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.not(result.exitCode, 2);
});

test('allows find -exec when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput(String.raw`find . -name "*.tmp" -exec rm {} \;`),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

// --- ban-find-command ---

test('rejects find with -name only', async t => {
	await using config = await createHooksConfig({ banFindCommand: true });

	const result = await runHook(
		createBashToolInput('find src/ -name "*.ts"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Glob'));
});

test('allows find with -type flag', async t => {
	await using config = await createHooksConfig({ banFindCommand: true });

	const result = await runHook(
		createBashToolInput('find ~/.venv -type d -name "ib_async"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.not(result.exitCode, 2);
});

test('allows find with -delete flag', async t => {
	await using config = await createHooksConfig({ banFindCommand: true });

	const result = await runHook(
		createBashToolInput('find /tmp -name "*.tmp" -delete'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.not(result.exitCode, 2);
});

test('allows find when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('find src/ -name "*.ts"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

// --- ban-find-delete ---

test('rejects find -delete', async t => {
	await using config = await createHooksConfig({ banFindDelete: true });

	const result = await runHook(
		createBashToolInput('find /tmp -name "*.tmp" -delete'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('find -delete'));
});

test('allows find without -delete', async t => {
	await using config = await createHooksConfig({ banFindDelete: true });

	const result = await runHook(
		createBashToolInput('find src/ -name "*.ts"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.not(result.exitCode, 2);
});

test('allows find -delete when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('find /tmp -name "*.tmp" -delete'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

// --- ban-ls-command ---

test('rejects plain ls', async t => {
	await using config = await createHooksConfig({ banLsCommand: true });

	const result = await runHook(
		createBashToolInput('ls'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Glob'));
});

test('rejects ls with path only', async t => {
	await using config = await createHooksConfig({ banLsCommand: true });

	const result = await runHook(
		createBashToolInput('ls src/'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Glob'));
});

test('allows ls with -la flags', async t => {
	await using config = await createHooksConfig({ banLsCommand: true });

	const result = await runHook(
		createBashToolInput('ls -la ~/.venv/lib/'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.not(result.exitCode, 2);
});

test('allows ls when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('ls src/'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

// --- ban-grep-command ---

test('rejects grep command', async t => {
	await using config = await createHooksConfig({ banGrepCommand: true });

	const result = await runHook(
		createBashToolInput('grep -r "TODO" src/'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('grep'));
});

test('rejects rg command', async t => {
	await using config = await createHooksConfig({ banGrepCommand: true });

	const result = await runHook(
		createBashToolInput('rg "pattern" --type ts'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('rg'));
});

test('allows grep with unsupported flags like -v', async t => {
	await using config = await createHooksConfig({ banGrepCommand: true });

	const result = await runHook(
		createBashToolInput('grep -v "pattern" file.txt'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.not(result.exitCode, 2);
});

test('allows rg with unsupported flags like --replace', async t => {
	await using config = await createHooksConfig({ banGrepCommand: true });

	const result = await runHook(
		createBashToolInput('rg "foo" --replace "bar"'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.not(result.exitCode, 2);
});

test('allows grep when hooks not configured', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook(
		createBashToolInput('grep -r "TODO" src/'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

// --- prefer-local-github-repo ---

function createWebFetchToolInput(url: string): Record<string, unknown> {
	return {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'WebFetch',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: {
			url,
			prompt: 'read the file',
		},
	};
}

test('blocks WebFetch to raw.githubusercontent.com when sibling repo with .git exists', async t => {
	const parentDir = await mkdtemp(path.join(tmpdir(), 'claudex-test-'));
	const projectDir = path.join(parentDir, 'my-project');
	const siblingDir = path.join(parentDir, 'iroh-ssh-android');
	await mkdir(projectDir, { recursive: true });
	await mkdir(path.join(siblingDir, '.git'), { recursive: true });
	await using config = await createHooksConfig({ preferLocalGithubRepo: true });

	try {
		const result = await runHook(
			createWebFetchToolInput('https://raw.githubusercontent.com/futpib/iroh-ssh-android/master/README.md'),
			projectDir,
			{
				// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: config.configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('iroh-ssh-android'));
		t.true(result.stderr.includes('cloned locally'));
	} finally {
		await rm(parentDir, { recursive: true });
	}
});

test('blocks WebFetch to github.com blob URL when sibling repo with .git exists', async t => {
	const parentDir = await mkdtemp(path.join(tmpdir(), 'claudex-test-'));
	const projectDir = path.join(parentDir, 'my-project');
	const siblingDir = path.join(parentDir, 'iroh-ssh-android');
	await mkdir(projectDir, { recursive: true });
	await mkdir(path.join(siblingDir, '.git'), { recursive: true });
	await using config = await createHooksConfig({ preferLocalGithubRepo: true });

	try {
		const result = await runHook(
			createWebFetchToolInput('https://github.com/futpib/iroh-ssh-android/blob/master/README.md'),
			projectDir,
			{
				// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: config.configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('iroh-ssh-android'));
		t.true(result.stderr.includes('cloned locally'));
	} finally {
		await rm(parentDir, { recursive: true });
	}
});

test('allows WebFetch when sibling dir does not exist', async t => {
	const parentDir = await mkdtemp(path.join(tmpdir(), 'claudex-test-'));
	const projectDir = path.join(parentDir, 'my-project');
	await mkdir(projectDir, { recursive: true });
	await using config = await createHooksConfig({ preferLocalGithubRepo: true });

	try {
		const result = await runHook(
			createWebFetchToolInput('https://raw.githubusercontent.com/futpib/iroh-ssh-android/master/README.md'),
			projectDir,
			{
				// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: config.configDir,
			},
		);

		t.is(result.exitCode, 0);
	} finally {
		await rm(parentDir, { recursive: true });
	}
});

test('allows WebFetch when sibling dir exists but has no .git', async t => {
	const parentDir = await mkdtemp(path.join(tmpdir(), 'claudex-test-'));
	const projectDir = path.join(parentDir, 'my-project');
	const siblingDir = path.join(parentDir, 'iroh-ssh-android');
	await mkdir(projectDir, { recursive: true });
	await mkdir(siblingDir, { recursive: true });
	await using config = await createHooksConfig({ preferLocalGithubRepo: true });

	try {
		const result = await runHook(
			createWebFetchToolInput('https://raw.githubusercontent.com/futpib/iroh-ssh-android/master/README.md'),
			projectDir,
			{
				// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: config.configDir,
			},
		);

		t.is(result.exitCode, 0);
	} finally {
		await rm(parentDir, { recursive: true });
	}
});

test('allows WebFetch to non-GitHub URLs', async t => {
	await using config = await createHooksConfig({ preferLocalGithubRepo: true });

	const result = await runHook(
		createWebFetchToolInput('https://docs.rs/iroh/latest/iroh/'),
		undefined,
		{
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: config.configDir,
		},
	);

	t.is(result.exitCode, 0);
});

test('accepts unknown tool names not in any schema', async t => {
	await using config = await createHooksConfig({});

	const result = await runHook({
		// eslint-disable-next-line @typescript-eslint/naming-convention
		session_id: 'test-session',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		transcript_path: '/tmp/test-transcript',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_name: 'SomeNewUnknownTool',
		// eslint-disable-next-line @typescript-eslint/naming-convention
		tool_input: { foo: 'bar' },
	}, undefined, {
		// eslint-disable-next-line @typescript-eslint/naming-convention
		XDG_CONFIG_HOME: config.configDir,
	});

	t.is(result.exitCode, 0);
});
