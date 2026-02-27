import path from 'node:path';
import process from 'node:process';
import test from 'ava';
import { execa } from 'execa';

const cliPath = path.join(import.meta.dirname, '../build/cli.js');

async function runCli(args: string[]) {
	const result = await execa('node', [ cliPath, ...args ], {
		cwd: process.cwd(),
		reject: false,
	});
	return {
		exitCode: result.exitCode ?? 0,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

test('--help exits 0 and lists all options', async t => {
	const { exitCode, stdout } = await runCli([ '--help' ]);
	t.is(exitCode, 0);
	for (const flag of [
		'--no-docker',
		'--docker-shell',
		'--docker-exec',
		'--docker-exec-root',
		'--docker-pull',
		'--docker-no-cache',
		'--docker-sudo',
		'--allow-unsafe-directory',
		'--package',
		'--volume',
		'--env',
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
});

test('install --help exits 0 and lists options', async t => {
	const { exitCode, stdout } = await runCli([ 'install', '--help' ]);
	t.is(exitCode, 0);
	t.true(stdout.includes('--no-save'), 'install help should mention --no-save');
	t.true(stdout.includes('--container'), 'install help should mention --container');
	t.true(stdout.includes('packages'), 'install help should mention packages argument');
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
