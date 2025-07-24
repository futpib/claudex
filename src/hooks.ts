import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { isErrnoException } from './utils.js';

type ClaudeSettings = {
	includeCoAuthoredBy?: boolean;
	hooks?: {
		PreToolUse?: Array<{
			matcher: string;
			hooks: Array<{
				type: string;
				command: string;
			}>;
		}>;
		UserPromptSubmit?: Array<{
			matcher: string;
			hooks: Array<{
				type: string;
				command: string;
			}>;
		}>;
	};
};

export async function ensureHookSetup() {
	const claudeDir = path.join(os.homedir(), '.claude');
	const settingsPath = path.join(claudeDir, 'settings.json');

	await fs.mkdir(claudeDir, { recursive: true });

	let settings: ClaudeSettings = {};
	try {
		const content = await fs.readFile(settingsPath, 'utf8');
		settings = JSON.parse(content);
	} catch (error) {
		if (!(isErrnoException(error) && error.code === 'ENOENT')) {
			throw error;
		}
	}

	const hookPaths: { preToolUse?: string; userPromptSubmit?: string } = {};

	try {
		const result = await execa('which', [ 'claudex-hook-pre-tool-use' ]);
		hookPaths.preToolUse = result.stdout.trim();
	} catch {}

	try {
		const result = await execa('which', [ 'claudex-hook-user-prompt-submit' ]);
		hookPaths.userPromptSubmit = result.stdout.trim();
	} catch {}

	if (!hookPaths.preToolUse && !hookPaths.userPromptSubmit) {
		return;
	}

	settings.hooks ||= {};
	let needsUpdate = false;

	if (hookPaths.preToolUse) {
		if (!settings.hooks.PreToolUse) {
			settings.hooks.PreToolUse = [];
		}

		const hasPreToolUseHook = settings.hooks.PreToolUse.some(entry =>
			entry.hooks.some(hook => hook.command === hookPaths.preToolUse));

		if (!hasPreToolUseHook) {
			settings.hooks.PreToolUse.push({
				matcher: '.*',
				hooks: [ {
					type: 'command',
					command: hookPaths.preToolUse,
				} ],
			});
			needsUpdate = true;
		}
	}

	if (hookPaths.userPromptSubmit) {
		if (!settings.hooks.UserPromptSubmit) {
			settings.hooks.UserPromptSubmit = [];
		}

		const hasUserPromptSubmitHook = settings.hooks.UserPromptSubmit.some(entry =>
			entry.hooks.some(hook => hook.command === hookPaths.userPromptSubmit));

		if (!hasUserPromptSubmitHook) {
			settings.hooks.UserPromptSubmit.push({
				matcher: '.*',
				hooks: [ {
					type: 'command',
					command: hookPaths.userPromptSubmit,
				} ],
			});
			needsUpdate = true;
		}
	}

	if (needsUpdate) {
		await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
	}
}
