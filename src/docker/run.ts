import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execa, type ResultPromise } from 'execa';
import {
	expandVolumePaths, expandPathEnv,
	resolveEnvFileSources, loadEnvFileSources,
	type Volume, type ClaudexConfig, type LauncherDefinition,
} from '../config/index.js';
import {
	buildAccountMountPlan, combineAccountMountPlans, ensureAccountDirsForSpec,
	effectiveSpecField,
	resolveLauncherSpec, walkSpecWraps,
	type LauncherSpec,
} from '../launchers/registry.js';
import { resolveLauncherOverride } from '../launcher.js';
import { getGitWorktreeParentPath } from '../git.js';
import { getSshKeys, getSshHosts, getFilteredKnownHosts } from '../ssh/known-hosts.js';
import { shieldEnvVars } from '../secrets.js';
import { paths } from '../paths.js';
import { startHostSocketServer } from '../host-socket/server.js';
import { type SshAgentInfo, startSshAgent } from '../ssh/agent.js';
import { startHostPortProxies } from '../port-proxy/host.js';
import {
	ensureDockerImage, getDockerImageMeta,
	refreshDockerImageInBackground,
} from './build.js';

// Path where Claude Code is installed in the Docker container (must match Dockerfile)
const claudeCodeBinPath = '/opt/claude-code/.local/bin';

const defaultPidsLimit = 32_768 / 16;

async function getDockerPidsLimit(): Promise<number> {
	try {
		const content = await fs.readFile('/proc/sys/kernel/pid_max', 'utf8');
		const pidMax = Number.parseInt(content.trim(), 10);
		if (Number.isFinite(pidMax) && pidMax > 0) {
			return Math.max(64, Math.floor(pidMax / 16));
		}
	} catch {
		// Fall back to default
	}

	return defaultPidsLimit;
}

