import { builtinLauncherDefinitions, type LauncherDefinition, type LauncherOverride } from './config/index.js';

export function isClaudeCodeLauncher(def: LauncherDefinition | undefined): boolean {
	if (!def) {
		return true;
	}

	if (def.command.length === 1 && def.command[0] === 'claude') {
		return true;
	}

	// `ollama launch X` wraps Claude Code, so it's still a Claude launcher.
	if (def.command.length >= 2 && def.command[0] === 'ollama' && def.command[1] === 'launch') {
		return true;
	}

	return false;
}

export function isCodexLauncher(def: LauncherDefinition | undefined): boolean {
	if (!def) {
		return false;
	}

	return def.command.length === 1 && def.command[0] === 'codex';
}

export function resolveLauncherDefinition(
	launcherName: string,
	configLauncherDefinitions: Record<string, LauncherDefinition> | undefined,
): LauncherDefinition {
	const configDef = configLauncherDefinitions?.[launcherName];
	const builtinDef = builtinLauncherDefinitions[launcherName];

	if (configDef && builtinDef) {
		// Config overrides built-in: merge base config fields, config command/model win
		const { command: _bc, model: _bm, ...builtinBase } = builtinDef;
		const { command: _cc, model: _cm, ...configBase } = configDef;
		return {
			...builtinBase,
			...configBase,
			command: configDef.command ?? builtinDef.command,
			model: configDef.model ?? builtinDef.model,
		};
	}

	if (configDef) {
		return configDef;
	}

	if (builtinDef) {
		return builtinDef;
	}

	throw new Error(`Unknown launcher: ${launcherName}`);
}

// Resolve the effective args/env overrides for the active launcher.
// For claude-wrapping launchers that aren't bare "claude" (i.e. `ollama launch X`),
// claude overrides apply as a base and the specific launcher's overrides win on top.
export function resolveLauncherOverride(
	overrides: Record<string, LauncherOverride> | undefined,
	launcherName: string | undefined,
	def: LauncherDefinition | undefined,
): LauncherOverride {
	if (!overrides) {
		return {};
	}

	const args: string[] = [];
	const env: Record<string, string> = {};
	const effectiveName = launcherName ?? 'claude';

	if (isClaudeCodeLauncher(def) && effectiveName !== 'claude') {
		const claude = overrides.claude;
		if (claude?.args) {
			args.push(...claude.args);
		}

		if (claude?.env) {
			Object.assign(env, claude.env);
		}
	}

	const specific = overrides[effectiveName];
	if (specific?.args) {
		args.push(...specific.args);
	}

	if (specific?.env) {
		Object.assign(env, specific.env);
	}

	return {
		args: args.length > 0 ? args : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
	};
}

export function buildLauncherCommand(
	def: LauncherDefinition,
	modelOverride: string | undefined,
	claudeArgs: string[],
): { command: string; args: string[] } {
	const command = def.command[0];
	const args = def.command.slice(1);
	const model = modelOverride ?? def.model;
	if (model) {
		args.push('--model', model);
	}

	// For bare single-command launchers (claude, opencode, codex), don't insert "--" separator
	const isBare = def.command.length === 1 && (def.command[0] === 'claude' || def.command[0] === 'opencode' || def.command[0] === 'codex');
	if (isBare) {
		args.push(...claudeArgs);
	} else {
		args.push('--', ...claudeArgs);
	}

	return { command, args };
}
