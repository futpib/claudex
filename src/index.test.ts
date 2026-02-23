import path from 'node:path';
import process from 'node:process';
import test from 'ava';
import { execa } from 'execa';
import { builtinLauncherDefinitions, type LauncherDefinition } from './config/index.js';
import { buildLauncherCommand, resolveLauncherDefinition } from './launcher.js';

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
	for (const action of [ 'list', 'get', 'set', 'add', 'remove', 'unset' ]) {
		t.true(stdout.includes(action), `config help should mention ${action}`);
	}
});

for (const action of [ 'list', 'get', 'set', 'add', 'remove', 'unset' ]) {
	test(`config ${action} --help exits 0 and lists scope options`, async t => {
		const { exitCode, stdout } = await runCli([ 'config', action, '--help' ]);
		t.is(exitCode, 0);
		for (const flag of [ '--global', '--project', '--group', '--profile', '--file' ]) {
			t.true(stdout.includes(flag), `config ${action} help should mention ${flag}`);
		}
	});
}

// --- builtinLauncherDefinitions ---

test('builtinLauncherDefinitions includes claude and ollama', t => {
	t.truthy(builtinLauncherDefinitions.claude);
	t.deepEqual(builtinLauncherDefinitions.claude.command, [ 'claude' ]);

	t.truthy(builtinLauncherDefinitions.ollama);
	t.deepEqual(builtinLauncherDefinitions.ollama.command, [ 'ollama', 'launch', 'claude' ]);
	t.deepEqual(builtinLauncherDefinitions.ollama.packages, [ 'ollama' ]);
	t.deepEqual(builtinLauncherDefinitions.ollama.hostPorts, [ 11_434 ]);
});

// --- buildLauncherCommand ---

test('buildLauncherCommand with bare claude launcher passes args directly', t => {
	const def: LauncherDefinition = { command: [ 'claude' ] };
	const result = buildLauncherCommand(def, undefined, [ '--setting-sources', 'user,local' ]);
	t.is(result.command, 'claude');
	t.deepEqual(result.args, [ '--setting-sources', 'user,local' ]);
});

test('buildLauncherCommand with non-claude launcher inserts -- separator', t => {
	const def: LauncherDefinition = { command: [ 'ollama', 'launch', 'claude' ] };
	const result = buildLauncherCommand(def, undefined, [ '--setting-sources', 'user,local' ]);
	t.is(result.command, 'ollama');
	t.deepEqual(result.args, [ 'launch', 'claude', '--', '--setting-sources', 'user,local' ]);
});

test('buildLauncherCommand adds --model from definition', t => {
	const def: LauncherDefinition = { command: [ 'ollama', 'launch', 'claude' ], model: 'kimi-k2.5:cloud' };
	const result = buildLauncherCommand(def, undefined, [ 'arg1' ]);
	t.is(result.command, 'ollama');
	t.deepEqual(result.args, [ 'launch', 'claude', '--model', 'kimi-k2.5:cloud', '--', 'arg1' ]);
});

test('buildLauncherCommand model override takes precedence over definition model', t => {
	const def: LauncherDefinition = { command: [ 'ollama', 'launch', 'claude' ], model: 'default-model' };
	const result = buildLauncherCommand(def, 'override-model', [ 'arg1' ]);
	t.deepEqual(result.args, [ 'launch', 'claude', '--model', 'override-model', '--', 'arg1' ]);
});

test('buildLauncherCommand with no model omits --model flag', t => {
	const def: LauncherDefinition = { command: [ 'ollama', 'launch', 'claude' ] };
	const result = buildLauncherCommand(def, undefined, []);
	t.deepEqual(result.args, [ 'launch', 'claude', '--' ]);
});

// --- resolveLauncherDefinition ---

test('resolveLauncherDefinition returns built-in launcher when no config overrides', t => {
	const def = resolveLauncherDefinition('claude', undefined);
	t.deepEqual(def.command, [ 'claude' ]);
});

test('resolveLauncherDefinition returns built-in ollama with packages and hostPorts', t => {
	const def = resolveLauncherDefinition('ollama', undefined);
	t.deepEqual(def.command, [ 'ollama', 'launch', 'claude' ]);
	t.deepEqual(def.packages, [ 'ollama' ]);
	t.deepEqual(def.hostPorts, [ 11_434 ]);
});

test('resolveLauncherDefinition throws for unknown launcher', t => {
	t.throws(() => resolveLauncherDefinition('nonexistent', undefined), {
		message: 'Unknown launcher: nonexistent',
	});
});

test('resolveLauncherDefinition returns custom launcher from config', t => {
	const configDefs = {
		custom: { command: [ 'my-tool', 'run' ], model: 'my-model' },
	};
	const def = resolveLauncherDefinition('custom', configDefs);
	t.deepEqual(def.command, [ 'my-tool', 'run' ]);
	t.is(def.model, 'my-model');
});

test('resolveLauncherDefinition merges config override with built-in', t => {
	const configDefs = {
		ollama: { command: [ 'ollama', 'launch', 'claude' ], model: 'qwen3-coder:480b' },
	};
	const def = resolveLauncherDefinition('ollama', configDefs);
	t.deepEqual(def.command, [ 'ollama', 'launch', 'claude' ]);
	t.is(def.model, 'qwen3-coder:480b');
	// Built-in packages and hostPorts should be preserved
	t.deepEqual(def.packages, [ 'ollama' ]);
	t.deepEqual(def.hostPorts, [ 11_434 ]);
});

test('resolveLauncherDefinition config command overrides built-in command', t => {
	const configDefs = {
		ollama: { command: [ 'custom-ollama', 'launch' ] },
	};
	const def = resolveLauncherDefinition('ollama', configDefs);
	t.deepEqual(def.command, [ 'custom-ollama', 'launch' ]);
	// Built-in base config fields still apply
	t.deepEqual(def.packages, [ 'ollama' ]);
});
