import {
	mkdtemp, rm, writeFile, mkdir, readFile, access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import test from 'ava';
import { execa } from 'execa';

// Resolves to build/resume.js after ava-typescript rewrites src/ → build/.
// We import copyResumeSessionIfElsewhere from a child process so we can
// override HOME (controls ~/.claude) and XDG_CONFIG_HOME (controls
// paths.config and therefore <root>/claudex/accounts/...). Both are captured
// at module load time inside Node, so they cannot be overridden in-process.
const builtResumeUrl = pathToFileURL(path.join(import.meta.dirname, 'resume.js')).href;
const builtRegistryUrl = pathToFileURL(path.join(import.meta.dirname, 'launchers/registry.js')).href;

const SESSION_ID = '0a7589e7-332b-4d15-84fe-1d1e32ddc3f6';
const OTHER_ID = '11111111-2222-3333-4444-555555555555';

async function createTemporaryDir(prefix: string) {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	return {
		dir,
		async [Symbol.asyncDispose]() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

type Env = {
	home: string;
	configHome: string;
};

function defaultClaudeProjectsDir(env: Env): string {
	return path.join(env.home, '.claude', 'projects');
}

function namedAccountProjectsDir(env: Env, account: string): string {
	return path.join(env.configHome, 'claudex', 'accounts', account, 'claude', 'projects');
}

async function createTranscript(projectsDir: string, projectKey: string, sessionId: string, body: string): Promise<string> {
	const dir = path.join(projectsDir, projectKey);
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, `${sessionId}.jsonl`);
	await writeFile(file, body);
	return file;
}

type ProbeResult = {
	exitCode: number;
	stderr: string;
};

async function runCopyProbe(env: Env, cwd: string, account: string | undefined): Promise<ProbeResult> {
	const accountLiteral = account === undefined ? 'undefined' : JSON.stringify(account);
	const probe = `
		import { copyResumeSessionIfElsewhere } from ${JSON.stringify(builtResumeUrl)};
		import { launcherRegistry } from ${JSON.stringify(builtRegistryUrl)};
		await copyResumeSessionIfElsewhere(
			${JSON.stringify([ '--resume', SESSION_ID ])},
			${JSON.stringify(cwd)},
			launcherRegistry.claude,
			${accountLiteral},
		);
	`;
	const result = await execa('node', [ '--input-type=module', '-e', probe ], {
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			HOME: env.home,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: env.configHome,
		},
		reject: false,
	});
	return {
		exitCode: typeof result.exitCode === 'number' ? result.exitCode : -1,
		stderr: String(result.stderr ?? ''),
	};
}

async function withFreshEnv<T>(callback: (env: Env) => Promise<T>): Promise<T> {
	await using homeHandle = await createTemporaryDir('claudex-resume-home-');
	await using configHandle = await createTemporaryDir('claudex-resume-cfg-');
	return await callback({ home: homeHandle.dir, configHome: configHandle.dir });
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

test('copyResumeSessionIfElsewhere copies a session from a named account into the default account project dir', async t => {
	await withFreshEnv(async env => {
		const cwd = '/home/claude/archive';
		const sourceFile = await createTranscript(
			namedAccountProjectsDir(env, 'vm-10.60.10.58'),
			'-home-claude-archive',
			SESSION_ID,
			'{"type":"user","msg":"from-named"}\n',
		);

		const probe = await runCopyProbe(env, cwd, undefined);
		t.is(probe.exitCode, 0, probe.stderr);

		const target = path.join(defaultClaudeProjectsDir(env), '-home-claude-archive', `${SESSION_ID}.jsonl`);
		t.true(await fileExists(target), 'expected session to be copied into default account');
		t.is(await readFile(target, 'utf8'), await readFile(sourceFile, 'utf8'));
		t.regex(probe.stderr, /Copied session 0a7589e7/);
	});
});

test('copyResumeSessionIfElsewhere copies from default account into a named account project dir', async t => {
	await withFreshEnv(async env => {
		const cwd = '/srv/work/foo';
		await createTranscript(
			defaultClaudeProjectsDir(env),
			'-home-original-spot',
			SESSION_ID,
			'{"type":"user","msg":"from-default"}\n',
		);

		const probe = await runCopyProbe(env, cwd, 'work');
		t.is(probe.exitCode, 0, probe.stderr);

		const target = path.join(namedAccountProjectsDir(env, 'work'), '-srv-work-foo', `${SESSION_ID}.jsonl`);
		t.true(await fileExists(target));
	});
});

test('copyResumeSessionIfElsewhere refuses to copy when the same session id appears in multiple accounts', async t => {
	await withFreshEnv(async env => {
		const cwd = '/home/claude/archive';
		await createTranscript(
			namedAccountProjectsDir(env, 'acct-a'),
			'-home-claude-archive',
			SESSION_ID,
			'{"src":"a"}\n',
		);
		await createTranscript(
			namedAccountProjectsDir(env, 'acct-b'),
			'-home-claude-archive',
			SESSION_ID,
			'{"src":"b"}\n',
		);

		const probe = await runCopyProbe(env, cwd, undefined);
		t.is(probe.exitCode, 0, probe.stderr);

		const target = path.join(defaultClaudeProjectsDir(env), '-home-claude-archive', `${SESSION_ID}.jsonl`);
		t.false(await fileExists(target), 'expected refusal — no copy when ambiguous');
		t.regex(probe.stderr, /multiple matching transcripts/);
	});
});

test('copyResumeSessionIfElsewhere is a no-op when target already exists', async t => {
	await withFreshEnv(async env => {
		const cwd = '/home/claude/archive';
		const targetDir = defaultClaudeProjectsDir(env);
		const targetFile = await createTranscript(targetDir, '-home-claude-archive', SESSION_ID, '{"src":"target"}\n');

		await createTranscript(
			namedAccountProjectsDir(env, 'work'),
			'-home-claude-archive',
			SESSION_ID,
			'{"src":"named"}\n',
		);

		const probe = await runCopyProbe(env, cwd, undefined);
		t.is(probe.exitCode, 0, probe.stderr);

		t.is(await readFile(targetFile, 'utf8'), '{"src":"target"}\n', 'target should be untouched');
		t.notRegex(probe.stderr, /Copied session/);
	});
});

test('copyResumeSessionIfElsewhere is silent when no matching session exists anywhere', async t => {
	await withFreshEnv(async env => {
		const cwd = '/home/claude/archive';
		await createTranscript(
			namedAccountProjectsDir(env, 'work'),
			'-home-other',
			OTHER_ID,
			'{"src":"unrelated"}\n',
		);

		const probe = await runCopyProbe(env, cwd, undefined);
		t.is(probe.exitCode, 0, probe.stderr);

		const target = path.join(defaultClaudeProjectsDir(env), '-home-claude-archive', `${SESSION_ID}.jsonl`);
		t.false(await fileExists(target));
		t.notRegex(probe.stderr, /Copied session/);
		t.notRegex(probe.stderr, /multiple matching/);
	});
});
