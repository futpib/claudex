import test from 'ava';
import { type LauncherDefinition } from './config/index.js';
import { buildLauncherCommand, resolveLauncherDefinition, isClaudeCodeLauncher, isCodexLauncher, resolveLauncherOverride } from './launcher.js';

// --- buildLauncherCommand ---

test('buildLauncherCommand with bare claude launcher passes args directly', t => {
	const def: LauncherDefinition = { command: [ 'claude' ] };
	const result = buildLauncherCommand(def, undefined, [ '--setting-sources', 'user,local' ]);
	t.is(result.command, 'claude');
	t.deepEqual(result.args, [ '--setting-sources', 'user,local' ]);
});

test('buildLauncherCommand with bare codex launcher passes args directly', t => {
	const def: LauncherDefinition = { command: [ 'codex' ] };
	const result = buildLauncherCommand(def, undefined, [ 'exec', '--help' ]);
	t.is(result.command, 'codex');
	t.deepEqual(result.args, [ 'exec', '--help' ]);
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

// --- isClaudeCodeLauncher / isCodexLauncher ---

test('isClaudeCodeLauncher true for undefined, [claude], and ollama launch X', t => {
	t.true(isClaudeCodeLauncher(undefined));
	t.true(isClaudeCodeLauncher({ command: [ 'claude' ] }));
	t.true(isClaudeCodeLauncher({ command: [ 'ollama', 'launch', 'claude' ] }));
	t.true(isClaudeCodeLauncher({ command: [ 'ollama', 'launch', 'qwen3-coder:480b' ] }));
	t.false(isClaudeCodeLauncher({ command: [ 'codex' ] }));
	t.false(isClaudeCodeLauncher({ command: [ 'opencode' ] }));
	t.false(isClaudeCodeLauncher({ command: [ 'ollama', 'serve' ] }));
});

test('isCodexLauncher true only for [codex]', t => {
	t.false(isCodexLauncher(undefined));
	t.true(isCodexLauncher({ command: [ 'codex' ] }));
	t.false(isCodexLauncher({ command: [ 'claude' ] }));
	t.false(isCodexLauncher({ command: [ 'ollama', 'launch', 'claude' ] }));
});

// --- resolveLauncherOverride ---

test('resolveLauncherOverride returns empty when overrides undefined', t => {
	const result = resolveLauncherOverride(undefined, 'claude', { command: [ 'claude' ] });
	t.deepEqual(result, {});
});

test('resolveLauncherOverride picks overrides by active launcher name', t => {
	const overrides = {
		claude: { args: [ '--a' ], env: { A: '1' } },
		codex: { args: [ '--b' ], env: { B: '2' } },
	};
	const result = resolveLauncherOverride(overrides, 'codex', { command: [ 'codex' ] });
	t.deepEqual(result.args, [ '--b' ]);
	t.deepEqual(result.env, { B: '2' });
});

test('resolveLauncherOverride uses claude entry when launcher name undefined', t => {
	const overrides = { claude: { args: [ '--a' ], env: { A: '1' } } };
	const result = resolveLauncherOverride(overrides, undefined, undefined);
	t.deepEqual(result.args, [ '--a' ]);
	t.deepEqual(result.env, { A: '1' });
});

test('resolveLauncherOverride layers claude base under ollama-launch wrapper', t => {
	const overrides = {
		claude: { args: [ '--effort', 'max' ], env: { CCD: '1' } },
		ollama: { args: [ '--extra' ], env: { O: '2' } },
	};
	const result = resolveLauncherOverride(overrides, 'ollama', { command: [ 'ollama', 'launch', 'claude' ] });
	t.deepEqual(result.args, [ '--effort', 'max', '--extra' ]);
	t.deepEqual(result.env, { CCD: '1', O: '2' });
});

test('resolveLauncherOverride does not layer claude base under codex', t => {
	const overrides = {
		claude: { args: [ '--claude-flag' ] },
		codex: { args: [ '--codex-flag' ] },
	};
	const result = resolveLauncherOverride(overrides, 'codex', { command: [ 'codex' ] });
	t.deepEqual(result.args, [ '--codex-flag' ]);
});
