import { type LauncherDefinition, type LauncherOverride } from './config/schema.js';
import {
	launcherRegistry, resolveLauncherSpec, walkSpecWraps,
	type LauncherSpec,
} from './launchers/registry.js';

export function specToDefinition(spec: LauncherSpec): LauncherDefinition {
	const def: LauncherDefinition = { command: spec.command };
	if (spec.model !== undefined) {
		def.model = spec.model;
	}

	if (spec.packages?.length) {
		def.packages = spec.packages;
	}

	if (spec.volumes?.length) {
		def.volumes = spec.volumes;
	}

	if (spec.hostPorts?.length) {
		def.hostPorts = spec.hostPorts;
	}

	return def;
}

export function resolveLauncherDefinition(
	launcherName: string,
	configLauncherDefinitions: Record<string, LauncherDefinition> | undefined,
): LauncherDefinition {
	const spec = resolveLauncherSpec(launcherName, configLauncherDefinitions);
	return specToDefinition(spec);
}

// Does this launcher spec behave as a Claude Code launcher (either directly
// or by wrapping one)? Returns true for `undefined` (the default launcher).
export function isClaudeCodeSpec(spec: LauncherSpec | undefined): boolean {
	if (!spec) {
		return true;
	}

	for (const s of walkSpecWraps(spec)) {
		if (s.name === 'claude') {
			return true;
		}
	}

	return false;
}

// Fallback command-pattern detector for callers that only have a raw
// definition (no spec). Prefer isClaudeCodeSpec where the spec is available.
export function isClaudeCodeLauncher(def: LauncherDefinition | undefined): boolean {
	if (!def) {
		return true;
	}

	if (def.command.length === 1 && def.command[0] === 'claude') {
		return true;
	}

	if (def.command.length >= 2 && def.command[0] === 'ollama' && def.command[1] === 'launch') {
		return true;
	}

	return false;
}

// Apply overrides in wraps order (outer-most last) so a wrapping launcher's
// overrides layer on top of the wrapped launcher's (e.g. ollama on top of
// claude).
export function resolveLauncherOverride(
	overrides: Record<string, LauncherOverride> | undefined,
	launcherName: string | undefined,
	_def: LauncherDefinition | undefined,
): LauncherOverride {
	if (!overrides) {
		return {};
	}

	const args: string[] = [];
	const env: Record<string, string> = {};
	const effectiveName = launcherName ?? 'claude';

	const spec = launcherRegistry[effectiveName];
	const fallbackSpec: LauncherSpec = { name: effectiveName, command: [ effectiveName ] };
	const chain = spec ? [ ...walkSpecWraps(spec) ].reverse() : [ fallbackSpec ];

	for (const s of chain) {
		const entry = overrides[s.name];
		if (entry?.args) {
			args.push(...entry.args);
		}

		if (entry?.env) {
			Object.assign(env, entry.env);
		}
	}

	return {
		args: args.length > 0 ? args : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
	};
}

function isBareLauncher(def: LauncherDefinition, launcherName: string | undefined): boolean {
	if (launcherName) {
		const spec = launcherRegistry[launcherName];
		if (spec?.isBareCommand !== undefined) {
			return spec.isBareCommand;
		}
	}

	if (def.command.length !== 1) {
		return false;
	}

	const fallback = launcherRegistry[def.command[0]];
	return fallback?.isBareCommand ?? false;
}

export function buildLauncherCommand(
	def: LauncherDefinition,
	modelOverride: string | undefined,
	claudeArgs: string[],
	launcherName?: string,
): { command: string; args: string[] } {
	const command = def.command[0];
	const args = def.command.slice(1);
	const model = modelOverride ?? def.model;
	if (model) {
		args.push('--model', model);
	}

	if (isBareLauncher(def, launcherName)) {
		args.push(...claudeArgs);
	} else {
		args.push('--', ...claudeArgs);
	}

	return { command, args };
}