async function isDirectory(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

export function getContainerPrefix(cwd: string): string {
	const cwdBasename = path.basename(cwd);
	return `claudex-${cwdBasename}-`;
}

export async function buildAddDirArgs(config: ClaudexConfig, cwd: string, projectRoot: string, profileVolumes: string[] = []): Promise<string[]> {
	if (config.shareAdditionalDirectories === false || !config.volumes?.length) {
		return [];
	}

	const excludedPaths = new Set([
		cwd,
		projectRoot,
		paths.config,
		paths.data,
		...profileVolumes,
	]);

	const nonExcludedDirs = config.volumes
		.map(volume => expandVolumePaths(volume).container)
		.filter(dir => !excludedPaths.has(dir));

	const isDirResults = await Promise.all(nonExcludedDirs.map(async dir => isDirectory(dir)));
	const additionalDirs = nonExcludedDirs.filter((_, i) => isDirResults[i]);

	return additionalDirs.flatMap(dir => [
		'--add-dir',
		dir,
		'--allowedTools',
		`Read(${dir}/**)`,
	]);
}

function parseVolumeSpec(spec: string): Volume {
	if (spec.includes(':')) {
		const [ host, container ] = spec.split(':', 2);
		return { host, container };
	}

	return spec;
}

function parseEnvSpec(spec: string): [string, string] {
	const idx = spec.indexOf('=');
	if (idx === -1) {
		// Shorthand: FOO → FOO=${FOO}
		return [ spec, `\${${spec}}` ];
	}

	return [ spec.slice(0, idx), spec.slice(idx + 1) ];
}

export type DockerRunResult = {
	childProcess: ResultPromise;
	containerName: string;
	sshAgent: SshAgentInfo | undefined;
	hostSocket: { socketPath: string; cleanup: () => Promise<void> } | undefined;
	cleanupHostPortProxies: (() => void) | undefined;
};

export async function runDockerContainer(parameters: {
	cwd: string;
	config: ClaudexConfig;
	account: string | undefined;
	profileVolumes: string[];
	launcherDef: LauncherDefinition | undefined;
	launcherName: string | undefined;
	launcherDefinitions: Record<string, LauncherDefinition> | undefined;
	cliPackages: string[];
	cliVolumes: string[];
	cliEnv: string[];
	cliEnvFiles: string[];
	cliEnvMode: 'all' | 'explicit' | undefined;
	cliSshKeys: string[];
	cliModel: string | undefined;
	dockerSudo: boolean;
	dockerInsecure: boolean;
	cliDockerArgs: string[];
	useDockerShell: boolean;
	dockerPull: boolean;
	dockerNoCache: boolean;
	dockerSkipBuild: boolean;
	claudeArgs: string[];
	cliInDockerPath: string;
}): Promise<DockerRunResult> {
	const {
		cwd, account, profileVolumes, launcherDef, launcherName, launcherDefinitions, cliPackages, cliVolumes, cliEnv, cliEnvFiles, cliEnvMode, cliSshKeys,
		cliModel, dockerSudo, dockerInsecure, cliDockerArgs, useDockerShell, dockerPull, dockerNoCache, dockerSkipBuild, claudeArgs, cliInDockerPath,
	} = parameters;
	const config = { ...parameters.config };

	// Merge launcher definition's base config fields into the final config
	if (launcherDef) {
		const { command: _, model: _m, ...launcherBase } = launcherDef;
		if (launcherBase.packages?.length) {
			config.packages = [ ...(config.packages ?? []), ...launcherBase.packages ].sort((a, b) => a.localeCompare(b));
		}

		if (launcherBase.volumes?.length) {
			config.volumes = [ ...(config.volumes ?? []), ...launcherBase.volumes ];
		}

		if (launcherBase.hostPorts?.length) {
			config.hostPorts = [ ...new Set([ ...(config.hostPorts ?? []), ...launcherBase.hostPorts ]) ].sort((a, b) => a - b);
		}

		if (launcherBase.env) {
			config.env = { ...config.env, ...launcherBase.env };
		}

		if (launcherBase.ssh) {
			config.ssh ??= {};
			if (launcherBase.ssh.keys?.length) {
				config.ssh.keys = [ ...(config.ssh.keys ?? []), ...launcherBase.ssh.keys ];
			}

			if (launcherBase.ssh.hosts?.length) {
				config.ssh.hosts = [ ...(config.ssh.hosts ?? []), ...launcherBase.ssh.hosts ];
			}
		}

		if (launcherBase.extraHosts) {
			config.extraHosts = { ...config.extraHosts, ...launcherBase.extraHosts };
		}

		if (launcherBase.rootInitCommands?.length) {
			config.rootInitCommands = [ ...(config.rootInitCommands ?? []), ...launcherBase.rootInitCommands ];
		}

		if (launcherBase.userInitCommands?.length) {
			config.userInitCommands = [ ...(config.userInitCommands ?? []), ...launcherBase.userInitCommands ];
		}

		if (launcherBase.rootStartupCommands?.length) {
			config.rootStartupCommands = [ ...(config.rootStartupCommands ?? []), ...launcherBase.rootStartupCommands ];
		}

		if (launcherBase.userStartupCommands?.length) {
			config.userStartupCommands = [ ...(config.userStartupCommands ?? []), ...launcherBase.userStartupCommands ];
		}
	}

	// Merge CLI flags with config
	if (cliPackages?.length) {
		config.packages = [ ...(config.packages ?? []), ...cliPackages ];
	}

	if (cliVolumes?.length) {
		const parsedVolumes = cliVolumes.map(spec => parseVolumeSpec(spec));
		config.volumes = [ ...(config.volumes ?? []), ...parsedVolumes ];
	}

	if (cliEnv?.length) {
		config.env ??= {};
		for (const spec of cliEnv) {
			const [ key, value ] = parseEnvSpec(spec);
			config.env[key] = value;
		}
	}

	if (cliSshKeys?.length) {
		config.ssh ??= {};
		config.ssh.keys = [ ...(config.ssh.keys ?? []), ...cliSshKeys ];
	}

	// Resolve companion launchers (config.launchers): contribute packages and
	// account-aware mounts only — never hooks/MCP/permissions, which belong to
	// the primary. Skip names already in the primary's wraps chain so we don't
	// reinstall packages or add overlapping mounts.
	const primarySpec: LauncherSpec = resolveLauncherSpec(launcherName ?? 'claude', launcherDefinitions);
	const primaryNames = new Set(walkSpecWraps(primarySpec).map(s => s.name));
	const companionSpecs: LauncherSpec[] = (config.launchers ?? [])
		.filter(name => !primaryNames.has(name))
		.map(name => resolveLauncherSpec(name, launcherDefinitions));

	for (const compSpec of companionSpecs) {
		if (compSpec.packages?.length) {
			config.packages = [ ...(config.packages ?? []), ...compSpec.packages ];
		}
	}

	// Print packages
	if (config.packages && config.packages.length > 0) {
		console.error('Packages:');
		for (const pkg of config.packages) {
			console.error(`  ${pkg}`);
		}
	}

	let projectRoot: string;
	let imageName: string;
	if (dockerSkipBuild) {
		({ projectRoot, imageName } = getDockerImageMeta(cwd));
	} else {
		const result = await ensureDockerImage(cwd, config, dockerPull, dockerNoCache);
		({ projectRoot, imageName } = result);
		void refreshDockerImageInBackground(cwd, config);
	}

	const randomSuffix = Math.random().toString(36).slice(2, 8);
	const containerName = `${getContainerPrefix(cwd)}${randomSuffix}`;
	const spec: LauncherSpec = resolveLauncherSpec(launcherName ?? 'claude', undefined);
	await ensureAccountDirsForSpec(spec, account);
	const primaryMountPlan = buildAccountMountPlan(spec, account);

	const companionMountPlans: Array<typeof primaryMountPlan> = [];
	for (const compSpec of companionSpecs) {
		// eslint-disable-next-line no-await-in-loop
		await ensureAccountDirsForSpec(compSpec, account);
		companionMountPlans.push(buildAccountMountPlan(compSpec, account));
	}

	const accountMountPlan = companionMountPlans.length > 0
		? combineAccountMountPlans([ primaryMountPlan, ...companionMountPlans ])
		: primaryMountPlan;

	const dockerArgs = [
		'run',
		'-d',
		'-it',
		'--log-driver=none',
		...(dockerSudo || dockerInsecure ? [] : [ '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges' ]),
		...(dockerInsecure || config.dockerIpcPrivate === false ? [] : [ '--ipc=private' ]),
		...(dockerInsecure || config.dockerPidsLimit === false ? [] : [ '--pids-limit', String(await getDockerPidsLimit()) ]),
		...cliDockerArgs,
		'--name',
		containerName,
		'-v',
		`${cwd}:${cwd}`,
		...accountMountPlan.dockerArgs,
		'-v',
		`${projectRoot}:${projectRoot}`,
		'-v',
		`${paths.config}:${paths.config}`,
		'-v',
		`${paths.data}:${paths.data}`,
	];

	// Detect git worktree and mount parent repo if needed
	const worktreeParentPath = await getGitWorktreeParentPath(cwd);
	if (worktreeParentPath) {
		dockerArgs.push('-v', `${worktreeParentPath}:${worktreeParentPath}`);
	}

	// Add volumes from config
	if (config.volumes && config.volumes.length > 0) {
		console.error('Volumes:');
		for (const volume of config.volumes) {
			const expandedVolume = expandVolumePaths(volume);
			const volumeSpec = expandedVolume.host === expandedVolume.container
				? expandedVolume.host
				: `${expandedVolume.host}:${expandedVolume.container}`;
			console.error(`  ${volumeSpec}`);
			dockerArgs.push('-v', `${expandedVolume.host}:${expandedVolume.container}`);
		}
	}

	// Load env-file values; these override process.env for ${VAR} resolution.
	const envFileSources = await resolveEnvFileSources({
		envFile: config.envFile,
		envFiles: config.envFiles,
		cliEnvFiles,
		cwd,
	});

	if (envFileSources.length > 0) {
		console.error('Env files:');
		for (const source of envFileSources) {
			console.error(`  ${source.path}${source.optional ? ' (optional)' : ''}`);
		}
	}

	const envFileValues = await loadEnvFileSources(envFileSources);
	const envLookup: Record<string, string | undefined> = { ...process.env, ...envFileValues };

	function resolveEnvEntry(key: string, value: string): string | undefined {
		const match = /^\${(.+)}$/.exec(value);
		if (match) {
			const hostVarName = match[1];
			return envLookup[hostVarName];
		}

		return key === 'PATH' ? expandPathEnv(value) : value;
	}

	const envMode = cliEnvMode ?? config.envMode ?? 'explicit';

	// Resolve environment variables from config
	const resolvedEnv: Record<string, string> = {};

	// In 'all' mode, every env-file value gets passed to the container as a
	// baseline; explicit config.env / launcherOverride.env entries layer on top.
	if (envMode === 'all') {
		for (const [ key, value ] of Object.entries(envFileValues)) {
			resolvedEnv[key] = key === 'PATH' ? expandPathEnv(value) : value;
		}
	}

	if (config.env) {
		for (const [ key, value ] of Object.entries(config.env)) {
			const resolved = resolveEnvEntry(key, value);
			if (resolved !== undefined) {
				resolvedEnv[key] = resolved;
			}
		}
	}

	// Apply the active launcher's env override (includes claude-fallback for
	// claude-wrapping launchers like `ollama launch X`).
	const launcherOverride = resolveLauncherOverride(config.launcherOverrides, launcherName, launcherDef);
	if (launcherOverride.env) {
		for (const [ key, value ] of Object.entries(launcherOverride.env)) {
			const resolved = resolveEnvEntry(key, value);
			if (resolved !== undefined) {
				resolvedEnv[key] = resolved;
			}
		}
	}

	// Print env overrides (with secrets shielded)
	if (Object.keys(resolvedEnv).length > 0) {
		console.error('Environment overrides:');
		const shieldedEntries = await shieldEnvVars(resolvedEnv);
		for (const entry of shieldedEntries) {
			console.error(`  ${entry}`);
		}
	}

	// Ensure Claude Code bin path is always first in PATH
	const basePath = resolvedEnv.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
	resolvedEnv.PATH = `${claudeCodeBinPath}:${basePath}`;

	// Enable truecolor support for Claude Code's terminal UI
	resolvedEnv.COLORTERM = 'truecolor';

	// Add environment variables to docker args
	for (const [ key, value ] of Object.entries(resolvedEnv)) {
		dockerArgs.push('-e', `${key}=${value}`);
	}

	// Start SSH agent with configured keys
	const sshKeys = getSshKeys(config);
	const sshAgent = await startSshAgent(sshKeys);
	if (sshAgent) {
		dockerArgs.push('-v', `${sshAgent.socketPath}:/ssh-agent`, '-e', 'SSH_AUTH_SOCK=/ssh-agent');
	}

	// Start host socket server (extensible channel for notifications, etc.)
	const hostSocket = await startHostSocketServer();
	dockerArgs.push('-v', `${hostSocket.socketPath}:/claudex-host.sock`, '-e', 'CLAUDEX_HOST_SOCKET=/claudex-host.sock');

	// Get filtered known_hosts content for configured SSH hosts
	// Include [localhost]:PORT entries for each host port
	const sshHosts = [
		...getSshHosts(config),
		...(config.hostPorts ?? []).map(port => `[localhost]:${port}`),
	];
	const knownHostsContent = await getFilteredKnownHosts(sshHosts);
	if (knownHostsContent) {
		dockerArgs.push('-e', `CLAUDEX_KNOWN_HOSTS_CONTENT=${knownHostsContent}`);
	}

	// Configure host port forwarding via socat
	let cleanupHostPortProxies: (() => void) | undefined;
	if (config.hostPorts && config.hostPorts.length > 0) {
		// Start host-side proxies so containers can reach localhost-only services
		// via host.docker.internal (bridges Docker gateway IP → 127.0.0.1)
		cleanupHostPortProxies = await startHostPortProxies(config.hostPorts);
		dockerArgs.push('--add-host', 'host.docker.internal:host-gateway', '-e', `CLAUDEX_HOST_PORTS=${config.hostPorts.join(',')}`);
	}

	// Add extra host entries to container /etc/hosts
	if (config.extraHosts && Object.keys(config.extraHosts).length > 0) {
		console.error('Extra hosts:');
		for (const [ hostname, ip ] of Object.entries(config.extraHosts)) {
			dockerArgs.push('--add-host', `${hostname}:${ip}`);
			console.error(`  ${hostname} → ${ip}`);
		}
	}

	// Pass launcher config into container via env vars
	if (launcherDef) {
		dockerArgs.push('-e', `CLAUDEX_LAUNCHER_COMMAND=${JSON.stringify(launcherDef.command)}`);
		const launcherModel = cliModel ?? launcherDef.model;
		if (launcherModel) {
			dockerArgs.push('-e', `CLAUDEX_LAUNCHER_MODEL=${launcherModel}`);
		}
	}

	if (launcherName) {
		dockerArgs.push('-e', `CLAUDEX_LAUNCHER_NAME=${launcherName}`);
	}

	// Pass user startup commands via env var for in-docker.ts to handle
	if (config.userStartupCommands && config.userStartupCommands.length > 0) {
		dockerArgs.push('-e', `CLAUDEX_USER_STARTUP_COMMANDS=${JSON.stringify(config.userStartupCommands)}`);
	}

	dockerArgs.push('-w', cwd);

	const cliFeatures = effectiveSpecField(spec, 'cliFeatures');
	const claudeSpecificArgs: string[] = [];
	if (cliFeatures?.settingSources) {
		const settingSources = config.settingSources ?? 'user,local';
		console.error(`Setting sources: ${settingSources}`);
		claudeSpecificArgs.push('--setting-sources', settingSources);
	}

	if (cliFeatures?.addDir) {
		const addDirArgs = await buildAddDirArgs(config, cwd, projectRoot, profileVolumes);
		claudeSpecificArgs.push(...addDirArgs);
	}

	// Build the real entrypoint command that will ultimately become PID 1
	let realEntrypointCmd: string;
	if (useDockerShell) {
		realEntrypointCmd = 'exec bash';
	} else {
		const entrypointArgs = [ cliInDockerPath, 'in-docker', ...claudeSpecificArgs, ...claudeArgs ];
		const escapedArgs = entrypointArgs.map(a => `'${a.replaceAll('\'', String.raw`'\''`)}'`).join(' ');
		realEntrypointCmd = `exec node ${escapedArgs}`;
	}

	// PID 1 blocks on FIFO read, then exec's the command written to it
	dockerArgs.push('--entrypoint', 'sh', imageName, '-c', 'mkfifo /tmp/.claudex-cmd && IFS= read -r cmd < /tmp/.claudex-cmd && exec sh -c "$cmd"');

	// Step 1: Start container in detached mode — PID 1 blocks on FIFO
	const runResult = await execa('docker', dockerArgs, {
		stderr: process.stderr,
	});
	const containerId = runResult.stdout.trim();
	console.error(`Container: ${containerName} (${containerId.slice(0, 12)})`);

	// Step 2: Run root startup commands via docker exec
	if (config.rootStartupCommands && config.rootStartupCommands.length > 0) {
		for (const cmd of config.rootStartupCommands) {
			// eslint-disable-next-line no-await-in-loop
			await execa(
				'docker',
				[
					'exec',
					'--privileged',
					'--user',
					'root',
					containerName,
					'sh',
					'-c',
					cmd,
				],
				{
					stdout: process.stdout,
					stderr: process.stderr,
				},
			);
		}
	}

	// Step 3: Write the real entrypoint command to the FIFO — PID 1 exec's into it
	await execa('docker', [
		'exec',
		containerName,
		'sh',
		'-c',
		`echo '${realEntrypointCmd.replaceAll('\'', String.raw`'\''`)}' > /tmp/.claudex-cmd`,
	]);

	// Step 4: Attach to the container (stdin/stdout now connected to the real process)
	const childProcess = execa('docker', [ 'attach', containerName ], {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	});

	return {
		childProcess, containerName, sshAgent, hostSocket, cleanupHostPortProxies,
	};
}
