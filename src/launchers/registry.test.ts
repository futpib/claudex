import path from 'node:path';
import os from 'node:os';
import test from 'ava';
import { paths } from '../paths.js';
import {
	launcherRegistry, builtinLauncherDefinitions,
	buildAccountMountPlan, effectiveSpecField,
	getAccountPrimaryDir, getLauncherSpec,
	resolveLauncherSpec, walkSpecWraps,
} from './registry.js';

// --- launcherRegistry & builtinLauncherDefinitions ---

test('launcherRegistry contains the four built-in launchers', t => {
	t.truthy(launcherRegistry.claude);
	t.truthy(launcherRegistry.opencode);
	t.truthy(launcherRegistry.ollama);
	t.truthy(launcherRegistry.codex);
});

test('ollama wraps claude', t => {
	t.is(launcherRegistry.ollama.wraps, 'claude');
});

test('walkSpecWraps yields outer then inner', t => {
	const chain = walkSpecWraps(launcherRegistry.ollama).map(s => s.name);
	t.deepEqual(chain, [ 'ollama', 'claude' ]);
});

test('builtinLauncherDefinitions derives command/packages/volumes/hostPorts from registry', t => {
	t.deepEqual(builtinLauncherDefinitions.claude.command, [ 'claude' ]);
	t.deepEqual(builtinLauncherDefinitions.ollama.command, [ 'ollama', 'launch', 'claude' ]);
	t.deepEqual(builtinLauncherDefinitions.ollama.packages, [ 'ollama' ]);
	t.deepEqual(builtinLauncherDefinitions.ollama.hostPorts, [ 11_434 ]);
	t.deepEqual(builtinLauncherDefinitions.codex.command, [ 'codex' ]);
	t.deepEqual(builtinLauncherDefinitions.codex.packages, [ 'openai-codex' ]);
	t.deepEqual(builtinLauncherDefinitions.opencode.command, [ 'opencode' ]);
});

// --- getLauncherSpec / resolveLauncherSpec ---

test('getLauncherSpec returns undefined for undefined', t => {
	t.is(getLauncherSpec(undefined), undefined);
});

test('getLauncherSpec returns built-in by name', t => {
	t.is(getLauncherSpec('claude')?.name, 'claude');
});

test('getLauncherSpec synthesizes a spec for unknown names', t => {
	const spec = getLauncherSpec('my-tool');
	t.is(spec?.name, 'my-tool');
	t.deepEqual(spec?.command, [ 'my-tool' ]);
});

test('resolveLauncherSpec returns built-in when no config', t => {
	const spec = resolveLauncherSpec('ollama', undefined);
	t.deepEqual(spec.command, [ 'ollama', 'launch', 'claude' ]);
	t.deepEqual(spec.packages, [ 'ollama' ]);
});

test('resolveLauncherSpec merges user command override', t => {
	const spec = resolveLauncherSpec('ollama', { ollama: { command: [ 'custom-ollama', 'launch' ] } });
	t.deepEqual(spec.command, [ 'custom-ollama', 'launch' ]);
	t.deepEqual(spec.packages, [ 'ollama' ]);
});

test('resolveLauncherSpec throws for unknown without config', t => {
	t.throws(() => resolveLauncherSpec('nothing', undefined), {
		message: 'Unknown launcher: nothing',
	});
});

// --- effectiveSpecField ---

test('effectiveSpecField walks wraps chain', t => {
	t.is(effectiveSpecField(launcherRegistry.ollama, 'hookStrategy'), 'claude-settings');
	t.is(effectiveSpecField(launcherRegistry.ollama, 'mcpWiring'), 'claude-json');
	t.is(effectiveSpecField(launcherRegistry.ollama, 'permissionFlags')?.dangerouslySkip, '--dangerously-skip-permissions');
});

test('effectiveSpecField returns own field when set', t => {
	t.is(effectiveSpecField(launcherRegistry.opencode, 'hookStrategy'), 'opencode-plugin');
});

test('effectiveSpecField returns undefined when missing', t => {
	t.is(effectiveSpecField(launcherRegistry.codex, 'cliFeatures'), undefined);
	t.is(effectiveSpecField(launcherRegistry.opencode, 'permissionFlags'), undefined);
});

// --- buildAccountMountPlan: no-account mode ---

test('buildAccountMountPlan for claude (no account) mounts ~/.claude + ~/.claude.json', t => {
	const plan = buildAccountMountPlan(launcherRegistry.claude, undefined);
	const home = os.homedir();
	t.deepEqual(plan.dockerArgs, [
		'-v',
		`${home}/.claude:${home}/.claude`,
		'-v',
		`${home}/.claude.json:${home}/.claude.json`,
	]);
	t.deepEqual(plan.envVars, {});
	t.deepEqual(plan.dirsToCreate, [ `${home}/.claude` ]);
});

