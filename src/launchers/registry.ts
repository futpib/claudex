import path from 'node:path';
import fs from 'node:fs/promises';
import { expandTilde } from '../utils.js';
import { paths } from '../paths.js';
import type { LauncherDefinition } from '../config/schema.js';

// A single bind mount that participates in the launcher's account isolation.
// In no-account mode, host and container paths are both expanded and mounted
// at the launcher-native location. In account mode, the host path comes from
// ~/.claudex/accounts/<name>/<dirName>/<accountSubpath>.
export type LauncherAccountMount = {
	host: string;
	container: string;
	accountSubpath?: string;
	containerEnvVar?: string;
};

export type LauncherAccount = {
	dirName: string;
	mounts: LauncherAccountMount[];
	extraDefaultMounts?: Array<{ host: string; container: string }>;
};

export type LauncherPermissionFlags = {
	dangerouslySkip?: string;
	allowDangerouslySkip?: string;
};

export type LauncherCliFeatures = {
	settingSources?: boolean;
	addDir?: boolean;
};

export type LauncherHookStrategy = 'claude-settings' | 'opencode-plugin' | 'codex-hooks-json' | 'none';
export type LauncherMcpWiring = 'claude-json' | 'opencode-config' | 'codex-config' | 'none';

// Internal behavior metadata for a built-in launcher. Not user-configurable.
export type LauncherSpec = {
	name: string;
	command: string[];
	model?: string;
	packages?: string[];
	volumes?: string[];
	hostPorts?: number[];

	wraps?: string;
	isBareCommand?: boolean;

	account?: LauncherAccount;

	permissionFlags?: LauncherPermissionFlags;
	cliFeatures?: LauncherCliFeatures;

	hookStrategy?: LauncherHookStrategy;
	mcpWiring?: LauncherMcpWiring;
};

export const launcherRegistry: Record<string, LauncherSpec> = {
	claude: {
		name: 'claude',
		command: [ 'claude' ],
		isBareCommand: true,
		account: {
			dirName: 'claude',
			mounts: [
				{ host: '~/.claude', container: '~/.claude', containerEnvVar: 'CLAUDE_CONFIG_DIR' },
			],
			extraDefaultMounts: [
				{ host: '~/.claude.json', container: '~/.claude.json' },
			],
		},
		permissionFlags: {
			dangerouslySkip: '--dangerously-skip-permissions',
			allowDangerouslySkip: '--allow-dangerously-skip-permissions',
		},
		cliFeatures: {
			settingSources: true,
			addDir: true,
		},
		hookStrategy: 'claude-settings',
		mcpWiring: 'claude-json',
	},
	opencode: {
		name: 'opencode',
		command: [ 'opencode' ],
		isBareCommand: true,
		account: {
			dirName: 'opencode',
			// Config mount comes first so getAccountPrimaryDir() returns the
			// directory that holds opencode.json (config), not the state dir.
			mounts: [
				{ host: '~/.config/opencode', container: '~/.config/opencode', accountSubpath: 'config' },
				{ host: '~/.local/share/opencode', container: '~/.local/share/opencode', accountSubpath: 'data' },
			],
		},
		hookStrategy: 'opencode-plugin',
		mcpWiring: 'opencode-config',
	},
	ollama: {
		name: 'ollama',
		command: [ 'ollama', 'launch', 'claude' ],
		packages: [ 'ollama' ],
		hostPorts: [ 11_434 ],
		wraps: 'claude',
	},
	codex: {
		name: 'codex',
		command: [ 'codex' ],
		packages: [ 'openai-codex' ],
		isBareCommand: true,
		account: {
			dirName: 'codex',
			mounts: [
				{ host: '~/.codex', container: '~/.codex', containerEnvVar: 'CODEX_HOME' },
			],
		},
		permissionFlags: {
			dangerouslySkip: '--dangerously-bypass-approvals-and-sandbox',
		},
		hookStrategy: 'codex-hooks-json',
		mcpWiring: 'codex-config',
	},
};

// Retrieve a built-in spec, or synthesize a minimal one for a name only known
// via user config (so user-defined launchers still flow through the registry).
export function getLauncherSpec(name: string | undefined): LauncherSpec | undefined {
	if (!name) {
		return undefined;
	}

	const builtin = launcherRegistry[name];
	if (builtin) {
		return builtin;
	}

	return { name, command: [ name ] };
}

// Walk the spec and its wraps chain (outer → wrapped).
export function walkSpecWraps(spec: LauncherSpec): LauncherSpec[] {
	const chain: LauncherSpec[] = [];
	const seen = new Set<string>();
	let current: LauncherSpec | undefined = spec;
	while (current && !seen.has(current.name)) {
		seen.add(current.name);
		chain.push(current);
		current = current.wraps ? launcherRegistry[current.wraps] : undefined;
	}

	return chain;
}

// Look up a behavior field, walking the wraps chain so ollama → claude inherits.
export function effectiveSpecField<K extends keyof LauncherSpec>(
	spec: LauncherSpec,
	key: K,
): LauncherSpec[K] | undefined {
	for (const s of walkSpecWraps(spec)) {
		const value = s[key];
		if (value !== undefined) {
			return value;
		}
	}

	return undefined;
}

