import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { z } from 'zod';
import { type LauncherDefinition } from './config/index.js';
import { hookGroupSchema, ensureOpenCodePluginSetup } from './hooks.js';
import { buildLauncherCommand } from './launcher.js';
import { effectiveSpecField, resolveLauncherSpec } from './launchers/registry.js';
import { setupKnownHosts } from './ssh/known-hosts.js';
import { setupHostPortForwarding } from './port-proxy/container.js';
import { parseJsonWithSchema } from './hooks/shared.js';
import { isErrnoException } from './utils.js';

const settingsSchema = z.object({
	hooks: z.record(z.string(), z.array(hookGroupSchema)).optional(),
});

type Settings = z.infer<typeof settingsSchema>;

// A claudex-managed hook command always has the shape
// "<path-to-claudex> hook <event>" (see hookCommand() in hooks.ts), so its
// leading token is an absolute path whose basename is "claudex". Any other
// command (e.g. "slopctl hook PreToolUse") belongs to a different tool and
// must be left strictly alone — its binary is not ours to recreate, and an
// absolute foreign path would otherwise get its real binary overwritten.
function claudexHookBinPath(hookCommand: string): string | undefined {
	const bin = hookCommand.split(' ')[0];
	if (!path.isAbsolute(bin) || path.basename(bin) !== 'claudex') {
		return undefined;
	}

	return bin;
}

// The distinct claudex binary paths referenced by hook commands. Non-claudex
// commands are dropped here so we never touch their binaries.
function collectClaudexBins(hooks: NonNullable<Settings['hooks']>): Set<string> {
	const bins = new Set<string>();
	const commands = Object.values(hooks)
		.flatMap(groups => groups.flatMap(group => group.hooks))
		.filter(hook => hook.type === 'command' && hook.command)
		.map(hook => hook.command);

	for (const command of commands) {
		const bin = claudexHookBinPath(command);
		if (bin) {
			bins.add(bin);
		}
	}

	return bins;
}

// Make `claudexBin` resolve to a wrapper that runs the in-container CLI. The
// path `which claudex` produced on the host usually doesn't exist inside the
// container, so we create it there — but never clobber a file that isn't
// already our wrapper: a real claudex on PATH can service the hook itself, and
// an unrelated file at this path must not be destroyed.
async function ensureClaudexWrapper(claudexBin: string, cliPath: string, wrapperContent: string): Promise<void> {
	let existing: string | undefined;
	try {
		existing = await fs.readFile(claudexBin, 'utf8');
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
		// ENOENT — nothing there yet, safe to create.
	}

	if (existing !== undefined && !existing.includes(cliPath)) {
		console.warn(`Warning: refusing to overwrite existing non-claudex file at ${claudexBin}`);
		return;
	}

	await fs.mkdir(path.dirname(claudexBin), { recursive: true });

	// Replace any stale wrapper, then (re)write the current one.
	try {
		await fs.unlink(claudexBin);
	} catch {
		// Ignore if file doesn't exist
	}

	await fs.writeFile(claudexBin, wrapperContent, { mode: 0o755 });
}

export async function setupHookSymlinks(claudeConfigDir?: string) {
	const claudeDir = claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
	const settingsPath = path.join(claudeDir, 'settings.json');

	try {
		const settingsContent = await fs.readFile(settingsPath, 'utf8');
		const settings = parseJsonWithSchema<Settings>(settingsContent, settingsSchema);

		if (!settings.hooks) {
			return;
		}

		// Get the project root (where build/ is)
		const currentFileUrl = import.meta.url;
		const currentFilePath = fileURLToPath(currentFileUrl);
		const buildDir = path.dirname(currentFilePath);
		const cliPath = path.join(buildDir, 'cli.js');
		const wrapperContent = `#!/bin/sh\nexec node ${cliPath} "$@"\n`;

		for (const claudexBin of collectClaudexBins(settings.hooks)) {
			try {
				// eslint-disable-next-line no-await-in-loop
				await ensureClaudexWrapper(claudexBin, cliPath, wrapperContent);
			} catch (error) {
				// Skip this hook if we can't create it (e.g., permission denied)
				if (error instanceof Error) {
					console.warn(`Warning: Could not create hook wrapper at ${claudexBin}: ${error.message}`);
				}
			}
		}
	} catch (error) {
		if (isErrnoException(error) && error.code === 'ENOENT') {
			// Settings file doesn't exist yet — nothing to set up
			return;
		}

		// Unexpected error — warn but continue
		console.warn(`Warning: Could not set up hook symlinks: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function mainInDocker() {
	// Run user startup commands before any other setup
	const userStartupJson = process.env.CLAUDEX_USER_STARTUP_COMMANDS;
	if (userStartupJson) {
		const commands = JSON.parse(userStartupJson) as string[];
		for (const cmd of commands) {
			// eslint-disable-next-line no-await-in-loop
			await execa('sh', [ '-c', cmd ], { stdio: 'inherit' });
		}
	}

	await setupHookSymlinks();
	await setupKnownHosts();
	const cleanupPortForwarding = await setupHostPortForwarding();

	// Now exec claude (or configured launcher) with all arguments
	const claudeArgs = process.argv.slice(2);

	const launcherCommandJson = process.env.CLAUDEX_LAUNCHER_COMMAND;
	const launcherModel = process.env.CLAUDEX_LAUNCHER_MODEL;
	const launcherName = process.env.CLAUDEX_LAUNCHER_NAME;

	try {
		if (launcherCommandJson) {
			const launcherCommand = JSON.parse(launcherCommandJson) as string[];
			const def: LauncherDefinition = { command: launcherCommand, model: launcherModel };
			const spec = launcherName ? resolveLauncherSpec(launcherName, undefined) : undefined;
			const hookStrategy = spec ? effectiveSpecField(spec, 'hookStrategy') : undefined;
			if (hookStrategy === 'opencode-plugin') {
				await ensureOpenCodePluginSetup();
			}

			const { command, args } = buildLauncherCommand(def, undefined, claudeArgs, launcherName);
			await execa(command, args, {
				stdin: process.stdin,
				stdout: process.stdout,
				stderr: process.stderr,
			});
		} else {
			await execa('claude', claudeArgs, {
				stdin: process.stdin,
				stdout: process.stdout,
				stderr: process.stderr,
			});
		}
	} finally {
		cleanupPortForwarding?.();
	}

	console.log('Shutting down container...');
}
