import { builtinLauncherDefinitions, type LauncherDefinition } from './config/index.js';

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

	// For the bare "claude" launcher, don't insert "--" separator
	const isBareClaude = def.command.length === 1 && def.command[0] === 'claude';
	if (isBareClaude) {
		args.push(...claudeArgs);
	} else {
		args.push('--', ...claudeArgs);
	}

	return { command, args };
}