// Built-in launcher definitions derived from the registry, in the shape the
// rest of the codebase (schema, merge, docker/run) still expects.
function deriveBuiltinDefinition(spec: LauncherSpec): LauncherDefinition {
	const def: LauncherDefinition = {
		command: spec.command,
	};

	if (spec.model !== undefined) {
		def.model = spec.model;
	}

	if (spec.packages?.length) {
		def.packages = spec.packages;
	}

	if (spec.volumes?.length) {
		def.volumes = spec.volumes;
	}

	if (spec.hostPorts?.length) {
		def.hostPorts = spec.hostPorts;
	}

	return def;
}

export const builtinLauncherDefinitions: Record<string, LauncherDefinition>
	= Object.fromEntries(Object.entries(launcherRegistry).map(([ name, spec ]) => [ name, deriveBuiltinDefinition(spec) ]));

// Resolve a name + user-supplied definitions into a concrete spec whose
// infrastructure fields (command, packages, volumes, hostPorts) reflect the
// user's overrides. Behavior fields (account, hookStrategy, …) come from the
// registry and are not user-overridable.
export function resolveLauncherSpec(
	name: string,
	configDefs: Record<string, LauncherDefinition> | undefined,
): LauncherSpec {
	const baseSpec = launcherRegistry[name];
	const configDef = configDefs?.[name];

	if (!baseSpec && !configDef) {
		throw new Error(`Unknown launcher: ${name}`);
	}

	const spec: LauncherSpec = baseSpec ? { ...baseSpec } : { name, command: [ name ] };

	if (configDef) {
		if (configDef.command !== undefined) {
			spec.command = configDef.command;
		}

		if (configDef.model !== undefined) {
			spec.model = configDef.model;
		}

		if (configDef.packages !== undefined) {
			spec.packages = configDef.packages;
		}

		if (configDef.volumes !== undefined) {
			// Config.volumes can include VolumeMount objects; registry volumes is
			// purely string-based. Only carry forward string volumes; richer
			// specs live on the user's own config.volumes.
			spec.volumes = configDef.volumes.filter((v): v is string => typeof v === 'string');
		}

		if (configDef.hostPorts !== undefined) {
			spec.hostPorts = configDef.hostPorts;
		}
	}

	return spec;
}

function expandPath(value: string): string {
	return expandTilde(value);
}

export function getAccountsRoot(): string {
	return path.join(paths.config, 'accounts');
}

export type AccountMountPlan = {
	dockerArgs: string[];
	envVars: Record<string, string>;
	dirsToCreate: string[];
};

// Build docker -v/-e flags for a launcher's account-sensitive config paths,
// walking the wraps chain so ollama inherits claude's mounts.
export function buildAccountMountPlan(
	spec: LauncherSpec,
	account: string | undefined,
): AccountMountPlan {
	const dockerArgs: string[] = [];
	const envVars: Record<string, string> = {};
	const dirsToCreate: string[] = [];
	const accountsRoot = getAccountsRoot();

	for (const s of walkSpecWraps(spec)) {
		if (!s.account) {
			continue;
		}

		if (account) {
			const accountDir = path.join(accountsRoot, account, s.account.dirName);
			for (const mount of s.account.mounts) {
				const hostDir = mount.accountSubpath
					? path.join(accountDir, mount.accountSubpath)
					: accountDir;
				dirsToCreate.push(hostDir);
				if (mount.containerEnvVar) {
					dockerArgs.push('-v', `${hostDir}:${hostDir}`, '-e', `${mount.containerEnvVar}=${hostDir}`);
					envVars[mount.containerEnvVar] = hostDir;
				} else {
					dockerArgs.push('-v', `${hostDir}:${expandPath(mount.container)}`);
				}
			}
		} else {
			for (const mount of s.account.mounts) {
				const hostPath = expandPath(mount.host);
				const containerPath = expandPath(mount.container);
				dirsToCreate.push(hostPath);
				dockerArgs.push('-v', `${hostPath}:${containerPath}`);
			}

			for (const extra of s.account.extraDefaultMounts ?? []) {
				dockerArgs.push('-v', `${expandPath(extra.host)}:${expandPath(extra.container)}`);
			}
		}
	}

	return { dockerArgs, envVars, dirsToCreate };
}

// Return the host directory where the given account's primary state for this
// launcher lives (the dir with dirName, or the first mount's path for
// multi-mount launchers). Used for callers that need "the claude config dir"
// for an account (MCP wiring, memory writing).
export function getAccountPrimaryDir(
	spec: LauncherSpec,
	account: string | undefined,
): string | undefined {
	for (const s of walkSpecWraps(spec)) {
		if (!s.account) {
			continue;
		}

		if (account) {
			const accountDir = path.join(getAccountsRoot(), account, s.account.dirName);
			const firstMount = s.account.mounts[0];
			if (firstMount?.accountSubpath) {
				return path.join(accountDir, firstMount.accountSubpath);
			}

			return accountDir;
		}

		const firstMount = s.account.mounts[0];
		if (firstMount) {
			return expandPath(firstMount.host);
		}
	}

	return undefined;
}

export async function ensureAccountDirsForSpec(
	spec: LauncherSpec,
	account: string | undefined,
): Promise<void> {
	const { dirsToCreate } = buildAccountMountPlan(spec, account);
	for (const dir of dirsToCreate) {
		// eslint-disable-next-line no-await-in-loop
		await fs.mkdir(dir, { recursive: true });
	}
}
