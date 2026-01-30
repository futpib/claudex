import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import { execa } from 'execa';
import { paths } from './paths.js';

// Volume can be a simple string (same path for host and container)
// or an object with different paths
const VolumeMountSchema = z.object({
	host: z.string(),
	container: z.string(),
});

const VolumeSchema = z.union([z.string(), VolumeMountSchema]);

const SshConfigSchema = z.object({
	keys: z.array(z.string()).optional(),
	hosts: z.array(z.string()).optional(),
});

// Base config schema - can appear at both root and project level
const BaseConfigSchema = z.object({
	packages: z.array(z.string()).optional(),
	volumes: z.array(VolumeSchema).optional(),
	env: z.record(z.string(), z.string()).optional(),
	ssh: SshConfigSchema.optional(),
	shareVolumes: z.boolean().optional(), // default true - auto-share volumes between group members
	settingSources: z.string().optional(), // default "user,local" - controls --setting-sources flag for Claude Code
});

// Project config can reference a group
const ProjectConfigSchema = BaseConfigSchema.extend({
	group: z.string().optional(),
});

// Root config adds projects mapping and groups
const RootConfigSchema = BaseConfigSchema.extend({
	groups: z.record(z.string(), BaseConfigSchema).optional(),
	projects: z.record(z.string(), ProjectConfigSchema).optional(),
});

export type VolumeMount = z.infer<typeof VolumeMountSchema>;
export type Volume = z.infer<typeof VolumeSchema>;
export type SshConfig = z.infer<typeof SshConfigSchema>;
export type BaseConfig = z.infer<typeof BaseConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type RootConfig = z.infer<typeof RootConfigSchema>;

// Merged config is the same as base config (after merging root + project)
export type ClaudexConfig = BaseConfig;

export function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
}

export function expandPathEnv(value: string): string {
	return value
		.split(':')
		.map(p => expandTilde(p))
		.join(':');
}

export function expandEnvValues(env: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		result[key] = key === 'PATH' ? expandPathEnv(value) : value;
	}
	return result;
}

export function getSshKeys(config: ClaudexConfig): string[] {
	if (!config.ssh?.keys) {
		return [];
	}

	return config.ssh.keys.map(key => expandTilde(key));
}

export function getSshHosts(config: ClaudexConfig): string[] {
	return config.ssh?.hosts ?? [];
}

export async function getFilteredKnownHosts(hosts: string[]): Promise<string> {
	if (hosts.length === 0) {
		return '';
	}

	const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');

	try {
		const content = await fs.readFile(knownHostsPath, 'utf8');
		const lines = content.split('\n');
		const filtered: string[] = [];

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) {
				continue;
			}

			// known_hosts format: hostname[,hostname...] keytype key [comment]
			const firstSpace = trimmed.indexOf(' ');
			if (firstSpace === -1) {
				continue;
			}

			const hostPart = trimmed.substring(0, firstSpace);
			const hostnames = hostPart.split(',');

			// Check if any of the hostnames match our configured hosts
			for (const hostname of hostnames) {
				if (hosts.includes(hostname)) {
					filtered.push(line);
					break;
				}
			}
		}

		return filtered.join('\n') + (filtered.length > 0 ? '\n' : '');
	} catch {
		// known_hosts doesn't exist or can't be read
		return '';
	}
}

export function expandVolumePaths(volume: Volume): VolumeMount {
	if (typeof volume === 'string') {
		const expandedPath = expandTilde(volume);
		return {
			host: expandedPath,
			container: expandedPath,
		};
	}

	return {
		host: expandTilde(volume.host),
		container: expandTilde(volume.container),
	};
}

function sortVolumes(volumes: Volume[]): Volume[] {
	return volumes.slice().sort((a, b) => {
		const aKey = typeof a === 'string' ? a : a.host;
		const bKey = typeof b === 'string' ? b : b.host;
		return aKey.localeCompare(bKey);
	});
}

function sortEnv(env: Record<string, string>): Record<string, string> {
	const sortedKeys = Object.keys(env).sort((a, b) => a.localeCompare(b));
	const sortedEnv: Record<string, string> = {};
	for (const key of sortedKeys) {
		sortedEnv[key] = env[key];
	}
	return sortedEnv;
}

function dedupeStrings(arr: string[]): string[] {
	return [...new Set(arr)];
}

function mergeEnv(base: Record<string, string>, overlay: Record<string, string>): Record<string, string> {
	const result = { ...base, ...overlay };

	// Special handling for PATH: prepend overlay to base
	if (base.PATH && overlay.PATH) {
		result.PATH = `${overlay.PATH}:${base.PATH}`;
	}

	return result;
}

function dedupeVolumes(volumes: Volume[]): Volume[] {
	const seen = new Set<string>();
	const result: Volume[] = [];

	for (const volume of volumes) {
		const hostPath = typeof volume === 'string' ? volume : volume.host;
		if (!seen.has(hostPath)) {
			seen.add(hostPath);
			result.push(volume);
		}
	}

	return result;
}

