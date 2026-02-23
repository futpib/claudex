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
