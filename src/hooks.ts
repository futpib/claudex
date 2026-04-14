/* eslint-disable @typescript-eslint/naming-convention */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { execa } from 'execa';
import invariant from 'invariant';
import { isErrnoException, parseJson } from './utils.js';

export const hookEntrySchema = z.object({
	type: z.string(),
	command: z.string(),
});

export const hookGroupSchema = z.object({
	matcher: z.string(),
	hooks: z.array(hookEntrySchema),
});

export const claudeSettingsSchema = z.object({
	includeCoAuthoredBy: z.boolean().optional(),
	hooks: z.object({
		PreToolUse: z.array(hookGroupSchema).optional(),
		UserPromptSubmit: z.array(hookGroupSchema).optional(),
		Notification: z.array(hookGroupSchema).optional(),
		Stop: z.array(hookGroupSchema).optional(),
	}).optional(),
}).loose();

type ClaudeSettings = z.infer<typeof claudeSettingsSchema>;

async function findClaudexPath(): Promise<string> {
	const result = await execa('which', [ 'claudex' ]);
	return result.stdout.trim();
}

function hookCommand(claudexPath: string, hookName: string): string {
	return `${claudexPath} hook ${hookName}`;
}

async function setupHook(
	settings: ClaudeSettings,
	hookType: 'PreToolUse' | 'UserPromptSubmit' | 'Notification' | 'Stop',
	command: string,
): Promise<boolean> {
	if (!settings.hooks![hookType]) {
		settings.hooks![hookType] = [];
	}

	const hasHook = settings.hooks![hookType].some(entry =>
		entry.hooks.some(hook => hook.command === command));

	if (!hasHook) {
		settings.hooks![hookType].push({
			matcher: '.*',
			hooks: [ {
				type: 'command',
				command,
			} ],
		});
		return true;
	}

	return false;
}

function removeOldHooks(settings: ClaudeSettings): boolean {
	if (!settings.hooks) {
		return false;
	}

	let removed = false;
	const hookTypes = [ 'PreToolUse', 'UserPromptSubmit', 'Notification', 'Stop' ] as const;
	for (const hookType of hookTypes) {
		const groups = settings.hooks[hookType];
		if (!groups) {
			continue;
		}

		for (const group of groups) {
			const before = group.hooks.length;
			group.hooks = group.hooks.filter(hook =>
				!hook.command.includes('claudex-hook-'));
			if (group.hooks.length < before) {
				removed = true;
			}
		}

		settings.hooks[hookType] = groups.filter(g => g.hooks.length > 0);
	}

	return removed;
}

function applyClaudeSettingsOverlay(
	settings: ClaudeSettings,
	overlay: Record<string, unknown> | undefined,
): boolean {
	if (!overlay) {
		return false;
	}

	const record = settings as Record<string, unknown>;
	let changed = false;
	for (const [ key, value ] of Object.entries(overlay)) {
		// Skip `hooks` — claudex manages that key, overriding it would clobber the setup below
		if (key === 'hooks') {
			continue;
		}

		if (JSON.stringify(record[key]) !== JSON.stringify(value)) {
			record[key] = value;
			changed = true;
		}
	}

	return changed;
}

export async function ensureHookSetup(
	claudeConfigDir?: string,
	claudeSettingsOverlay?: Record<string, unknown>,
) {
	const claudeDir = claudeConfigDir ?? path.join(os.homedir(), '.claude');
	const settingsPath = path.join(claudeDir, 'settings.json');

	await fs.mkdir(claudeDir, { recursive: true });

	let settings: ClaudeSettings = {};
	let content: string;
	try {
		content = await fs.readFile(settingsPath, 'utf8');
	} catch (error: unknown) {
		if (isErrnoException(error) && error.code === 'ENOENT') {
			content = '{}';
		} else {
			throw error;
		}
	}

	settings = claudeSettingsSchema.parse(parseJson(content));

	const claudexPath = await findClaudexPath();
	invariant(claudexPath, 'claudex executable must be found');

	settings.hooks ??= {};
	let needsUpdate = removeOldHooks(settings);

	needsUpdate = applyClaudeSettingsOverlay(settings, claudeSettingsOverlay) || needsUpdate;

	needsUpdate = await setupHook(settings, 'PreToolUse', hookCommand(claudexPath, 'pre-tool-use')) || needsUpdate;
	needsUpdate = await setupHook(settings, 'UserPromptSubmit', hookCommand(claudexPath, 'user-prompt-submit')) || needsUpdate;
	needsUpdate = await setupHook(settings, 'Notification', hookCommand(claudexPath, 'notification')) || needsUpdate;
	needsUpdate = await setupHook(settings, 'Stop', hookCommand(claudexPath, 'stop')) || needsUpdate;

	if (needsUpdate) {
		await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
	}
}

export async function ensureOpenCodePluginSetup() {
	const pluginsDir = path.join(os.homedir(), '.config', 'opencode', 'plugins');
	await fs.mkdir(pluginsDir, { recursive: true });

	const buildDir = path.dirname(fileURLToPath(import.meta.url));
	const pluginSource = path.join(buildDir, 'opencode-plugin.js');
	const pluginLink = path.join(pluginsDir, 'claudex.js');

	try {
		await fs.unlink(pluginLink);
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	await fs.symlink(pluginSource, pluginLink);
}
