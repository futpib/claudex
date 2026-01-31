import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function runHook(input: Record<string, unknown>, cwd?: string): Promise<HookResult> {
	const result = await execa('node', [ hookPath ], {
		input: JSON.stringify(input),
		cwd,
		reject: false,
	});
	return {
		exitCode: result.exitCode ?? 0,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

function createBashToolInput(command: string, options: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		session_id: 'test-session',
		transcript_path: '/tmp/test-transcript',
		tool_name: 'Bash',
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
	try {
		// Create a branch to use as start-point
		await execa('git', [ 'branch', 'feature-branch' ], { cwd: temporaryDir });

		// Detach HEAD at feature-branch
		await execa('git', [ 'checkout', '--detach', 'feature-branch' ], { cwd: temporaryDir });

		const result = await runHook(
			createBashToolInput('git checkout -b new-branch feature-branch'),
			temporaryDir,
		);

		t.is(result.exitCode, 2);
		t.true(result.stderr.includes('Unnecessary start-point'));
		t.true(result.stderr.includes('git checkout -b <branch-name>'));
	} finally {
		await rm(temporaryDir, { recursive: true });
	}
});

test('allows git checkout -b with start-point on detached HEAD at different point', async t => {
	const temporaryDir = await createTemporaryGitRepo();
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
		);

		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
	}
});

test('allows git checkout -b without start-point', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	try {
		const result = await runHook(
			createBashToolInput('git checkout -b new-branch'),
			temporaryDir,
		);

		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
	}
});

test('allows git checkout -b with start-point when on regular branch', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	try {
		const result = await runHook(
			createBashToolInput('git checkout -b new-branch master'),
			temporaryDir,
		);

		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
	}
});

test('rejects git -C flag', async t => {
	const result = await runHook(createBashToolInput('git -C /some/path status'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('git -C is not allowed'));
});

test('rejects git add -A', async t => {
	const result = await runHook(createBashToolInput('git add -A'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('git add -A'));
});

test('rejects git add --all', async t => {
	const result = await runHook(createBashToolInput('git add --all'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('git add -A'));
});

test('rejects git commit --amend', async t => {
	const result = await runHook(createBashToolInput('git commit --amend -m "message"'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('--amend is not allowed'));
});

test('rejects git commit --no-verify', async t => {
	const result = await runHook(createBashToolInput('git commit --no-verify -m "message"'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('--no-verify is not allowed'));
});

test('rejects run_in_background', async t => {
	const result = await runHook(createBashToolInput('sleep 10', { run_in_background: true }));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('background'));
});

test('rejects chained commands with &&', async t => {
	const result = await runHook(createBashToolInput('npm install && npm test'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Chaining'));
});

test('rejects chained commands with ||', async t => {
	const result = await runHook(createBashToolInput('npm test || echo "failed"'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Chaining'));
});

test('rejects chained commands with ;', async t => {
	const result = await runHook(createBashToolInput('cd /tmp; ls'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('Chaining'));
});

test('rejects cat command', async t => {
	const result = await runHook(createBashToolInput('cat file.txt'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('cat'));
});

test('rejects sed command', async t => {
	const result = await runHook(createBashToolInput('sed -i "s/foo/bar/" file.txt'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('sed'));
});

test('rejects head command', async t => {
	const result = await runHook(createBashToolInput('head -n 10 file.txt'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('head'));
});

test('rejects tail command', async t => {
	const result = await runHook(createBashToolInput('tail -f log.txt'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('tail'));
});

test('rejects awk command', async t => {
	const result = await runHook(createBashToolInput('awk \'{print $1}\' file.txt'));

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('awk'));
});

test('allows cat with heredoc', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	try {
		const result = await runHook(
			createBashToolInput(`git commit -m "$(cat <<'EOF'
Test message
EOF
)"`),
			temporaryDir,
		);

		// Should not be rejected for cat usage (may fail for other reasons like nothing to commit)
		t.false(result.stderr.includes('cat, sed, head, tail, awk'));
	} finally {
		await rm(temporaryDir, { recursive: true });
	}
});

test('allows Grep tool', async t => {
	const result = await runHook({
		session_id: 'test-session',
		transcript_path: '/tmp/test-transcript',
		tool_name: 'Grep',
		tool_input: {
			pattern: 'test',
			path: '/tmp',
		},
	});

	t.is(result.exitCode, 0);
});

test('allows git status', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	try {
		const result = await runHook(createBashToolInput('git status'), temporaryDir);
		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
	}
});

test('allows git add .', async t => {
	const temporaryDir = await createTemporaryGitRepo();
	try {
		const result = await runHook(createBashToolInput('git add .'), temporaryDir);
		t.is(result.exitCode, 0);
	} finally {
		await rm(temporaryDir, { recursive: true });
	}
});

test('rejects WebSearch with 2024', async t => {
	const result = await runHook({
		session_id: 'test-session',
		transcript_path: '/tmp/test-transcript',
		tool_name: 'WebSearch',
		tool_input: {
			query: 'react documentation 2024',
		},
	});

	t.is(result.exitCode, 2);
	t.true(result.stderr.includes('2024'));
});
