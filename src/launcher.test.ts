import test from 'ava';
import { type LauncherDefinition } from './config/index.js';
import { buildLauncherCommand, resolveLauncherDefinition } from './launcher.js';

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
