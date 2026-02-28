import { builtinLauncherDefinitions, type LauncherDefinition } from './config/index.js';

export function isClaudeCodeLauncher(def: LauncherDefinition | undefined): boolean {
	if (!def) {
		return true;
	}

	return def.command.length === 1 && def.command[0] === 'claude';
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

	// For bare single-command launchers (claude, opencode), don't insert "--" separator
	const isBare = def.command.length === 1 && (def.command[0] === 'claude' || def.command[0] === 'opencode');
	if (isBare) {
		args.push(...claudeArgs);
	} else {
		args.push('--', ...claudeArgs);
	}

	return { command, args };
}
