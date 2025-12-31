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
});

// Base config schema - can appear at both root and project level
const BaseConfigSchema = z.object({
	packages: z.array(z.string()).optional(),
	volumes: z.array(VolumeSchema).optional(),
	env: z.record(z.string(), z.string()).optional(),
	ssh: SshConfigSchema.optional(),
});

// Root config adds projects mapping
const RootConfigSchema = BaseConfigSchema.extend({
	projects: z.record(z.string(), BaseConfigSchema).optional(),
});

export type VolumeMount = z.infer<typeof VolumeMountSchema>;
export type Volume = z.infer<typeof VolumeSchema>;
export type SshConfig = z.infer<typeof SshConfigSchema>;
export type BaseConfig = z.infer<typeof BaseConfigSchema>;
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

	return {
		packages: packages.length > 0 ? packages : undefined,
		volumes: volumes.length > 0 ? volumes : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
		ssh: sshKeys.length > 0 ? { keys: sshKeys } : undefined,
	};
}

function mergeConfigs(root: BaseConfig, project: BaseConfig | undefined): ClaudexConfig {
	if (!project) {
		return root;
	}

	return mergeBaseConfigs(root, project);
}

function mergeRootConfigs(base: RootConfig, overlay: RootConfig): RootConfig {
	const merged = mergeBaseConfigs(base, overlay);

	// Merge projects: combine keys, merge configs for same project path
	let projects: Record<string, BaseConfig> | undefined;

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
				projects[projectPath] = mergeBaseConfigs(baseProject, overlayProject);
			} else {
				projects[projectPath] = (overlayProject ?? baseProject)!;
			}
		}
	}

	return {
		...merged,
		projects,
	};
}

function findMatchingProject(rootConfig: RootConfig, cwd: string): BaseConfig | undefined {
	if (!rootConfig.projects) {
		return undefined;
	}

	// Find the most specific matching project (longest path prefix)
	let bestMatch: { path: string; config: BaseConfig } | undefined;

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

async function readRootConfig(): Promise<RootConfig> {
	const configDir = paths.config;
	const configPath = path.join(configDir, 'config.json');
	const configDPath = path.join(configDir, 'config.json.d');

	let merged: RootConfig = {};

	// Read main config.json
	try {
		const content = await fs.readFile(configPath, 'utf8');
		merged = RootConfigSchema.parse(JSON.parse(content));
	} catch {
		// Doesn't exist or invalid
	}

	// Read all .json files from config.json.d/
	try {
		const files = await fs.readdir(configDPath);
		const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

		for (const file of jsonFiles) {
			try {
				const content = await fs.readFile(path.join(configDPath, file), 'utf8');
				const parsed = RootConfigSchema.parse(JSON.parse(content));
				merged = mergeRootConfigs(merged, parsed);
			} catch {
				// Skip invalid files
			}
		}
	} catch {
		// Directory doesn't exist
	}

	return merged;
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
	return {
		packages: config.packages ? [...config.packages].sort((a, b) => a.localeCompare(b)) : undefined,
		volumes: config.volumes ? sortVolumes(config.volumes) : undefined,
		env: config.env ? sortEnv(config.env) : undefined,
		ssh: config.ssh,
	};
}

export async function getMergedConfig(cwd: string): Promise<ClaudexConfig> {
	const rootConfig = await readRootConfig();

	// Get git-aware paths
	const gitRoot = await getGitRoot(cwd);
	const worktreeParent = await getGitWorktreeParentPath(cwd);

	// Determine resolution path (git root or cwd if not in git)
	const resolutionPath = gitRoot ?? cwd;

	// Build merge chain: root → parent repo → git root
	let merged: ClaudexConfig = rootConfig;

	if (worktreeParent) {
		const parentProjectConfig = findMatchingProject(rootConfig, worktreeParent);
		if (parentProjectConfig) {
			merged = mergeConfigs(merged, parentProjectConfig);
		}
	}

	const projectConfig = findMatchingProject(rootConfig, resolutionPath);
	if (projectConfig) {
		merged = mergeConfigs(merged, projectConfig);
	}

	// Sort for consistent Docker cache
	return sortConfig(merged);
}

// Legacy function for backward compatibility - deprecated
export async function readConfig(): Promise<ClaudexConfig> {
	return getMergedConfig(process.cwd());
}