function mergeBaseConfigs(base: BaseConfig, overlay: BaseConfig): BaseConfig {
	const packages = dedupeStrings([
		...(base.packages ?? []),
		...(overlay.packages ?? []),
	]);

	const volumes = dedupeVolumes([
		...(base.volumes ?? []),
		...(overlay.volumes ?? []),
	]);

	const env = mergeEnv(base.env ?? {}, overlay.env ?? {});

	const sshKeys = dedupeStrings([
		...(base.ssh?.keys ?? []),
		...(overlay.ssh?.keys ?? []),
	]);

	const sshHosts = dedupeStrings([
		...(base.ssh?.hosts ?? []),
		...(overlay.ssh?.hosts ?? []),
	]);

	const hasSsh = sshKeys.length > 0 || sshHosts.length > 0;

	// shareVolumes: overlay takes precedence if defined, otherwise use base
	const shareVolumes = overlay.shareVolumes ?? base.shareVolumes;

	// settingSources: overlay takes precedence if defined, otherwise use base
	const settingSources = overlay.settingSources ?? base.settingSources;

	return {
		packages: packages.length > 0 ? packages : undefined,
		volumes: volumes.length > 0 ? volumes : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
		ssh: hasSsh ? {
			keys: sshKeys.length > 0 ? sshKeys : undefined,
			hosts: sshHosts.length > 0 ? sshHosts : undefined,
		} : undefined,
		shareVolumes,
		settingSources,
	};
}

function mergeConfigs(root: BaseConfig, project: BaseConfig | undefined): ClaudexConfig {
	if (!project) {
		return root;
	}

	return mergeBaseConfigs(root, project);
}

function mergeProjectConfigs(base: ProjectConfig, overlay: ProjectConfig): ProjectConfig {
	const merged = mergeBaseConfigs(base, overlay);
	// Overlay's group takes precedence if specified
	const group = overlay.group ?? base.group;
	return {
		...merged,
		group,
	};
}

function mergeRootConfigs(base: RootConfig, overlay: RootConfig): RootConfig {
	const merged = mergeBaseConfigs(base, overlay);

	// Merge groups: combine keys, merge configs for same group name
	let groups: Record<string, BaseConfig> | undefined;

	if (base.groups || overlay.groups) {
		groups = {};
		const allGroupNames = new Set([
			...Object.keys(base.groups ?? {}),
			...Object.keys(overlay.groups ?? {}),
		]);

		for (const groupName of allGroupNames) {
			const baseGroup = base.groups?.[groupName];
			const overlayGroup = overlay.groups?.[groupName];

			if (baseGroup && overlayGroup) {
				groups[groupName] = mergeBaseConfigs(baseGroup, overlayGroup);
			} else {
				groups[groupName] = (overlayGroup ?? baseGroup)!;
			}
		}
	}

	// Merge projects: combine keys, merge configs for same project path
	let projects: Record<string, ProjectConfig> | undefined;

	if (base.projects || overlay.projects) {
		projects = {};
		const allPaths = new Set([
			...Object.keys(base.projects ?? {}),
			...Object.keys(overlay.projects ?? {}),
		]);

		for (const projectPath of allPaths) {
			const baseProject = base.projects?.[projectPath];
			const overlayProject = overlay.projects?.[projectPath];

			if (baseProject && overlayProject) {
				projects[projectPath] = mergeProjectConfigs(baseProject, overlayProject);
			} else {
				projects[projectPath] = (overlayProject ?? baseProject)!;
			}
		}
	}

	return {
		...merged,
		groups,
		projects,
	};
}

function findMatchingProject(rootConfig: RootConfig, cwd: string): ProjectConfig | undefined {
	if (!rootConfig.projects) {
		return undefined;
	}

	// Find the most specific matching project (longest path prefix)
	let bestMatch: { path: string; config: ProjectConfig } | undefined;

	for (const [projectPath, projectConfig] of Object.entries(rootConfig.projects)) {
		const expandedPath = expandTilde(projectPath);
		if (cwd === expandedPath || cwd.startsWith(expandedPath + '/')) {
			if (!bestMatch || expandedPath.length > bestMatch.path.length) {
				bestMatch = { path: expandedPath, config: projectConfig };
			}
		}
	}

	return bestMatch?.config;
}

function resolveGroup(rootConfig: RootConfig, groupName: string): BaseConfig | undefined {
	return rootConfig.groups?.[groupName];
}

function getGroupSiblingPaths(
	rootConfig: RootConfig,
	groupName: string,
	currentProjectPath: string,
): string[] {
	const siblings: string[] = [];
	for (const [projectPath, projectConfig] of Object.entries(rootConfig.projects ?? {})) {
		if (projectConfig.group === groupName) {
			const expandedPath = expandTilde(projectPath);
			if (expandedPath !== currentProjectPath) {
				siblings.push(expandedPath);
			}
		}
	}
	return siblings;
}

type ReadRootConfigResult = {
	config: RootConfig;
	configFiles: string[];
};

