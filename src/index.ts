import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa, type ResultPromise } from 'execa';
import { Command } from 'commander';
import { z } from 'zod';
import { createClaudeCodeMemory } from './memory.js';
import { ensureHookSetup } from './hooks.js';
import { paths } from './paths.js';
import {
	getMergedConfig, expandVolumePaths, getSshKeys, getSshHosts, getFilteredKnownHosts, getGitWorktreeParentPath, expandPathEnv, resolveHooks, resolveMcpServers, type Volume, type ClaudexConfig,
} from './config.js';
import { shieldEnvVars } from './secrets.js';
import { configMain } from './config-cli.js';
import { startHostSocketServer } from './host-socket/server.js';

// Path where Claude Code is installed in the Docker container (must match Dockerfile)
const claudeCodeBinPath = '/opt/claude-code/.local/bin';

async function isDirectory(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath);
		return stat.isDirectory();
	} catch {
		return false;
	}
}

async function buildAddDirArgs(config: ClaudexConfig, cwd: string, projectRoot: string, profileVolumes: string[] = []): Promise<string[]> {
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

type SshAgentInfo = {
	socketPath: string;
	pid: string;
	cleanup: () => Promise<void>;
};

async function startSshAgent(keys: string[]): Promise<SshAgentInfo | undefined> {
	if (keys.length === 0) {
		return undefined;
	}

	// Start ssh-agent and parse its output
	const agentResult = await execa('ssh-agent', [ '-s' ]);
	const output = agentResult.stdout;

	const socketMatch = /SSH_AUTH_SOCK=([^;]+)/.exec(output);
	const pidMatch = /SSH_AGENT_PID=(\d+)/.exec(output);

	if (!socketMatch || !pidMatch) {
		console.error('Failed to parse ssh-agent output');
		return undefined;
	}

	const socketPath = socketMatch[1];
	const pid = pidMatch[1];

	// Add keys to the agent

	for (const key of keys) {
		try {
			// eslint-disable-next-line no-await-in-loop
			await execa('ssh-add', [ key ], {
				// eslint-disable-next-line @typescript-eslint/naming-convention
				env: { ...process.env, SSH_AUTH_SOCK: socketPath },
			});
		} catch (error) {
			console.error(`Failed to add SSH key ${key}:`, error instanceof Error ? error.message : error);
		}
	}

	const cleanup = async () => {
		try {
			await execa('kill', [ pid ]);
		} catch {
			// Agent may already be dead
		}
	};

	return { socketPath, pid, cleanup };
}

async function ensureMcpServerConfig(projectRoot: string) {
	const claudeJsonPath = path.join(os.homedir(), '.claude.json');
	let config: Record<string, unknown> = {};

	try {
		const content = await fs.readFile(claudeJsonPath, 'utf8');
		config = JSON.parse(content) as Record<string, unknown>;
	} catch {
		// File doesn't exist or invalid JSON
	}

	const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;
	const serverPath = path.join(projectRoot, 'build', 'mcp', 'cli.js');

	mcpServers.claudex = {
		command: 'node',
		args: [ serverPath ],
	};

	config.mcpServers = mcpServers;
	await fs.writeFile(claudeJsonPath, JSON.stringify(config, null, 2));
}

async function ensureDockerImage(cwd: string, config: ClaudexConfig, pull = false, noCache = false) {
	const userInfo = os.userInfo();
	const userId = userInfo.uid;
	const { username } = userInfo;

	const currentFileUrl = import.meta.url;
	const currentFilePath = fileURLToPath(currentFileUrl);
	const projectRoot = path.resolve(path.dirname(currentFilePath), '..');
	const dockerfilePath = path.join(projectRoot, 'Dockerfile');

	const cwdBasename = path.basename(cwd);

	const imageName = `claudex-${cwdBasename}`.toLowerCase();

	// Always build image (Docker cache makes this fast if nothing changed)
	const buildArgs = [
		'build',
	];

	if (pull) {
		buildArgs.push('--pull');
	}

	if (noCache) {
		buildArgs.push('--no-cache');
	}

	buildArgs.push(
		'--build-arg',
		`USER_ID=${userId}`,
		'--build-arg',
		`USERNAME=${username}`,
	);

	if (config.packages && config.packages.length > 0) {
		buildArgs.push('--build-arg', `PACKAGES=${config.packages.join(' ')}`);
	}

	buildArgs.push('-t', imageName, '-');

	const dockerfileContent = await fs.readFile(dockerfilePath, 'utf8');

	await execa('docker', buildArgs, {
		input: dockerfileContent,
		stdout: process.stdout,
		stderr: process.stderr,
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			DOCKER_BUILDKIT: '1',
		},
	});

	return {
		userId, username, projectRoot, imageName,
	};
}

