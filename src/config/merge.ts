import process from 'node:process';
import { expandTilde } from '../utils.js';
import { getGitRoot, getGitWorktreeParentPath } from '../git.js';
import { allConfigKeys } from '../hooks/rules/index.js';
import { expandVolumePaths } from './expand.js';
import { readRootConfig } from './io.js';
import {
	resolveHooks, resolveMcpServers, allMcpServerFlags,
	type BaseConfig, type ClaudexConfig, type HooksConfig, type HooksDetail,
	type LauncherDefinition, type McpServersConfig, type McpServersDetail,
	type ProjectConfig, type RootConfig, type Volume,
} from './schema.js';

function sortVolumes(volumes: Volume[]): Volume[] {
	return [ ...volumes ].sort((a, b) => {
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

function dedupeStrings(array: string[]): string[] {
	return [ ...new Set(array) ];
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

function mergeHooksConfigs(base: HooksConfig | undefined, overlay: HooksConfig | undefined): HooksConfig | undefined {
	if (base === undefined && overlay === undefined) {
		return undefined;
	}

	const baseResolved = resolveHooks(base);
	const overlayResolved = overlay === undefined
		? Object.fromEntries(allConfigKeys.map(k => [ k, undefined ]))
		: resolveHooks(overlay);

	const merged: Record<string, boolean> = {};
	for (const key of allConfigKeys) {
		merged[key] = (overlayResolved as Record<string, boolean | undefined>)[key] ?? (baseResolved as Record<string, boolean | undefined>)[key] ?? false;
	}

	return merged as HooksDetail;
}

function mergeMcpServersConfigs(base: McpServersConfig | undefined, overlay: McpServersConfig | undefined): McpServersConfig | undefined {
	if (base === undefined && overlay === undefined) {
		return undefined;
	}

	const baseResolved = resolveMcpServers(base);
	const overlayResolved = overlay === undefined
		? Object.fromEntries(allMcpServerFlags.map(k => [ k, undefined ]))
		: resolveMcpServers(overlay);

	const merged: Record<string, boolean> = {};
	for (const key of allMcpServerFlags) {
		merged[key] = (overlayResolved as Record<string, boolean | undefined>)[key] ?? baseResolved[key];
	}

	return merged as McpServersDetail;
}

export function mergeBaseConfigs(base: BaseConfig, overlay: BaseConfig): BaseConfig {
	const profiles = dedupeStrings([
		...(base.profiles ?? []),
		...(overlay.profiles ?? []),
	]);

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

	const hostPorts = [ ...new Set([
		...(base.hostPorts ?? []),
		...(overlay.hostPorts ?? []),
	]) ];

	const extraHosts = {
		...base.extraHosts,
		...overlay.extraHosts,
	};

	// ShareVolumes: overlay takes precedence if defined, otherwise use base
	const shareVolumes = overlay.shareVolumes ?? base.shareVolumes;

	// ShareAdditionalDirectories: overlay takes precedence if defined, otherwise use base
	const shareAdditionalDirectories = overlay.shareAdditionalDirectories ?? base.shareAdditionalDirectories;

	// SettingSources: overlay takes precedence if defined, otherwise use base
	const settingSources = overlay.settingSources ?? base.settingSources;

	// Hooks: merge detail objects per-key, overlay wins
	const hooks = mergeHooksConfigs(base.hooks, overlay.hooks);

	// McpServers: merge detail objects per-key, overlay wins
	const mcpServers = mergeMcpServersConfigs(base.mcpServers, overlay.mcpServers);

	// Notifications: overlay takes precedence if defined, otherwise use base
	const notifications = overlay.notifications ?? base.notifications;

	// HooksDescriptions: overlay takes precedence if defined, otherwise use base
	const hooksDescriptions = overlay.hooksDescriptions ?? base.hooksDescriptions;

	// Launcher: overlay takes precedence if defined, otherwise use base
	const launcher = overlay.launcher ?? base.launcher;

	// DockerDangerouslySkipPermissions: overlay takes precedence if defined, otherwise use base
	const dockerDangerouslySkipPermissions = overlay.dockerDangerouslySkipPermissions ?? base.dockerDangerouslySkipPermissions;

	// DockerAllowDangerouslySkipPermissions: overlay takes precedence if defined, otherwise use base
	const dockerAllowDangerouslySkipPermissions = overlay.dockerAllowDangerouslySkipPermissions ?? base.dockerAllowDangerouslySkipPermissions;

	const dockerIpcPrivate = overlay.dockerIpcPrivate ?? base.dockerIpcPrivate;

	const dockerPidsLimit = overlay.dockerPidsLimit ?? base.dockerPidsLimit;

	return {
		profiles: profiles.length > 0 ? profiles : undefined,
		packages: packages.length > 0 ? packages : undefined,
		volumes: volumes.length > 0 ? volumes : undefined,
		env: Object.keys(env).length > 0 ? env : undefined,
		ssh: hasSsh
			? {
				keys: sshKeys.length > 0 ? sshKeys : undefined,
				hosts: sshHosts.length > 0 ? sshHosts : undefined,
			}
			: undefined,
		hostPorts: hostPorts.length > 0 ? hostPorts : undefined,
		extraHosts: Object.keys(extraHosts).length > 0 ? extraHosts : undefined,
		shareVolumes,
		shareAdditionalDirectories,
		settingSources,
		hooks,
		mcpServers,
		notifications,
		hooksDescriptions,
		launcher,
		dockerDangerouslySkipPermissions,
		dockerAllowDangerouslySkipPermissions,
		dockerIpcPrivate,
		dockerPidsLimit,
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

function extractBaseConfig(root: RootConfig): BaseConfig {
	const { groupDefinitions: _, projects: _p, profileDefinitions: _pr, launcherDefinitions: _ld, ...base } = root;
	return base;
}

export function mergeRootConfigs(base: RootConfig, overlay: RootConfig): RootConfig {
	const merged = mergeBaseConfigs(extractBaseConfig(base), extractBaseConfig(overlay));

	// Merge profile definitions: combine keys, merge configs for same profile name
	let profileDefinitions: Record<string, BaseConfig> | undefined;

	if (base.profileDefinitions ?? overlay.profileDefinitions) {
		profileDefinitions = {};
		const allProfileNames = new Set([
			...Object.keys(base.profileDefinitions ?? {}),
			...Object.keys(overlay.profileDefinitions ?? {}),
		]);

		for (const profileName of allProfileNames) {
			const baseProfile = (base.profileDefinitions)?.[profileName];
			const overlayProfile = (overlay.profileDefinitions)?.[profileName];

			profileDefinitions[profileName] = baseProfile && overlayProfile ? mergeBaseConfigs(baseProfile, overlayProfile) : (overlayProfile ?? baseProfile)!;
		}
	}

	// Merge group definitions: combine keys, merge configs for same group name
	let groupDefinitions: Record<string, BaseConfig> | undefined;

	if (base.groupDefinitions ?? overlay.groupDefinitions) {
		groupDefinitions = {};
		const allGroupNames = new Set([
			...Object.keys(base.groupDefinitions ?? {}),
			...Object.keys(overlay.groupDefinitions ?? {}),
		]);

		for (const groupName of allGroupNames) {
			const baseGroup = base.groupDefinitions?.[groupName];
			const overlayGroup = overlay.groupDefinitions?.[groupName];

			groupDefinitions[groupName] = baseGroup && overlayGroup ? mergeBaseConfigs(baseGroup, overlayGroup) : (overlayGroup ?? baseGroup)!;
		}
	}

	// Merge projects: combine keys, merge configs for same project path
	let projects: Record<string, ProjectConfig> | undefined;

	if (base.projects ?? overlay.projects) {
		projects = {};
		const allPaths = new Set([
			...Object.keys(base.projects ?? {}),
			...Object.keys(overlay.projects ?? {}),
		]);

		for (const projectPath of allPaths) {
			const baseProject = base.projects?.[projectPath];
			const overlayProject = overlay.projects?.[projectPath];

			projects[projectPath] = baseProject && overlayProject ? mergeProjectConfigs(baseProject, overlayProject) : (overlayProject ?? baseProject)!;
		}
	}

	// Merge launcher definitions: combine keys, overlay wins for same launcher name
	let launcherDefinitions: Record<string, LauncherDefinition> | undefined;

	if (base.launcherDefinitions ?? overlay.launcherDefinitions) {
		launcherDefinitions = {};
		const allLauncherNames = new Set([
			...Object.keys(base.launcherDefinitions ?? {}),
			...Object.keys(overlay.launcherDefinitions ?? {}),
		]);

		for (const launcherName of allLauncherNames) {
			const baseLauncher = base.launcherDefinitions?.[launcherName];
			const overlayLauncher = overlay.launcherDefinitions?.[launcherName];

			if (baseLauncher && overlayLauncher) {
				const { command: _bc, model: _bm, ...baseBase } = baseLauncher;
				const { command: _oc, model: _om, ...overlayBase } = overlayLauncher;
				const mergedBase = mergeBaseConfigs(baseBase, overlayBase);
				launcherDefinitions[launcherName] = {
					...mergedBase,
					command: overlayLauncher.command ?? baseLauncher.command,
					model: overlayLauncher.model ?? baseLauncher.model,
				};
			} else {
				launcherDefinitions[launcherName] = (overlayLauncher ?? baseLauncher)!;
			}
		}
	}

	return {
		...merged,
		profileDefinitions,
		groupDefinitions,
		projects,
		launcherDefinitions,
	};
}

function findMatchingProject(rootConfig: RootConfig, cwd: string): ProjectConfig | undefined {
	if (!rootConfig.projects) {
		return undefined;
	}

	// Find the most specific matching project (longest path prefix)
	let bestMatch: { path: string; config: ProjectConfig } | undefined;

	for (const [ projectPath, projectConfig ] of Object.entries(rootConfig.projects)) {
		const expandedPath = expandTilde(projectPath);
		if ((cwd === expandedPath || cwd.startsWith(expandedPath + '/')) && (!bestMatch || expandedPath.length > bestMatch.path.length)) {
			bestMatch = { path: expandedPath, config: projectConfig };
		}
	}

	return bestMatch?.config;
}

function resolveGroup(rootConfig: RootConfig, groupName: string): BaseConfig | undefined {
	return rootConfig.groupDefinitions?.[groupName];
}

function getGroupSiblingPaths(
	rootConfig: RootConfig,
	groupName: string,
	currentProjectPath: string,
): string[] {
	const siblings: string[] = [];
	for (const [ projectPath, projectConfig ] of Object.entries(rootConfig.projects ?? {})) {
		if (projectConfig.group === groupName) {
			const expandedPath = expandTilde(projectPath);
			if (expandedPath !== currentProjectPath) {
				siblings.push(expandedPath);
			}
		}
	}

	return siblings;
}

function sortConfig(config: ClaudexConfig): ClaudexConfig {
	// Note: shareVolumes is excluded from final output (only used during resolution)
	return {
		packages: config.packages ? [ ...config.packages ].sort((a, b) => a.localeCompare(b)) : undefined,
		volumes: config.volumes ? sortVolumes(config.volumes) : undefined,
		env: config.env ? sortEnv(config.env) : undefined,
		ssh: config.ssh,
		hostPorts: config.hostPorts ? [ ...config.hostPorts ].sort((a, b) => a - b) : undefined,
		extraHosts: config.extraHosts ? sortEnv(config.extraHosts) : undefined,
		settingSources: config.settingSources,
		hooks: config.hooks,
		mcpServers: config.mcpServers,
		notifications: config.notifications,
		hooksDescriptions: config.hooksDescriptions,
		launcher: config.launcher,
		dockerDangerouslySkipPermissions: config.dockerDangerouslySkipPermissions,
		dockerAllowDangerouslySkipPermissions: config.dockerAllowDangerouslySkipPermissions,
		dockerIpcPrivate: config.dockerIpcPrivate,
		dockerPidsLimit: config.dockerPidsLimit,
		// Profiles references are consumed during resolution and not carried to final output
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

function resolveProfiles(
	rootConfig: RootConfig,
	merged: ClaudexConfig,
): { config: ClaudexConfig; profileVolumes: string[] } {
	const profileNames = merged.profiles;
	if (!profileNames || profileNames.length === 0) {
		return { config: merged, profileVolumes: [] };
	}

	const { profileDefinitions } = rootConfig;
	if (!profileDefinitions) {
		return { config: merged, profileVolumes: [] };
	}

	// Merge all referenced profiles into a single base config
	let profilesMerged: BaseConfig = {};
	for (const name of profileNames) {
		const profile = profileDefinitions[name];
		if (profile) {
			profilesMerged = mergeBaseConfigs(profilesMerged, profile);
		}
	}

	// Collect profile volumes (expanded container paths)
	const profileVolumes: string[] = [];
	if (profilesMerged.volumes) {
		for (const volume of profilesMerged.volumes) {
			const expanded = expandVolumePaths(volume);
			profileVolumes.push(expanded.container);
		}
	}

	// Apply profiles first, then overlay the explicit config on top
	// This way explicit project/group fields override profile defaults
	const { profiles: _, ...mergedWithoutProfiles } = merged;
	const result = mergeBaseConfigs(profilesMerged, mergedWithoutProfiles);

	return { config: result, profileVolumes };
}

export type MergedConfigResult = {
	config: ClaudexConfig;
	configFiles: string[];
	profileVolumes: string[];
	launcherDefinitions: Record<string, LauncherDefinition> | undefined;
	group: string | undefined;
};

// Legacy function for backward compatibility - deprecated
export async function readConfig(): Promise<MergedConfigResult> {
	return getMergedConfig(process.cwd());
}

export async function getMergedConfig(cwd: string): Promise<MergedConfigResult> {
	const { config: rootConfig, configFiles } = await readRootConfig();

	// Expand tilde in cwd so that git operations and path comparisons work correctly
	const expandedCwd = expandTilde(cwd);

	// Get git-aware paths
	const gitRoot = await getGitRoot(expandedCwd);
	const worktreeParent = await getGitWorktreeParentPath(expandedCwd);

	// Determine resolution path (git root or cwd if not in git)
	const resolutionPath = gitRoot ?? expandedCwd;

	// Build merge chain: root → group → worktree parent → project
	let merged: ClaudexConfig = extractBaseConfig(rootConfig);

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

	// Resolve profile references into the merged config
	const { config: resolvedConfig, profileVolumes } = resolveProfiles(rootConfig, merged);
	merged = resolvedConfig;

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
	return {
		config: sortConfig(merged),
		configFiles,
		profileVolumes,
		launcherDefinitions: rootConfig.launcherDefinitions,
		group: projectConfig?.group,
	};
}
