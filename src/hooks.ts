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

	const result = await execa('which', [ 'claudex-hook-pre-tool-use' ]);
	const hookPath = result.stdout.trim();

	settings.hooks ||= {};

	if (!settings.hooks.PreToolUse) {
		settings.hooks.PreToolUse = [];
	}

	const hasHook = settings.hooks.PreToolUse.some(entry =>
		entry.hooks.some(hook => hook.command === hookPath));

	if (!hasHook) {
		settings.hooks.PreToolUse.push({
			matcher: '.*',
			hooks: [ {
				type: 'command',
				command: hookPath,
			} ],
		});

		await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
	}
}
