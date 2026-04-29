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

// --- mergeBaseConfigs: launcherOverrides ---

test('mergeBaseConfigs concatenates launcherOverrides args per launcher', t => {
	const base: BaseConfig = { launcherOverrides: { claude: { args: [ '--base' ] } } };
	const overlay: BaseConfig = { launcherOverrides: { claude: { args: [ '--overlay' ] } } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launcherOverrides?.claude.args, [ '--base', '--overlay' ]);
});

test('mergeBaseConfigs merges launcherOverrides env per launcher', t => {
	const base: BaseConfig = { launcherOverrides: { codex: { env: { A: '1' } } } }; // eslint-disable-line @typescript-eslint/naming-convention
	const overlay: BaseConfig = { launcherOverrides: { codex: { env: { B: '2' } } } }; // eslint-disable-line @typescript-eslint/naming-convention
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launcherOverrides?.codex.env, { A: '1', B: '2' }); // eslint-disable-line @typescript-eslint/naming-convention
});

test('mergeBaseConfigs merges launcherOverrides settings per launcher', t => {
	const base: BaseConfig = { launcherOverrides: { claude: { settings: { showThinkingSummaries: true } } } };
	const overlay: BaseConfig = { launcherOverrides: { claude: { settings: { includeCoAuthoredBy: false } } } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launcherOverrides?.claude.settings, {
		showThinkingSummaries: true,
		includeCoAuthoredBy: false,
	});
});

test('mergeBaseConfigs overlay launcherOverrides settings key wins over base', t => {
	const base: BaseConfig = { launcherOverrides: { claude: { settings: { showThinkingSummaries: false } } } };
	const overlay: BaseConfig = { launcherOverrides: { claude: { settings: { showThinkingSummaries: true } } } };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launcherOverrides?.claude.settings, { showThinkingSummaries: true });
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

// --- mergeBaseConfigs: launchers ---

test('mergeBaseConfigs concatenates launchers from base and overlay', t => {
	const base: BaseConfig = { launchers: [ 'codex' ] };
	const overlay: BaseConfig = { launchers: [ 'opencode' ] };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launchers, [ 'codex', 'opencode' ]);
});

test('mergeBaseConfigs deduplicates launchers across base and overlay', t => {
	const base: BaseConfig = { launchers: [ 'codex' ] };
	const overlay: BaseConfig = { launchers: [ 'codex', 'opencode' ] };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.launchers, [ 'codex', 'opencode' ]);
});

test('mergeBaseConfigs leaves launchers undefined when neither side sets it', t => {
	const merged = mergeBaseConfigs({}, {});
	t.is(merged.launchers, undefined);
});

// --- mergeBaseConfigs: envFile / envFiles / envMode ---

test('mergeBaseConfigs overlay envFile wins over base', t => {
	const base: BaseConfig = { envFile: true };
	const overlay: BaseConfig = { envFile: 'custom.env' };
	const merged = mergeBaseConfigs(base, overlay);
	t.is(merged.envFile, 'custom.env');
});

test('mergeBaseConfigs inherits envFile from base when overlay omits it', t => {
	const base: BaseConfig = { envFile: true };
	const overlay: BaseConfig = {};
	const merged = mergeBaseConfigs(base, overlay);
	t.is(merged.envFile, true);
});

test('mergeBaseConfigs concatenates and dedupes envFiles', t => {
	const base: BaseConfig = { envFiles: [ 'a.env' ] };
	const overlay: BaseConfig = { envFiles: [ 'a.env', 'b.env' ] };
	const merged = mergeBaseConfigs(base, overlay);
	t.deepEqual(merged.envFiles, [ 'a.env', 'b.env' ]);
});

test('mergeBaseConfigs leaves envFiles undefined when neither side sets it', t => {
	const merged = mergeBaseConfigs({}, {});
	t.is(merged.envFiles, undefined);
});

test('mergeBaseConfigs overlay envMode wins over base', t => {
	const base: BaseConfig = { envMode: 'all' };
	const overlay: BaseConfig = { envMode: 'explicit' };
	const merged = mergeBaseConfigs(base, overlay);
	t.is(merged.envMode, 'explicit');
});

test('mergeBaseConfigs inherits envMode from base when overlay omits it', t => {
	const base: BaseConfig = { envMode: 'all' };
	const overlay: BaseConfig = {};
	const merged = mergeBaseConfigs(base, overlay);
	t.is(merged.envMode, 'all');
});