async function isUnsafeDirectory(dir: string): Promise<{ unsafe: boolean; reason: string }> {
	const homeDir = os.homedir();
	const userInfo = os.userInfo();

	// Check if it's the home directory itself
	if (dir === homeDir) {
		return { unsafe: true, reason: 'home directory' };
	}

	// Check if it's a hidden directory in home (e.g., ~/.config, ~/.ssh)
	if (dir.startsWith(homeDir + '/.')) {
		return { unsafe: true, reason: 'hidden directory in home' };
	}

	// Check if directory is owned by current user
	try {
		const stat = await fs.stat(dir);
		if (stat.uid !== userInfo.uid) {
			return { unsafe: true, reason: 'directory not owned by current user' };
		}
	} catch {
		// If we can't stat, consider it unsafe
		return { unsafe: true, reason: 'cannot access directory' };
	}

	// Check if directory contains .git
	try {
		await fs.access(path.join(dir, '.git'));
	} catch {
		return { unsafe: true, reason: 'directory does not contain .git' };
	}

	return { unsafe: false, reason: '' };
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

function collect(value: string, previous: string[]) {
	return [ ...previous, value ];
}

type MainOptions = {
	docker: boolean;
	dockerShell: boolean;
	dockerExec: boolean;
	dockerPull: boolean;
	dockerNoCache: boolean;
	dockerSudo: boolean;
	allowUnsafeDirectory: boolean;
	package: string[];
	volume: string[];
	env: string[];
	sshKey: string[];
};

export async function main() {
	const program = new Command('claudex')
		.option('--no-docker', 'Run Claude Code directly on the host instead of in Docker')
		.option('--docker-shell', 'Launch a bash shell inside the Docker container')
		.option('--docker-exec', 'Exec into a running claudex container for current directory')
		.option('--docker-pull', 'Pull the latest base image when building')
		.option('--docker-no-cache', 'Build the Docker image without cache')
		.option('--docker-sudo', 'Allow sudo inside the container (less secure)')
		.option('--allow-unsafe-directory', 'Skip directory safety checks (home, hidden, unowned, no .git)')
		.option('--package <name>', 'Add apt package to install in Docker (repeatable)', collect, [])
		.option('--volume <spec>', 'Add volume mount: path or host:container (repeatable)', collect, [])
		// eslint-disable-next-line no-template-curly-in-string
		.option('--env <spec>', 'Add env var: KEY=value or KEY for KEY=${KEY} (repeatable)', collect, [])
		.option('--ssh-key <path>', 'Add SSH key to agent (repeatable)', collect, [])
		.allowUnknownOption()
		.passThroughOptions()
		.argument('[claude-args...]')
		.action(async (claudeArgs: string[], options: MainOptions) => {
			await runMain(claudeArgs, options);
		});

	const configCommand = program
		.command('config')
		.description('Manage claudex configuration')
		.enablePositionalOptions();

	const scopeOptions = (cmd: Command) => cmd
		.option('--global', 'Use global config (default)')
		.option('--project <path>', 'Use project-scoped config')
		.option('--group <name>', 'Use group-scoped config')
		.option('--profile <name>', 'Use profile-scoped config')
		.option('--file <path>', 'Write to a specific file in config.json.d')
		.passThroughOptions();

	const configAction = async (...actionArgs: unknown[]) => {
		// Commander passes parsed args then options then the Command object.
		// Reconstruct the raw argv that configMain expects from the Command.
		const cmd = actionArgs.at(-1) as Command;
		const rawArgs = cmd.parent!.args;
		try {
			await configMain(rawArgs);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	};

	scopeOptions(configCommand.command('list').description('List merged configuration as JSON'))
		.option('--members', 'List project paths belonging to the group (requires --group)')
		.action(configAction);

	scopeOptions(configCommand.command('get').description('Get a configuration value').argument('<key>'))
		.action(configAction);

	scopeOptions(configCommand.command('set').description('Set a configuration value').argument('<key>').argument('<value>'))
		.action(configAction);

	scopeOptions(configCommand.command('add').description('Append value(s) to an array field').argument('<key>').argument('<values...>'))
		.action(configAction);

	scopeOptions(configCommand.command('remove').description('Remove a value from an array or record field').argument('<key>').argument('[value]'))
		.action(configAction);

	scopeOptions(configCommand.command('unset').description('Remove a key or a specific value from an array').argument('<key>').argument('[value]'))
		.action(configAction);

	configCommand.command('keys').description('List available configuration keys and their types')
		.action(configAction);

	configCommand.command('group').description('Assign projects to a group')
		.argument('<name>', 'Group name')
		.argument('<paths...>', 'Project paths to assign')
		.option('--file <path>', 'Write to a specific file in config.json.d')
		.passThroughOptions()
		.action(configAction);

	configCommand.command('ungroup').description('Remove group assignment from projects')
		.argument('<paths...>', 'Project paths to ungroup')
		.option('--file <path>', 'Write to a specific file in config.json.d')
		.passThroughOptions()
		.action(configAction);

	await program.parseAsync(process.argv);
}

async function runMain(claudeArgs: string[], options: MainOptions) {
	const {
		docker: useDocker,
		dockerShell: useDockerShell,
		dockerExec: useDockerExec,
		dockerPull,
		dockerNoCache,
		dockerSudo,
		allowUnsafeDirectory,
		package: cliPackages,
		volume: cliVolumes,
		env: cliEnv,
		sshKey: cliSshKeys,
	} = options;

	// Read config early for hook/mcp gating
	const earlyConfig = await getMergedConfig(process.cwd());
	const hooksResolved = resolveHooks(earlyConfig.config.hooks);
	const mcpServersResolved = resolveMcpServers(earlyConfig.config.mcpServers);

	await ensureHookSetup();

	// Ensure MCP server is configured in ~/.claude.json
	const currentFileUrl = import.meta.url;
	const currentFilePath = fileURLToPath(currentFileUrl);
	const projectRoot = path.resolve(path.dirname(currentFilePath), '..');
	if (mcpServersResolved.claudex) {
		await ensureMcpServerConfig(projectRoot);
	}

	// Check directory safety and potentially create temp directory
	let cwd = process.cwd();
	let temporaryDirCreated: string | undefined;

	if (!allowUnsafeDirectory) {
		const safetyCheck = await isUnsafeDirectory(cwd);
		if (safetyCheck.unsafe) {
			temporaryDirCreated = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-'));
			console.error(`Warning: Running in ${safetyCheck.reason} (${cwd}).`);
			console.error(`Creating temporary directory: ${temporaryDirCreated}`);
			cwd = temporaryDirCreated;
		}
	}

	// Handle --docker-exec: exec into a running container for current directory
	if (useDockerExec) {
		const cwdBasename = path.basename(cwd);
		const containerPrefix = `claudex-${cwdBasename}-`;

		const result = await execa('docker', [ 'ps', '--filter', `name=${containerPrefix}`, '--format', '{{.Names}}' ]);
		const containers = result.stdout.split('\n').filter(Boolean);

		if (containers.length === 0) {
			console.error(`No running claudex containers found for ${cwdBasename}.`);
			// eslint-disable-next-line unicorn/no-process-exit
			process.exit(1);
		}

		if (containers.length > 1) {
			console.error(`Multiple running claudex containers found for ${cwdBasename}:`);
			for (const container of containers) {
				console.error(`  ${container}`);
			}

			console.error('\nPlease stop all but one container, or exec manually with:');
			console.error('  docker exec -it <container-name> bash');
			// eslint-disable-next-line unicorn/no-process-exit
			process.exit(1);
		}

		const containerName = containers[0];
		await execa('docker', [ 'exec', '-it', containerName, 'bash' ], {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
		});
		return;
	}

	let claudeChildProcess;
	let sshAgent: SshAgentInfo | undefined;
	let hostSocket: { socketPath: string; cleanup: () => Promise<void> } | undefined;

	if (useDocker) {
		const cwdBasename = path.basename(cwd);
		const { config, profileVolumes } = await getMergedConfig(cwd);

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

		// Print packages
		if (config.packages && config.packages.length > 0) {
			console.error('Packages:');
			for (const pkg of config.packages) {
				console.error(`  ${pkg}`);
			}
		}

		const { username, projectRoot, imageName } = await ensureDockerImage(cwd, config, dockerPull, dockerNoCache);
		const randomSuffix = Math.random().toString(36).slice(2, 8);
		const containerName = `claudex-${cwdBasename}-${randomSuffix}`;
		const homeDir = os.homedir();
		const claudeConfigDir = path.join(homeDir, '.claude');
		const claudeConfigFile = path.join(homeDir, '.claude.json');
		const cliInDockerPath = path.join(projectRoot, 'build', 'cli-in-docker.js');

		const dockerArgs = [
			'run',
			'--rm',
			'-it',
			...(dockerSudo ? [] : [ '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges' ]),
			'--name',
			containerName,
			'-v',
			`${cwd}:${cwd}`,
			'-v',
			`${claudeConfigDir}:/home/${username}/.claude`,
			'-v',
			`${claudeConfigFile}:/home/${username}/.claude.json`,
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

		// Resolve environment variables from config
		const resolvedEnv: Record<string, string> = {};
		if (config.env) {
			for (const [ key, value ] of Object.entries(config.env)) {
				// Check if value is a reference to host environment variable
				const match = /^\${(.+)}$/.exec(value);
				if (match) {
					const hostVarName = match[1];
					const hostValue = process.env[hostVarName];
					if (hostValue !== undefined) {
						resolvedEnv[key] = hostValue;
					}
					// Skip if host variable is not defined
				} else {
					// Use literal value, expand ~/ in PATH
					resolvedEnv[key] = key === 'PATH' ? expandPathEnv(value) : value;
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
		sshAgent = await startSshAgent(sshKeys);
		if (sshAgent) {
			dockerArgs.push('-v', `${sshAgent.socketPath}:/ssh-agent`, '-e', 'SSH_AUTH_SOCK=/ssh-agent');
		}

		// Start host socket server (extensible channel for notifications, etc.)
		hostSocket = await startHostSocketServer();
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
		if (config.hostPorts && config.hostPorts.length > 0) {
			dockerArgs.push('--add-host', 'host.docker.internal:host-gateway', '-e', `CLAUDEX_HOST_PORTS=${config.hostPorts.join(',')}`);
			console.error('Host ports:');
			for (const port of config.hostPorts) {
				console.error(`  ${port}`);
			}
		}

		// Add extra host entries to container /etc/hosts
		if (config.extraHosts && Object.keys(config.extraHosts).length > 0) {
			console.error('Extra hosts:');
			for (const [ hostname, ip ] of Object.entries(config.extraHosts)) {
				dockerArgs.push('--add-host', `${hostname}:${ip}`);
				console.error(`  ${hostname} → ${ip}`);
			}
		}

		dockerArgs.push('-w', cwd);

		// Default to 'user,local' to ignore shared project .claude/ but allow local overrides
		const settingSources = config.settingSources ?? 'user,local';
		console.error(`Setting sources: ${settingSources}`);

		const addDirArgs = await buildAddDirArgs(config, cwd, projectRoot, profileVolumes);

		if (useDockerShell) {
			dockerArgs.push('--entrypoint', 'bash', imageName);
		} else {
			dockerArgs.push('--entrypoint', 'node', imageName, cliInDockerPath, '--setting-sources', settingSources, ...addDirArgs, ...claudeArgs);
		}

		claudeChildProcess = execa('docker', dockerArgs, {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
		});
	} else {
		// Load config for settingSources even in non-Docker mode
		const { config, profileVolumes } = await getMergedConfig(cwd);
		const settingSources = config.settingSources ?? 'user,local';
		console.error(`Setting sources: ${settingSources}`);

		const currentFileUrl = import.meta.url;
		const currentFilePath = fileURLToPath(currentFileUrl);
		const nonDockerProjectRoot = path.resolve(path.dirname(currentFilePath), '..');
		const addDirArgs = await buildAddDirArgs(config, cwd, nonDockerProjectRoot, profileVolumes);

		const claudeFullArgs = [ '--setting-sources', settingSources, ...addDirArgs, ...claudeArgs ];

		claudeChildProcess = execa('claude', claudeFullArgs, {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
		});
	}

	try {
		await createClaudeCodeMemory(earlyConfig.config.hooksDescriptions === false ? undefined : hooksResolved);
	} catch (error) {
		if (!(
			error instanceof Error
			&& error.message.includes('ENOENT')
		)) {
			throw error;
		}
	}

	try {
		await claudeChildProcess;
	} finally {
		// Remind user about temp directory
		if (temporaryDirCreated) {
			console.log(`Temporary directory used: ${temporaryDirCreated}`);
		}

		// Cleanup SSH agent if we started one
		if (sshAgent) {
			console.log('Cleaning up SSH agent...');
			await sshAgent.cleanup();
		}

		// Cleanup host socket server if we started one
		if (hostSocket) {
			await hostSocket.cleanup();
		}
	}
}

type HookConfig = {
	type: string;
	command: string;
};

type HookMatcher = {
	matcher: string;
	hooks: HookConfig[];
};

type Settings = {
	hooks?: Record<string, HookMatcher[]>;
};

const settingsSchema = z.object({
	hooks: z.record(z.string(), z.array(z.object({
		matcher: z.string(),
		hooks: z.array(z.object({
			type: z.string(),
			command: z.string(),
		})),
	}))).optional(),
});

function parseJsonWithSchema<T>(content: string, schema: z.ZodType<T>): T {
	const parsed: unknown = JSON.parse(content);
	return schema.parse(parsed);
}

async function setupHookSymlinks() {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');

	try {
		const settingsContent = await fs.readFile(settingsPath, 'utf8');
		const settings = parseJsonWithSchema(settingsContent, settingsSchema);

		if (!settings.hooks) {
			return;
		}

		// Get the project root (where build/ is)
		const currentFileUrl = import.meta.url;
		const currentFilePath = fileURLToPath(currentFileUrl);
		const buildDir = path.dirname(currentFilePath);
		const hooksDir = path.join(buildDir, 'hooks');

		// Mapping of hook command names to their actual files
		const hookNameMap: Record<string, string> = {
			'claudex-hook-pre-tool-use': 'pre-tool-use.js',
			'claudex-hook-user-prompt-submit': 'user-prompt-submit.js',
			'claudex-hook-notification': 'notification.js',
			'claudex-hook-stop': 'stop.js',
			'claudex-submit-co-authorship-proof': 'submit-co-authorship-proof.js',
		};

		// Collect all hook commands from settings
		const hookCommands = new Set<string>();
		for (const hookType of Object.values(settings.hooks)) {
			for (const matcher of hookType) {
				for (const hook of matcher.hooks) {
					if (hook.type === 'command' && hook.command) {
						hookCommands.add(hook.command);
					}
				}
			}
		}

		// Create symlinks for each hook command
		for (const hookCommand of hookCommands) {
			try {
				const hookBasename = path.basename(hookCommand);
				const targetFile = hookNameMap[hookBasename];

				if (!targetFile) {
					console.warn(`Unknown hook: ${hookBasename}`);
					continue;
				}

				const targetPath = path.join(hooksDir, targetFile);

				// Create parent directories if they don't exist
				const hookDir = path.dirname(hookCommand);
				// eslint-disable-next-line no-await-in-loop
				await fs.mkdir(hookDir, { recursive: true });

				// Remove existing symlink/file if it exists
				try {
					// eslint-disable-next-line no-await-in-loop
					await fs.unlink(hookCommand);
				} catch {
					// Ignore if file doesn't exist
				}

				// Create symlink
				// eslint-disable-next-line no-await-in-loop
				await fs.symlink(targetPath, hookCommand);
			} catch (error) {
				// Skip this hook if we can't create it (e.g., permission denied)
				if (error instanceof Error) {
					console.warn(`Warning: Could not create hook symlink at ${hookCommand}: ${error.message}`);
				}
			}
		}
	} catch (error) {
		// If we can't set up hooks, continue anyway
		if (error instanceof Error) {
			console.warn(`Warning: Could not set up hook symlinks: ${error.message}`);
		}
	}
}

async function setupKnownHosts() {
	const knownHostsContent = process.env.CLAUDEX_KNOWN_HOSTS_CONTENT;
	if (!knownHostsContent) {
		return;
	}

	const homeDir = os.homedir();
	const sshDir = path.join(homeDir, '.ssh');
	const knownHostsPath = path.join(sshDir, 'known_hosts');

	// Don't overwrite existing file
	try {
		await fs.access(knownHostsPath);
		console.log(`${knownHostsPath} already exists, skipping`);
		return;
	} catch {
		// File doesn't exist, create it
	}

	// Create .ssh directory with proper permissions
	await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });

	// Write known_hosts file with proper permissions
	const contentWithHeader = `# Generated by claudex\n${knownHostsContent}`;
	await fs.writeFile(knownHostsPath, contentWithHeader, { mode: 0o600 });
	console.log(`Created ${knownHostsPath} with filtered known hosts`);
}

async function setupHostPortForwarding(): Promise<(() => void) | undefined> {
	const hostPorts = process.env.CLAUDEX_HOST_PORTS;
	if (!hostPorts) {
		return undefined;
	}

	const ports = hostPorts.split(',').map(Number).filter(p => p > 0);
	if (ports.length === 0) {
		return undefined;
	}

	const children: ResultPromise[] = [];

	let stopped = false;

	for (const port of ports) {
		// Listen on both IPv4 and IPv6 loopback so that
		// connections to localhost work regardless of resolution
		const child4 = execa('socat', [
			`TCP4-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1`,
			`TCP:host.docker.internal:${port}`,
		]);
		const child6 = execa('socat', [
			`TCP6-LISTEN:${port},fork,reuseaddr,bind=::1`,
			`TCP:host.docker.internal:${port}`,
		]);
		for (const child of [ child4, child6 ]) {
			// Handle errors asynchronously without blocking
			// eslint-disable-next-line @typescript-eslint/no-loop-func
			void (async () => {
				try {
					await child;
				} catch (error: unknown) {
					if (stopped) {
						return;
					}

					console.error(`socat port ${port} error:`, error instanceof Error ? error.message : error);
				}
			})();
		}

		children.push(child4, child6);
		console.log(`Forwarding localhost:${port} → host:${port}`);
	}

	return () => {
		stopped = true;
		for (const child of children) {
			child.kill();
		}
	};
}

export async function mainInDocker() {
	await setupHookSymlinks();
	await setupKnownHosts();
	const cleanupPortForwarding = await setupHostPortForwarding();

	// Now exec claude with all arguments
	const args = process.argv.slice(2);

	try {
		await execa('claude', args, {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
		});
	} finally {
		cleanupPortForwarding?.();
	}

	console.log('Shutting down container...');
}
