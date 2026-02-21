import { z } from 'zod';
import { allRules, allConfigKeys, extraConfigEntries } from '../hooks/rules/index.js';

// Volume can be a simple string (same path for host and container)
// or an object with different paths
const volumeMountSchema = z.object({
	host: z.string(),
	container: z.string(),
});

const volumeSchema = z.union([ z.string(), volumeMountSchema ]);

const sshConfigSchema = z.object({
	keys: z.array(z.string()).optional(),
	hosts: z.array(z.string()).optional(),
});

const hooksDetailConfigSchema = z.object(Object.fromEntries(allConfigKeys.map(key => [ key, z.boolean().optional() ]))) as z.ZodObject<Record<string, z.ZodOptional<z.ZodBoolean>>>;

const hooksConfigSchema = z.union([ z.literal(true), hooksDetailConfigSchema ]);

const mcpServersDetailConfigSchema = z.object({
	claudex: z.boolean().optional(),
});

const mcpServersConfigSchema = z.union([ z.literal(true), mcpServersDetailConfigSchema ]);

// Base config schema - can appear at both root and project level
export const baseConfigSchema = z.object({
	packages: z.array(z.string()).optional(),
	volumes: z.array(volumeSchema).optional(),
	env: z.record(z.string(), z.string()).optional(),
	ssh: sshConfigSchema.optional(),
	hostPorts: z.array(z.number().int().positive()).optional(),
	extraHosts: z.record(z.string(), z.string()).optional(),
	shareVolumes: z.boolean().optional(), // Default true - auto-share volumes between group members
	shareAdditionalDirectories: z.boolean().optional(), // Default true - auto-pass --add-dir for configured volumes
	settingSources: z.string().optional(), // Default "user,local" - controls --setting-sources flag for Claude Code
	hooks: hooksConfigSchema.optional(),
	mcpServers: mcpServersConfigSchema.optional(),
	notifications: z.boolean().optional(),
	hooksDescriptions: z.boolean().optional(), // Default true - inject active hook rule descriptions into CLAUDE.md
	profiles: z.array(z.string()).optional(), // References to named profiles defined at root level
	launcher: z.string().optional(), // Name of launcher to use (e.g. "ollama")
});

// Launcher definition schema - extends base config with launcher-specific fields
const launcherDefinitionSchema = baseConfigSchema.extend({
	command: z.array(z.string()),
	model: z.string().optional(),
});

// Project config can reference a group
const projectConfigSchema = baseConfigSchema.extend({
	group: z.string().optional(),
});

// Root config adds projects mapping, group definitions, profile definitions, and launcher definitions
export const rootConfigSchema = baseConfigSchema.extend({
	groupDefinitions: z.record(z.string(), baseConfigSchema).optional(),
	projects: z.record(z.string(), projectConfigSchema).optional(),
	profileDefinitions: z.record(z.string(), baseConfigSchema).optional(),
	launcherDefinitions: z.record(z.string(), launcherDefinitionSchema).optional(),
});

export type VolumeMount = z.infer<typeof volumeMountSchema>;
export type Volume = z.infer<typeof volumeSchema>;
export type SshConfig = z.infer<typeof sshConfigSchema>;
export type HooksDetail = z.infer<typeof hooksDetailConfigSchema>;
export type HooksConfig = z.infer<typeof hooksConfigSchema>;
export type McpServersDetail = z.infer<typeof mcpServersDetailConfigSchema>;
export type McpServersConfig = z.infer<typeof mcpServersConfigSchema>;
export type BaseConfig = z.infer<typeof baseConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type RootConfig = z.infer<typeof rootConfigSchema>;
export type LauncherDefinition = z.infer<typeof launcherDefinitionSchema>;

export const builtinLauncherDefinitions: Record<string, LauncherDefinition> = {
	claude: {
		command: [ 'claude' ],
	},
	ollama: {
		command: [ 'ollama', 'launch', 'claude' ],
		packages: [ 'ollama' ],
		hostPorts: [ 11_434 ],
	},
};

// Merged config is the same as base config (after merging root + project)
export type ClaudexConfig = BaseConfig;

export const allMcpServerFlags: Array<keyof McpServersDetail> = [
	'claudex',
];

export const validTopLevelKeys = new Set(Object.keys(baseConfigSchema.shape));

export const fixedSubKeyFields: Record<string, Set<string>> = {
	hooks: new Set(allConfigKeys),
	mcpServers: new Set(allMcpServerFlags),
	ssh: new Set([ 'keys', 'hosts' ]),
};

export const recordFields = new Set([ 'env', 'extraHosts' ]);

export function resolveHooks(hooks: HooksConfig | undefined): Required<HooksDetail> {
	if (hooks === true) {
		return Object.fromEntries([
			...allRules.map(r => [ r.meta.configKey, r.meta.recommended ]),
			...extraConfigEntries.map(entry => [ entry.configKey, entry.recommended ]),
		]) as Required<HooksDetail>;
	}

	if (!hooks) {
		return Object.fromEntries([
			...allRules.map(r => [ r.meta.configKey, r.meta.recommended ]),
			...extraConfigEntries.map(entry => [ entry.configKey, entry.recommended ]),
		]) as Required<HooksDetail>;
	}

	return Object.fromEntries(allConfigKeys.map(k => [ k, hooks[k] ?? false ])) as Required<HooksDetail>;
}

export function resolveMcpServers(mcpServers: McpServersConfig | undefined): Required<McpServersDetail> {
	if (mcpServers === true) {
		return Object.fromEntries(allMcpServerFlags.map(k => [ k, true ])) as Required<McpServersDetail>;
	}

	if (!mcpServers) {
		return Object.fromEntries(allMcpServerFlags.map(k => [ k, false ])) as Required<McpServersDetail>;
	}

	return Object.fromEntries(allMcpServerFlags.map(k => [ k, mcpServers[k] ?? false ])) as Required<McpServersDetail>;
}
