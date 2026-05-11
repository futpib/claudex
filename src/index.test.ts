import path from 'node:path';
import process from 'node:process';
import {
	mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'ava';
import { execa } from 'execa';
import {
	createConfirmationToken, generateShortId, hashAction, storePendingConfirmation,
} from './confirm.js';

const cliPath = path.join(import.meta.dirname, '../build/cli.js');

async function runCli(args: string[], env?: Record<string, string>) {
	const result = await execa('node', [ cliPath, ...args ], {
		cwd: process.cwd(),
		reject: false,
		env: env ? { ...process.env, ...env } : process.env,
	});
	return {
		exitCode: result.exitCode ?? 0,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

async function withTemporaryDataDir<T>(fn: (dataDir: string) => Promise<T>): Promise<T> {
	const dataDir = await mkdtemp(path.join(tmpdir(), 'claudex-confirm-test-data-'));
	const previousDataHome = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dataDir;
	try {
		return await fn(dataDir);
	} finally {
		if (previousDataHome === undefined) {
			delete process.env.XDG_DATA_HOME;
		} else {
			process.env.XDG_DATA_HOME = previousDataHome;
		}

		await rm(dataDir, { recursive: true });
	}
}

function makeAnswerEntry(toolUseId: string, sessionId: string, answer: string, contentText = 'tool result wrapper'): Record<string, unknown> {
	return {
		type: 'user',
		sessionId,
		message: {
			role: 'user',
			content: [ {
				type: 'tool_result',
				// eslint-disable-next-line @typescript-eslint/naming-convention
				tool_use_id: toolUseId,
				content: contentText,
			} ],
		},
		toolUseResult: { answers: { 'pick one': answer } },
	};
}

function makeAskEntry(toolUseId: string, sessionId: string): Record<string, unknown> {
	return {
		type: 'assistant',
		sessionId,
		message: {
			role: 'assistant',
			content: [ {
				type: 'tool_use',
				id: toolUseId,
				name: 'AskUserQuestion',
				input: {},
			} ],
		},
	};
}

test('--help exits 0 and lists all options', async t => {
	const { exitCode, stdout } = await runCli([ '--help' ]);
	t.is(exitCode, 0);
	for (const flag of [
		'--no-docker',
		'--docker-shell',
		'--docker-pull',
		'--docker-no-cache',
		'--docker-skip-build',
		'--docker-no-build',
		'--docker-sudo',
		'--allow-unsafe-directory',
		'--package',
		'--volume',
		'--env',
		'--env-file',
		'--env-mode',
		'--ssh-key',
		'--launcher',
		'--model',
	]) {
		t.true(stdout.includes(flag), `help should mention ${flag}`);
	}
});

test('--help lists config and install subcommands', async t => {
	const { stdout } = await runCli([ '--help' ]);
	t.regex(stdout, /config\b/);
	t.regex(stdout, /install\b/);
	t.regex(stdout, /uninstall\b/);
	t.regex(stdout, /exec\b/);
});

test('exec --help exits 0 and lists options', async t => {
	const { exitCode, stdout } = await runCli([ 'exec', '--help' ]);
	t.is(exitCode, 0);
	t.true(stdout.includes('--root'), 'exec help should mention --root');
	t.true(stdout.includes('container'), 'exec help should mention container argument');
});

test('install --help exits 0 and lists options', async t => {
	const { exitCode, stdout } = await runCli([ 'install', '--help' ]);
	t.is(exitCode, 0);
	t.true(stdout.includes('--no-save'), 'install help should mention --no-save');
	t.true(stdout.includes('--container'), 'install help should mention --container');
	t.true(stdout.includes('packages'), 'install help should mention packages argument');
});

test('uninstall --help exits 0 and lists options', async t => {
	const { exitCode, stdout } = await runCli([ 'uninstall', '--help' ]);
	t.is(exitCode, 0);
	t.true(stdout.includes('--no-save'), 'uninstall help should mention --no-save');
	t.true(stdout.includes('--container'), 'uninstall help should mention --container');
	t.true(stdout.includes('packages'), 'uninstall help should mention packages argument');
});

test('config --help exits 0 and lists all actions as subcommands', async t => {
	const { exitCode, stdout } = await runCli([ 'config', '--help' ]);
	t.is(exitCode, 0);
	for (const action of [ 'list', 'get', 'set', 'add', 'remove', 'unset', 'profile', 'unprofile' ]) {
		t.true(stdout.includes(action), `config help should mention ${action}`);
	}
});

for (const action of [ 'group', 'ungroup', 'profile', 'unprofile' ]) {
	test(`config ${action} shows help after missing argument error`, async t => {
		const { exitCode, stderr } = await runCli([ 'config', action ]);
		t.not(exitCode, 0);
		t.true(stderr.includes('Usage:'), `config ${action} error should include usage`);
		t.true(stderr.includes('--help'), `config ${action} error should mention --help`);
	});
}

for (const action of [ 'list', 'get', 'set', 'add', 'remove', 'unset' ]) {
	test(`config ${action} --help exits 0 and lists scope options`, async t => {
		const { exitCode, stdout } = await runCli([ 'config', action, '--help' ]);
		t.is(exitCode, 0);
		for (const flag of [ '--global', '--project', '--group', '--profile', '--file' ]) {
			t.true(stdout.includes(flag), `config ${action} help should mention ${flag}`);
		}
	});
}

test.serial('confirm accepts AskUserQuestion answer as proof', async t => {
	await withTemporaryDataDir(async () => {
		const sessionId = 'aq-confirm-session';
		const transcriptDir = await mkdtemp(path.join(tmpdir(), 'claudex-confirm-test-transcript-'));
		const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
		const toolUseId = 'toolu_aq_confirm_1';
		const entries = [
			makeAskEntry(toolUseId, sessionId),
			makeAnswerEntry(toolUseId, sessionId, 'Enable the setting via API'),
		];
		await writeFile(transcriptPath, entries.map(line => JSON.stringify(line)).join('\n') + '\n');

		try {
			const command = 'echo dummy';
			const actionHash = hashAction(command);
			const token = await createConfirmationToken(actionHash, 'test', transcriptPath, sessionId);
			const shortId = generateShortId();
			await storePendingConfirmation(shortId, token, command);

			const result = await runCli(
				[ 'confirm', shortId, 'Enable the setting via API' ],
				// eslint-disable-next-line @typescript-eslint/naming-convention
				{ XDG_DATA_HOME: process.env.XDG_DATA_HOME! },
			);
			t.is(result.exitCode, 0, `expected success, got stderr: ${result.stderr}`);
			t.regex(result.stdout, /Confirmation stored/);
		} finally {
			await rm(transcriptDir, { recursive: true });
		}
	});
});

test.serial('confirm rejects proof not present in any user-visible field', async t => {
	await withTemporaryDataDir(async () => {
		const sessionId = 'aq-confirm-reject-session';
		const transcriptDir = await mkdtemp(path.join(tmpdir(), 'claudex-confirm-test-transcript-'));
		const transcriptPath = path.join(transcriptDir, 'transcript.jsonl');
		const toolUseId = 'toolu_aq_confirm_2';
		const entries = [
			makeAskEntry(toolUseId, sessionId),
			makeAnswerEntry(toolUseId, sessionId, 'something the user picked'),
		];
		await writeFile(transcriptPath, entries.map(line => JSON.stringify(line)).join('\n') + '\n');

		try {
			const command = 'echo dummy';
			const actionHash = hashAction(command);
			const token = await createConfirmationToken(actionHash, 'test', transcriptPath, sessionId);
			const shortId = generateShortId();
			await storePendingConfirmation(shortId, token, command);

			const result = await runCli(
				[ 'confirm', shortId, 'totally unrelated text' ],
				// eslint-disable-next-line @typescript-eslint/naming-convention
				{ XDG_DATA_HOME: process.env.XDG_DATA_HOME! },
			);
			t.is(result.exitCode, 1);
			t.regex(result.stderr, /Proof quote not found/);
		} finally {
			await rm(transcriptDir, { recursive: true });
		}
	});
});
