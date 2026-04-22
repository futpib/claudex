import test from 'ava';
import { mergeBaseConfigs, type BaseConfig } from './index.js';

// --- mergeBaseConfigs: dockerDangerouslySkipPermissions ---

test('mergeBaseConfigs inherits dockerDangerouslySkipPermissions from base', t => {
	const base: BaseConfig = { dockerDangerouslySkipPermissions: true };
	const overlay: BaseConfig = {};
	const merged = mergeBaseConfigs(base, overlay);
	t.is(merged.dockerDangerouslySkipPermissions, true);
});

test('mergeBaseConfigs overlay overrides dockerDangerouslySkipPermissions', t => {
	const base: BaseConfig = { dockerDangerouslySkipPermissions: true };
	const overlay: BaseConfig = { dockerDangerouslySkipPermissions: false };
	const merged = mergeBaseConfigs(base, overlay);
	t.is(merged.dockerDangerouslySkipPermissions, false);
});

// --- mergeBaseConfigs: dockerAllowDangerouslySkipPermissions ---

test('mergeBaseConfigs inherits dockerAllowDangerouslySkipPermissions from base', t => {
	const base: BaseConfig = { dockerAllowDangerouslySkipPermissions: true };
	const overlay: BaseConfig = {};
	const merged = mergeBaseConfigs(base, overlay);
	t.is(merged.dockerAllowDangerouslySkipPermissions, true);
});

test('mergeBaseConfigs overlay overrides dockerAllowDangerouslySkipPermissions', t => {
	const base: BaseConfig = { dockerAllowDangerouslySkipPermissions: true };
	const overlay: BaseConfig = { dockerAllowDangerouslySkipPermissions: false };
	const merged = mergeBaseConfigs(base, overlay);
	t.is(merged.dockerAllowDangerouslySkipPermissions, false);
});

// --- mergeBaseConfigs: claudeEnv ---

test('mergeBaseConfigs merges claudeEnv from base and overlay', t => {
	const base: BaseConfig = { claudeEnv: { FOO: '1' } };
	const overlay: BaseConfig = { claudeEnv: { BAR: '2' } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.claudeEnv, { FOO: '1', BAR: '2' });
});

test('mergeBaseConfigs overlay claudeEnv key wins over base', t => {
	const base: BaseConfig = { claudeEnv: { FOO: '1' } };
	const overlay: BaseConfig = { claudeEnv: { FOO: '2' } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.claudeEnv, { FOO: '2' });
});

test('mergeBaseConfigs leaves claudeEnv undefined when neither side sets it', t => {
	const merged = mergeBaseConfigs({}, {});
	t.is(merged.claudeEnv, undefined);
});

// --- mergeBaseConfigs: claudeSettings ---

test('mergeBaseConfigs merges claudeSettings from base and overlay', t => {
	const base: BaseConfig = { claudeSettings: { showThinkingSummaries: true } };
	const overlay: BaseConfig = { claudeSettings: { includeCoAuthoredBy: false } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.claudeSettings, {
		showThinkingSummaries: true,
		includeCoAuthoredBy: false,
	});
});

test('mergeBaseConfigs overlay claudeSettings key wins over base', t => {
	const base: BaseConfig = { claudeSettings: { showThinkingSummaries: false } };
	const overlay: BaseConfig = { claudeSettings: { showThinkingSummaries: true } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.claudeSettings, { showThinkingSummaries: true });
});

test('mergeBaseConfigs leaves claudeSettings undefined when neither side sets it', t => {
	const merged = mergeBaseConfigs({}, {});
	t.is(merged.claudeSettings, undefined);
});

// --- mergeBaseConfigs: launcherOverrides ---

test('mergeBaseConfigs concatenates launcherOverrides args per launcher', t => {
	const base: BaseConfig = { launcherOverrides: { claude: { args: [ '--base' ] } } };
	const overlay: BaseConfig = { launcherOverrides: { claude: { args: [ '--overlay' ] } } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launcherOverrides?.claude.args, [ '--base', '--overlay' ]);
});

test('mergeBaseConfigs merges launcherOverrides env per launcher', t => {
	const base: BaseConfig = { launcherOverrides: { codex: { env: { A: '1' } } } };
	const overlay: BaseConfig = { launcherOverrides: { codex: { env: { B: '2' } } } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launcherOverrides?.codex.env, { A: '1', B: '2' });
});

test('mergeBaseConfigs combines launchers across base and overlay', t => {
	const base: BaseConfig = { launcherOverrides: { claude: { args: [ '--a' ] } } };
	const overlay: BaseConfig = { launcherOverrides: { codex: { args: [ '--c' ] } } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launcherOverrides?.claude.args, [ '--a' ]);
	t.deepEqual(merged.launcherOverrides?.codex.args, [ '--c' ]);
});

test('mergeBaseConfigs leaves launcherOverrides undefined when neither side sets it', t => {
	const merged = mergeBaseConfigs({}, {});
	t.is(merged.launcherOverrides, undefined);
});
