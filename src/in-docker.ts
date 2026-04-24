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

async function setupHookSymlinks() {
	const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
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

		// Collect all hook commands from settings
		const hookCommands = new Set<string>();
		for (const hookType of Object.values(settings.hooks)) {
			for (const matcher of hookType) {
				for (const hook of matcher.hooks) {
					if (hook.type === 'command' && hook.command) {
						hookCommands.add(hook.command);
					}
				}
			}
		}

		// Create symlinks for claudex binary references in hook commands
		for (const hookCommand of hookCommands) {
			try {
				// Hook commands are now "claudex hook <name>" or "/path/to/claudex hook <name>"
				// We need to ensure the claudex binary path is available
				const parts = hookCommand.split(' ');
				const claudexBin = parts[0];

				// Create parent directories if they don't exist
				const hookDir = path.dirname(claudexBin);
				// eslint-disable-next-line no-await-in-loop
				await fs.mkdir(hookDir, { recursive: true });

				// Remove existing symlink/file if it exists
				try {
					// eslint-disable-next-line no-await-in-loop
					await fs.unlink(claudexBin);
				} catch {
					// Ignore if file doesn't exist
				}

				// Create a wrapper script that invokes node with the CLI entry point
				const wrapperContent = `#!/bin/sh\nexec node ${cliPath} "$@"\n`;
				// eslint-disable-next-line no-await-in-loop
				await fs.writeFile(claudexBin, wrapperContent, { mode: 0o755 });
			} catch (error) {
				// Skip this hook if we can't create it (e.g., permission denied)
				if (error instanceof Error) {
					console.warn(`Warning: Could not create hook wrapper at ${hookCommand}: ${error.message}`);
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
