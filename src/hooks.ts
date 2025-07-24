/* eslint-disable @typescript-eslint/naming-convention */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { execa } from 'execa';
import { isErrnoException, parseJson } from './utils.js';

const hookEntrySchema = z.object({
	type: z.string(),
	command: z.string(),
});

const hookGroupSchema = z.object({
	matcher: z.string(),
	hooks: z.array(hookEntrySchema),
});

const claudeSettingsSchema = z.object({
	includeCoAuthoredBy: z.boolean().optional(),
	hooks: z.object({
		PreToolUse: z.array(hookGroupSchema).optional(),
		UserPromptSubmit: z.array(hookGroupSchema).optional(),
	}).optional(),
});

type ClaudeSettings = z.infer<typeof claudeSettingsSchema>;

async function findHookPath(command: string): Promise<string | undefined> {
	try {
		const result = await execa('which', [ command ]);
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

async function setupHook(
	settings: ClaudeSettings,
	hookType: 'PreToolUse' | 'UserPromptSubmit',
	hookPath: string,
): Promise<boolean> {
	if (!settings.hooks![hookType]) {
		settings.hooks![hookType] = [];
	}

	const hasHook = settings.hooks![hookType].some(entry =>
		entry.hooks.some(hook => hook.command === hookPath));

	if (!hasHook) {
		settings.hooks![hookType].push({
			matcher: '.*',
			hooks: [ {
				type: 'command',
				command: hookPath,
			} ],
		});
		return true;
	}

	return false;
}

export async function ensureHookSetup() {
	const claudeDir = path.join(os.homedir(), '.claude');
	const settingsPath = path.join(claudeDir, 'settings.json');

	await fs.mkdir(claudeDir, { recursive: true });

	let settings: ClaudeSettings = {};
	try {
		const content = await fs.readFile(settingsPath, 'utf8');
		settings = claudeSettingsSchema.parse(parseJson(content));
	} catch (error) {
		if (!(isErrnoException(error) && error.code === 'ENOENT')) {
			throw error;
		}
	}

	const [ preToolUsePath, userPromptSubmitPath ] = await Promise.all([
		findHookPath('claudex-hook-pre-tool-use'),
		findHookPath('claudex-hook-user-prompt-submit'),
	]);

	if (!preToolUsePath && !userPromptSubmitPath) {
		return;
	}

	settings.hooks ??= {};
	let needsUpdate = false;

	if (preToolUsePath) {
		needsUpdate = await setupHook(settings, 'PreToolUse', preToolUsePath) || needsUpdate;
	}

	if (userPromptSubmitPath) {
		needsUpdate = await setupHook(settings, 'UserPromptSubmit', userPromptSubmitPath) || needsUpdate;
	}

	if (needsUpdate) {
		await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
	}
}
