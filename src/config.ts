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

function mergeConfigs(root: BaseConfig, project: BaseConfig | undefined): ClaudexConfig {
	if (!project) {
		return root;
	}

	const packages = dedupeStrings([
		...(root.packages ?? []),
		...(project.packages ?? []),
	]);

	const volumes = dedupeVolumes([
		...(root.volumes ?? []),
		...(project.volumes ?? []),
	]);

	const env = {
		...(root.env ?? {}),
		...(project.env ?? {}),
	};

	const sshKeys = dedupeStrings([
		...(root.ssh?.keys ?? []),
		...(project.ssh?.keys ?? []),
	]);

	return {
		packages: packages.length > 0 ? packages : undefined,
		volumes: volumes.length > 0 ? volumes : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
		ssh: sshKeys.length > 0 ? { keys: sshKeys } : undefined,
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
	const configPath = path.join(paths.config, 'config.json');

	try {
		const configContent = await fs.readFile(configPath, 'utf8');
		const parsed = JSON.parse(configContent) as unknown;
		return RootConfigSchema.parse(parsed);
	} catch {
		// Return defaults if config doesn't exist or is invalid
		return {};
	}
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
