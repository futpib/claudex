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
		'--docker-pull',
		'--docker-no-cache',
		'--docker-sudo',
		'--allow-unsafe-directory',
		'--package',
		'--volume',
		'--env',
		'--ssh-key',
	]) {
		t.true(stdout.includes(flag), `help should mention ${flag}`);
	}
});

test('--help lists config subcommand', async t => {
	const { stdout } = await runCli([ '--help' ]);
	t.regex(stdout, /config\b/);
});

test('config --help exits 0 and lists all actions as subcommands', async t => {
	const { exitCode, stdout } = await runCli([ 'config', '--help' ]);
	t.is(exitCode, 0);
	for (const action of [ 'list', 'get', 'set', 'add', 'remove', 'unset' ]) {
		t.true(stdout.includes(action), `config help should mention ${action}`);
	}
});

for (const action of [ 'list', 'get', 'set', 'add', 'remove', 'unset' ]) {
	test(`config ${action} --help exits 0 and lists scope options`, async t => {
		const { exitCode, stdout } = await runCli([ 'config', action, '--help' ]);
		t.is(exitCode, 0);
		for (const flag of [ '--global', '--project', '--group', '--file' ]) {
			t.true(stdout.includes(flag), `config ${action} help should mention ${flag}`);
		}
	});
}
