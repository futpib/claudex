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

type HooksConfigEnv = {
	configDir: string;
	cleanup: () => Promise<void>;
};

async function createHooksConfig(hooks: Record<string, boolean>): Promise<HooksConfigEnv> {
	const configDir = await mkdtemp(path.join(tmpdir(), 'claudex-hook-test-'));
	const claudexDir = path.join(configDir, 'claudex');
	await mkdir(claudexDir, { recursive: true });
	await writeFile(
		path.join(claudexDir, 'config.json'),
		JSON.stringify({ hooks }),
	);
	return { configDir, cleanup: async () => rm(configDir, { recursive: true }) };
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

async function createTemporaryGitRepo(): Promise<string> {
	const temporaryDir = await mkdtemp(path.join(tmpdir(), 'claudex-test-'));
	await execa('git', [ 'init' ], { cwd: temporaryDir });
	await execa('git', [ 'config', 'user.email', 'test@test.com' ], { cwd: temporaryDir });
	await execa('git', [ 'config', 'user.name', 'Test' ], { cwd: temporaryDir });
	await writeFile(path.join(temporaryDir, 'README.md'), '# Test');
	await execa('git', [ 'add', '.' ], { cwd: temporaryDir });
	await execa('git', [ 'commit', '-m', 'Initial commit' ], { cwd: temporaryDir });
	return temporaryDir;
}

test('rejects git checkout -b with redundant start-point on detached HEAD', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banGitCheckoutRedundantStartPoint: true });
	try {
		// Create a branch to use as start-point
		await execa('git', [ 'branch', 'feature-branch' ], { cwd: temporaryDir });

		// Detach HEAD at feature-branch
		await execa('git', [ 'checkout', '--detach', 'feature-branch' ], { cwd: temporaryDir });

		const result = await runHook(
			createBashToolInput('git checkout -b new-branch feature-branch'),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('Unnecessary start-point'));
		t.true(result.stderr.includes('git checkout -b <branch-name>'));
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('allows git checkout -b with start-point on detached HEAD at different point', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banGitCheckoutRedundantStartPoint: true });
	try {
		// Create two branches
		await execa('git', [ 'branch', 'branch-a' ], { cwd: temporaryDir });
		await writeFile(path.join(temporaryDir, 'file.txt'), 'content');
		await execa('git', [ 'add', '.' ], { cwd: temporaryDir });
		await execa('git', [ 'commit', '-m', 'Second commit' ], { cwd: temporaryDir });
		await execa('git', [ 'branch', 'branch-b' ], { cwd: temporaryDir });

		// Detach HEAD at branch-a
		await execa('git', [ 'checkout', '--detach', 'branch-a' ], { cwd: temporaryDir });

		// Try to create branch from branch-b (different point)
		const result = await runHook(
			createBashToolInput('git checkout -b new-branch branch-b'),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('allows git checkout -b without start-point', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banGitCheckoutRedundantStartPoint: true });
	try {
		const result = await runHook(
			createBashToolInput('git checkout -b new-branch'),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('allows git checkout -b with start-point when on regular branch', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banGitCheckoutRedundantStartPoint: true });
	try {
		const result = await runHook(
			createBashToolInput('git checkout -b new-branch master'),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('rejects git -C flag', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banGitC: true });
	try {
		const result = await runHook(
			createBashToolInput('git -C /some/path status'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('git -C is not allowed'));
	} finally {
		await cleanup();
	}
});

test('rejects git -C to cwd with "not needed" message', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banGitC: true });
	try {
		const result = await runHook(
			createBashToolInput(`git -C ${temporaryDir} status`),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('not needed'));
		t.true(result.stderr.includes('already the current working directory'));
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('rejects cargo --manifest-path flag', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banCargoManifestPath: true });
	try {
		const result = await runHook(
			createBashToolInput('cargo build --manifest-path /some/path/Cargo.toml'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('cargo --manifest-path is not allowed'));
	} finally {
		await cleanup();
	}
});

test('rejects git add -A', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banGitAddAll: true });
	try {
		const result = await runHook(
			createBashToolInput('git add -A'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('git add -A'));
	} finally {
		await cleanup();
	}
});

test('rejects git add --all', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banGitAddAll: true });
	try {
		const result = await runHook(
			createBashToolInput('git add --all'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('git add -A'));
	} finally {
		await cleanup();
	}
});

test('rejects git commit --amend', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banGitCommitAmend: true });
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
		await cleanup();
	}
});

test('rejects git commit --no-verify', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banGitCommitNoVerify: true });
	try {
		const result = await runHook(
			createBashToolInput('git commit --no-verify -m "message"'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('--no-verify is not allowed'));
	} finally {
		await cleanup();
	}
});

test('rejects run_in_background', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banBackgroundBash: true });
	try {
		const result = await runHook(
			// eslint-disable-next-line @typescript-eslint/naming-convention
			createBashToolInput('sleep 10', { run_in_background: true }),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('background'));
	} finally {
		await cleanup();
	}
});

test('rejects chained commands with &&', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banCommandChaining: true });
	try {
		const result = await runHook(
			createBashToolInput('npm install && npm test'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('Chaining'));
	} finally {
		await cleanup();
	}
});

test('rejects chained commands with ||', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banCommandChaining: true });
	try {
		const result = await runHook(
			createBashToolInput('npm test || echo "failed"'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('Chaining'));
	} finally {
		await cleanup();
	}
});

test('rejects chained commands with ;', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banCommandChaining: true });
	try {
		const result = await runHook(
			createBashToolInput('cd /tmp; ls'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('Chaining'));
	} finally {
		await cleanup();
	}
});