async function readRootConfig(): Promise<ReadRootConfigResult> {
	const configDir = paths.config;
	const configPath = path.join(configDir, 'config.json');
	const configDPath = path.join(configDir, 'config.json.d');

	let merged: RootConfig = {};
	const configFiles: string[] = [];

	// Read main config.json
	try {
		const content = await fs.readFile(configPath, 'utf8');
		merged = RootConfigSchema.parse(JSON.parse(content));
		configFiles.push(configPath);
	} catch {
		// Doesn't exist or invalid
	}

	// Read all .json files from config.json.d/
	try {
		const files = await fs.readdir(configDPath);
		const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

		for (const file of jsonFiles) {
			const filePath = path.join(configDPath, file);
			try {
				const content = await fs.readFile(filePath, 'utf8');
				const parsed = RootConfigSchema.parse(JSON.parse(content));
				merged = mergeRootConfigs(merged, parsed);
				configFiles.push(filePath);
			} catch {
				// Skip invalid files
			}
		}
	} catch {
		// Directory doesn't exist
	}

	return { config: merged, configFiles };
}

async function getGitRoot(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execa('git', ['rev-parse', '--show-toplevel'], { cwd });
		return stdout.trim();
	} catch {
		// Not a git repo
		return undefined;
	}
}

export async function getGitWorktreeParentPath(cwd: string): Promise<string | undefined> {
	try {
		const { stdout: gitCommonDir } = await execa('git', ['rev-parse', '--git-common-dir'], { cwd });
		const { stdout: gitDir } = await execa('git', ['rev-parse', '--git-dir'], { cwd });

		// If they differ, we're in a worktree
		if (gitCommonDir !== gitDir) {
			// gitCommonDir is like /path/to/main/.git, we need /path/to/main
			const absoluteCommonDir = path.resolve(cwd, gitCommonDir);
			return path.dirname(absoluteCommonDir);
		}
	} catch {
		// Not a git repo
	}

	return undefined;
}

function sortConfig(config: ClaudexConfig): ClaudexConfig {
	// Note: shareVolumes is excluded from final output (only used during resolution)
	return {
		packages: config.packages ? [...config.packages].sort((a, b) => a.localeCompare(b)) : undefined,
		volumes: config.volumes ? sortVolumes(config.volumes) : undefined,
		env: config.env ? sortEnv(config.env) : undefined,
		ssh: config.ssh,
		settingSources: config.settingSources,
	};
}

function mergeProjectConfig(
	rootConfig: RootConfig,
	merged: ClaudexConfig,
	projectConfig: ProjectConfig,
): ClaudexConfig {
	// First merge the group config if project references one
	if (projectConfig.group) {
		const groupConfig = resolveGroup(rootConfig, projectConfig.group);
		if (groupConfig) {
			merged = mergeConfigs(merged, groupConfig);
		}
	}

	// Then merge the project-specific config (excluding the group field)
	const { group: _, ...projectBaseConfig } = projectConfig;
	return mergeConfigs(merged, projectBaseConfig);
}

export type MergedConfigResult = {
	config: ClaudexConfig;
	configFiles: string[];
};

export async function getMergedConfig(cwd: string): Promise<MergedConfigResult> {
	const { config: rootConfig, configFiles } = await readRootConfig();

	// Get git-aware paths
	const gitRoot = await getGitRoot(cwd);
	const worktreeParent = await getGitWorktreeParentPath(cwd);

	// Determine resolution path (git root or cwd if not in git)
	const resolutionPath = gitRoot ?? cwd;

	// Build merge chain: root → group → worktree parent → project
	let merged: ClaudexConfig = rootConfig;

	if (worktreeParent) {
		const parentProjectConfig = findMatchingProject(rootConfig, worktreeParent);
		if (parentProjectConfig) {
			merged = mergeProjectConfig(rootConfig, merged, parentProjectConfig);
		}
	}

	const projectConfig = findMatchingProject(rootConfig, resolutionPath);
	if (projectConfig) {
		merged = mergeProjectConfig(rootConfig, merged, projectConfig);
	}

	// Auto-share volumes between group members (shareVolumes defaults to true)
	if (merged.shareVolumes !== false && projectConfig?.group) {
		const siblingPaths = getGroupSiblingPaths(rootConfig, projectConfig.group, resolutionPath);
		if (siblingPaths.length > 0) {
			const siblingVolumes: Volume[] = siblingPaths;
			merged = {
				...merged,
				volumes: dedupeVolumes([
					...(merged.volumes ?? []),
					...siblingVolumes,
				]),
			};
			// Preserve undefined if still empty after deduplication
			if (merged.volumes?.length === 0) {
				merged.volumes = undefined;
			}
		}
	}

	// Sort for consistent Docker cache
	return { config: sortConfig(merged), configFiles };
}

// Legacy function for backward compatibility - deprecated
export async function readConfig(): Promise<MergedConfigResult> {
	return getMergedConfig(process.cwd());
}