test('buildAccountMountPlan for codex (no account) mounts ~/.codex', t => {
	const plan = buildAccountMountPlan(launcherRegistry.codex, undefined);
	const home = os.homedir();
	t.deepEqual(plan.dockerArgs, [ '-v', `${home}/.codex:${home}/.codex` ]);
	t.deepEqual(plan.envVars, {});
});

test('buildAccountMountPlan for opencode (no account) mounts config and data dirs', t => {
	const plan = buildAccountMountPlan(launcherRegistry.opencode, undefined);
	const home = os.homedir();
	t.deepEqual(plan.dockerArgs, [
		'-v',
		`${home}/.config/opencode:${home}/.config/opencode`,
		'-v',
		`${home}/.local/share/opencode:${home}/.local/share/opencode`,
	]);
	t.deepEqual(plan.envVars, {});
	t.deepEqual(plan.dirsToCreate, [
		`${home}/.config/opencode`,
		`${home}/.local/share/opencode`,
	]);
});

test('buildAccountMountPlan for ollama (no account) inherits claude mounts via wraps', t => {
	const plan = buildAccountMountPlan(launcherRegistry.ollama, undefined);
	const home = os.homedir();
	t.deepEqual(plan.dockerArgs, [
		'-v',
		`${home}/.claude:${home}/.claude`,
		'-v',
		`${home}/.claude.json:${home}/.claude.json`,
	]);
});

// --- buildAccountMountPlan: account mode ---

test('buildAccountMountPlan for claude (account) binds account dir and exports CLAUDE_CONFIG_DIR', t => {
	const plan = buildAccountMountPlan(launcherRegistry.claude, 'work');
	const accountDir = path.join(paths.config, 'accounts', 'work', 'claude');
	t.deepEqual(plan.dockerArgs, [
		'-v',
		`${accountDir}:${accountDir}`,
		'-e',
		`CLAUDE_CONFIG_DIR=${accountDir}`,
	]);
	// eslint-disable-next-line @typescript-eslint/naming-convention
	t.deepEqual(plan.envVars, { CLAUDE_CONFIG_DIR: accountDir });
});

test('buildAccountMountPlan for codex (account) binds account dir and exports CODEX_HOME', t => {
	const plan = buildAccountMountPlan(launcherRegistry.codex, 'work');
	const accountDir = path.join(paths.config, 'accounts', 'work', 'codex');
	t.deepEqual(plan.dockerArgs, [
		'-v',
		`${accountDir}:${accountDir}`,
		'-e',
		`CODEX_HOME=${accountDir}`,
	]);
});

test('buildAccountMountPlan for opencode (account) splits config and data subpaths', t => {
	const plan = buildAccountMountPlan(launcherRegistry.opencode, 'work');
	const accountDir = path.join(paths.config, 'accounts', 'work', 'opencode');
	const home = os.homedir();
	t.deepEqual(plan.dockerArgs, [
		'-v',
		`${accountDir}/config:${home}/.config/opencode`,
		'-v',
		`${accountDir}/data:${home}/.local/share/opencode`,
	]);
	t.deepEqual(plan.dirsToCreate, [
		`${accountDir}/config`,
		`${accountDir}/data`,
	]);
});

test('buildAccountMountPlan for ollama (account) uses claude account dir', t => {
	const plan = buildAccountMountPlan(launcherRegistry.ollama, 'work');
	const accountDir = path.join(paths.config, 'accounts', 'work', 'claude');
	t.deepEqual(plan.dockerArgs, [
		'-v',
		`${accountDir}:${accountDir}`,
		'-e',
		`CLAUDE_CONFIG_DIR=${accountDir}`,
	]);
});

// --- getAccountPrimaryDir ---

test('getAccountPrimaryDir for claude (no account) returns ~/.claude', t => {
	t.is(getAccountPrimaryDir(launcherRegistry.claude, undefined), path.join(os.homedir(), '.claude'));
});

test('getAccountPrimaryDir for claude (account) returns the account claude dir', t => {
	t.is(getAccountPrimaryDir(launcherRegistry.claude, 'work'), path.join(paths.config, 'accounts', 'work', 'claude'));
});

test('getAccountPrimaryDir for ollama inherits claude dir via wraps', t => {
	t.is(getAccountPrimaryDir(launcherRegistry.ollama, undefined), path.join(os.homedir(), '.claude'));
});

test('getAccountPrimaryDir for opencode (account) returns the config subpath', t => {
	const accountDir = path.join(paths.config, 'accounts', 'work', 'opencode');
	t.is(getAccountPrimaryDir(launcherRegistry.opencode, 'work'), path.join(accountDir, 'config'));
});
