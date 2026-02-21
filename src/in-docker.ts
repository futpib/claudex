import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { z } from 'zod';
import { type LauncherDefinition } from './config.js';
import { buildLauncherCommand } from './launcher.js';
import { setupKnownHosts } from './ssh/known-hosts.js';
import { setupHostPortForwarding } from './port-proxy/container.js';
import { parseJsonWithSchema } from './hooks/shared.js';

type HookConfig = {
	type: string;
	command: string;
};

type HookMatcher = {
	matcher: string;
	hooks: HookConfig[];
};

type Settings = {
	hooks?: Record<string, HookMatcher[]>;
};

const settingsSchema = z.object({
	hooks: z.record(z.string(), z.array(z.object({
		matcher: z.string(),
		hooks: z.array(z.object({
			type: z.string(),
			command: z.string(),
		})),
	}))).optional(),
});

async function setupHookSymlinks() {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');

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
		const hooksDir = path.join(buildDir, 'hooks');

		// Mapping of hook command names to their actual files
		const hookNameMap: Record<string, string> = {
			'claudex-hook-pre-tool-use': 'pre-tool-use.js',
			'claudex-hook-user-prompt-submit': 'user-prompt-submit.js',
			'claudex-hook-notification': 'notification.js',
			'claudex-hook-stop': 'stop.js',
			'claudex-submit-co-authorship-proof': 'submit-co-authorship-proof.js',
		};

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

		// Create symlinks for each hook command
		for (const hookCommand of hookCommands) {
			try {
				const hookBasename = path.basename(hookCommand);
				const targetFile = hookNameMap[hookBasename];

				if (!targetFile) {
					console.warn(`Unknown hook: ${hookBasename}`);
					continue;
				}

				const targetPath = path.join(hooksDir, targetFile);

				// Create parent directories if they don't exist
				const hookDir = path.dirname(hookCommand);
				// eslint-disable-next-line no-await-in-loop
				await fs.mkdir(hookDir, { recursive: true });

				// Remove existing symlink/file if it exists
				try {
					// eslint-disable-next-line no-await-in-loop
					await fs.unlink(hookCommand);
				} catch {
					// Ignore if file doesn't exist
				}

				// Create symlink
				// eslint-disable-next-line no-await-in-loop
				await fs.symlink(targetPath, hookCommand);
			} catch (error) {
				// Skip this hook if we can't create it (e.g., permission denied)
				if (error instanceof Error) {
					console.warn(`Warning: Could not create hook symlink at ${hookCommand}: ${error.message}`);
				}
			}
		}
	} catch (error) {
		// If we can't set up hooks, continue anyway
		if (error instanceof Error) {
			console.warn(`Warning: Could not set up hook symlinks: ${error.message}`);
		}
	}
}

export async function mainInDocker() {
	await setupHookSymlinks();
	await setupKnownHosts();
	const cleanupPortForwarding = await setupHostPortForwarding();

	// Now exec claude (or configured launcher) with all arguments
	const claudeArgs = process.argv.slice(2);

	const launcherCommandJson = process.env.CLAUDEX_LAUNCHER_COMMAND;
	const launcherModel = process.env.CLAUDEX_LAUNCHER_MODEL;

	try {
		if (launcherCommandJson) {
			const launcherCommand = JSON.parse(launcherCommandJson) as string[];
			const def: LauncherDefinition = { command: launcherCommand, model: launcherModel };
			const { command, args } = buildLauncherCommand(def, undefined, claudeArgs);
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
