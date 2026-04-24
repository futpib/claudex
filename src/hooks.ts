/* eslint-disable @typescript-eslint/naming-convention */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { execa } from 'execa';
import invariant from 'invariant';
import toml from '@iarna/toml';
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
		PostToolUse: z.array(hookGroupSchema).optional(),
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
	hookType: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Notification' | 'Stop',
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
	const hookTypes = [ 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop' ] as const;
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
	needsUpdate = await setupHook(settings, 'PostToolUse', hookCommand(claudexPath, 'post-tool-use')) || needsUpdate;
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

export function buildMcpServerCommand(projectRoot: string): { command: string; args: string[] } {
	return {
		command: 'node',
		args: [ path.join(projectRoot, 'build', 'mcp', 'cli.js') ],
	};
}

export async function ensureOpencodeMcpConfig(configDir: string, projectRoot: string) {
	await fs.mkdir(configDir, { recursive: true });
	const configPath = path.join(configDir, 'opencode.json');

	let existing: Record<string, unknown> = {};
	try {
		const content = await fs.readFile(configPath, 'utf8');
		try {
			existing = parseJson(content) as Record<string, unknown>;
		} catch {
			console.warn(`Warning: ${configPath} contains invalid JSON; overwriting.`);
		}
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	const mcp = (existing.mcp ?? {}) as Record<string, unknown>;
	const { command, args } = buildMcpServerCommand(projectRoot);
	mcp.claudex = {
		type: 'local',
		command: [ command, ...args ],
	};
	existing.mcp = mcp;

	await fs.writeFile(configPath, JSON.stringify(existing, null, 2));
}

// Codex hook events (matches https://developers.openai.com/codex/hooks).
const codexHookEvents = [
	'SessionStart',
	'PreToolUse',
	'PostToolUse',
	'UserPromptSubmit',
	'PermissionRequest',
	'Stop',
] as const;

// Map each codex event to claudex's `claudex hook <name>` dispatcher.
const codexEventToClaudexHook: Record<typeof codexHookEvents[number], string> = {
	SessionStart: 'session-start',
	PreToolUse: 'pre-tool-use',
	PostToolUse: 'post-tool-use',
	UserPromptSubmit: 'user-prompt-submit',
	PermissionRequest: 'notification',
	Stop: 'stop',
};

type CodexHookEntry = {
	type: string;
	command: string;
};

type CodexHookGroup = {
	matcher?: string;
	hooks: CodexHookEntry[];
};

type CodexHooksFile = {
	hooks?: Partial<Record<typeof codexHookEvents[number], CodexHookGroup[]>>;
};

async function upsertCodexConfigToml(
	codexDir: string,
	mutate: (config: Record<string, unknown>) => void,
): Promise<void> {
	await fs.mkdir(codexDir, { recursive: true });
	const configPath = path.join(codexDir, 'config.toml');

	let parsed: Record<string, unknown> = {};
	try {
		const content = await fs.readFile(configPath, 'utf8');
		try {
			parsed = toml.parse(content) as Record<string, unknown>;
		} catch (error) {
			console.warn(`Warning: ${configPath} is not valid TOML; rewriting. (${error instanceof Error ? error.message : String(error)})`);
		}
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	mutate(parsed);
	await fs.writeFile(configPath, toml.stringify(parsed as toml.JsonMap));
}

export async function ensureCodexHookSetup(codexDir: string) {
	await fs.mkdir(codexDir, { recursive: true });
	const hooksPath = path.join(codexDir, 'hooks.json');

	let existing: CodexHooksFile = {};
	try {
		const content = await fs.readFile(hooksPath, 'utf8');
		try {
			existing = parseJson(content) as CodexHooksFile;
		} catch {
			console.warn(`Warning: ${hooksPath} contains invalid JSON; overwriting.`);
		}
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	const claudexPath = await findClaudexPath();
	invariant(claudexPath, 'claudex executable must be found');

	existing.hooks ??= {};
	for (const event of codexHookEvents) {
		const groups = existing.hooks[event] ?? [];
		const claudexCommand = hookCommand(claudexPath, codexEventToClaudexHook[event]);

		// Drop any previous claudex-owned entries, keeping user-added ones.
		const userGroups = groups
			.map(group => ({
				...group,
				hooks: group.hooks.filter(h => !h.command.startsWith(`${claudexPath} hook `)),
			}))
			.filter(group => group.hooks.length > 0);

		userGroups.push({
			matcher: '.*',
			hooks: [ { type: 'command', command: claudexCommand } ],
		});
		existing.hooks[event] = userGroups;
	}

	await fs.writeFile(hooksPath, JSON.stringify(existing, null, 2));

	await upsertCodexConfigToml(codexDir, config => {
		const features = (config.features ?? {}) as Record<string, unknown>;
		features.codex_hooks = true;
		config.features = features;
	});
}

export async function ensureCodexMcpConfig(codexDir: string, projectRoot: string) {
	const { command, args } = buildMcpServerCommand(projectRoot);
	await upsertCodexConfigToml(codexDir, config => {
		const servers = (config.mcp_servers ?? {}) as Record<string, unknown>;
		servers.claudex = {
			command,
			args,
		};
		config.mcp_servers = servers;
	});
}