test('rejects cd to cwd with "not needed" message', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banCommandChaining: true });
	try {
		const result = await runHook(
			createBashToolInput(`cd ${temporaryDir} && git status`),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('not needed'));
		t.true(result.stderr.includes('already the current working directory'));
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('rejects cat command', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFileOperationCommands: true });
	try {
		const result = await runHook(
			createBashToolInput('cat file.txt'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('cat'));
	} finally {
		await cleanup();
	}
});

test('rejects sed command', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFileOperationCommands: true });
	try {
		const result = await runHook(
			createBashToolInput('sed -i "s/foo/bar/" file.txt'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('sed'));
	} finally {
		await cleanup();
	}
});

test('rejects head command', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFileOperationCommands: true });
	try {
		const result = await runHook(
			createBashToolInput('head -n 10 file.txt'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('head'));
	} finally {
		await cleanup();
	}
});

test('rejects tail command', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFileOperationCommands: true });
	try {
		const result = await runHook(
			createBashToolInput('tail -f log.txt'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('tail'));
	} finally {
		await cleanup();
	}
});

test('rejects awk command', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFileOperationCommands: true });
	try {
		const result = await runHook(
			createBashToolInput('awk \'{print $1}\' file.txt'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('awk'));
	} finally {
		await cleanup();
	}
});

test('allows cat with heredoc', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banFileOperationCommands: true });
	try {
		const result = await runHook(
			createBashToolInput(`git commit -m "$(cat <<'EOF'
Test message
EOF
)"`),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		// Should not be rejected for cat usage (may fail for other reasons like nothing to commit)
		t.false(result.stderr.includes('cat, sed, head, tail, awk'));
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('allows tail with negative line offset and filename', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFileOperationCommands: true });
	try {
		const result = await runHook(
			createBashToolInput('tail -100 /var/log/syslog'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.not(result.exitCode, 2);
		t.false(result.stderr.includes('tail'));
	} finally {
		await cleanup();
	}
});

test('rejects tail with extra flags', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFileOperationCommands: true });
	try {
		const result = await runHook(
			createBashToolInput('tail -f -100 log.txt'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('tail'));
	} finally {
		await cleanup();
	}
});

test('allows Grep tool', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('allows git status', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banGitC: true });
	try {
		const result = await runHook(
			createBashToolInput('git status'),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);
		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('allows git add .', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	const { configDir, cleanup } = await createHooksConfig({ banGitAddAll: true });
	try {
		const result = await runHook(
			createBashToolInput('git add .'),
			temporaryDir,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);
		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
		await cleanup();
	}
});

test('rejects WebSearch with 2024', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banOutdatedYearInSearch: true });
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('2024'));
	} finally {
		await cleanup();
	}
});

test('rejects WebSearch with any outdated year', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banOutdatedYearInSearch: true });
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('2023'));
	} finally {
		await cleanup();
	}
});

test('allows WebSearch with current year', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banOutdatedYearInSearch: true });
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('allows WebSearch with old non-recent year', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banOutdatedYearInSearch: true });
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('allows git commit --amend when hooks not configured', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
		const result = await runHook(
			createBashToolInput('git commit --amend -m "message"'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);
		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('allows git commit --no-verify when hooks not configured', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
		const result = await runHook(
			createBashToolInput('git commit --no-verify -m "message"'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);
		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('allows cat command when hooks not configured', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
		const result = await runHook(
			createBashToolInput('cat file.txt'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);
		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('allows chained commands when hooks not configured', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
		const result = await runHook(
			createBashToolInput('npm install && npm test'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);
		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
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
	const { configDir, cleanup } = await createHooksConfig({ banPipeToFilter: true });
	try {
		const result = await runHook(
			createBashToolInput('ls | grep foo'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('Piping output to'));
	} finally {
		await cleanup();
	}
});

test('allows piping to grep when hooks not configured', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
		const result = await runHook(
			createBashToolInput('ls | grep foo'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('accepts TaskCreate tool', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('accepts TaskCreate tool with logToolUse enabled', async t => {
	const { configDir, cleanup } = await createHooksConfig({ logToolUse: true });
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('accepts TaskUpdate tool', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('rejects find -exec grep', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFindExec: true });
	try {
		const result = await runHook(
			createBashToolInput(String.raw`find /home -name "*.h" -exec grep -l "json" {} \;`),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('find -exec grep'));
		t.true(result.stderr.includes('rg'));
	} finally {
		await cleanup();
	}
});

test('rejects find -exec with non-grep command', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFindExec: true });
	try {
		const result = await runHook(
			createBashToolInput(String.raw`find . -name "*.tmp" -exec rm {} \;`),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('find -exec is not allowed'));
	} finally {
		await cleanup();
	}
});

test('rejects find -execdir', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFindExec: true });
	try {
		const result = await runHook(
			createBashToolInput(String.raw`find . -name "*.log" -execdir gzip {} \;`),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('find -exec is not allowed'));
	} finally {
		await cleanup();
	}
});

test('allows find without -exec', async t => {
	const { configDir, cleanup } = await createHooksConfig({ banFindExec: true });
	try {
		const result = await runHook(
			createBashToolInput('find . -name "*.txt"'),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.not(result.exitCode, 2);
	} finally {
		await cleanup();
	}
});

test('allows find -exec when hooks not configured', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
		const result = await runHook(
			createBashToolInput(String.raw`find . -name "*.tmp" -exec rm {} \;`),
			undefined,
			{
			// eslint-disable-next-line @typescript-eslint/naming-convention
				XDG_CONFIG_HOME: configDir,
			},
		);

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('accepts unknown tool names not in any schema', async t => {
	const { configDir, cleanup } = await createHooksConfig({});
	try {
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
			XDG_CONFIG_HOME: configDir,
		});

		t.is(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

