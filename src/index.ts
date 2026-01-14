import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import meow from 'meow';
import { checkForClaudeCodeUpdate } from './update.js';
import { createClaudeCodeMemory } from './memory.js';
import { ensureHookSetup } from './hooks.js';
import { paths } from './paths.js';
import { getMergedConfig, expandVolumePaths, getSshKeys, getSshHosts, getFilteredKnownHosts, getGitWorktreeParentPath, expandPathEnv, type Volume } from './config.js';

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

	const socketMatch = output.match(/SSH_AUTH_SOCK=([^;]+)/);
	const pidMatch = output.match(/SSH_AGENT_PID=(\d+)/);

	if (!socketMatch || !pidMatch) {
		console.error('Failed to parse ssh-agent output');
		return undefined;
	}

	const socketPath = socketMatch[1];
	const pid = pidMatch[1];

	// Add keys to the agent
	for (const key of keys) {
		try {
			await execa('ssh-add', [ key ], {
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

async function ensureDockerImage(cwd: string, config: Awaited<ReturnType<typeof getMergedConfig>>, pull = false, noCache = false) {
	const userInfo = os.userInfo();
	const userId = userInfo.uid;
	const { username } = userInfo;

	const currentFileUrl = import.meta.url;
	const currentFilePath = fileURLToPath(currentFileUrl);
	const projectRoot = path.resolve(path.dirname(currentFilePath), '..');
	const dockerfilePath = path.join(projectRoot, 'Dockerfile');

	const cwdBasename = path.basename(cwd);

	// Get current Claude Code version from npm
	const claudeCodeVersionResult = await execa('npm', ['info', '@anthropic-ai/claude-code', 'version']);
	const claudeCodeVersion = claudeCodeVersionResult.stdout.trim();

	const imageName = `claudex-${cwdBasename}-${claudeCodeVersion}`.toLowerCase();

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
		'--build-arg',
		`CLAUDE_CODE_VERSION=${claudeCodeVersion}`,
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
	});

	return { userId, username, projectRoot, imageName };
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
		const [host, container] = spec.split(':', 2);
		return { host, container };
	}
	return spec;
}

function parseEnvSpec(spec: string): [string, string] {
	const idx = spec.indexOf('=');
	if (idx === -1) {
		// Shorthand: FOO → FOO=${FOO}
		return [spec, `\${${spec}}`];
	}
	return [spec.slice(0, idx), spec.slice(idx + 1)];
}

export async function main() {
	const flagsConfig = {
		docker: {
			type: 'boolean',
			default: true,
		},
		dockerShell: {
			type: 'boolean',
			default: false,
		},
		dockerExec: {
			type: 'boolean',
			default: false,
		},
		dockerPull: {
			type: 'boolean',
			default: false,
		},
		dockerNoCache: {
			type: 'boolean',
			default: false,
		},
		dockerSudo: {
			type: 'boolean',
			default: false,
		},
		allowUnsafeDirectory: {
			type: 'boolean',
			default: false,
		},
		package: {
			type: 'string',
			isMultiple: true,
		},
		volume: {
			type: 'string',
			isMultiple: true,
		},
		env: {
			type: 'string',
			isMultiple: true,
		},
		sshKey: {
			type: 'string',
			isMultiple: true,
		},
	} as const;

	const cli = meow(`
	Usage
	  $ claudex [options] [claude args...]

	Options
	  --no-docker              Run Claude Code directly on the host instead of in Docker
	  --docker-shell           Launch a bash shell inside the Docker container
	  --docker-exec            Exec into a running claudex container for current directory
	  --docker-pull            Pull the latest base image when building
	  --docker-no-cache        Build the Docker image without cache
	  --docker-sudo            Allow sudo inside the container (less secure)
	  --allow-unsafe-directory Skip directory safety checks (home, hidden, unowned, no .git)
	  --package <name>         Add apt package to install in Docker (can be repeated)
	  --volume <spec>          Add volume mount: path or host:container (can be repeated)
	  --env <spec>             Add env var: KEY=value or KEY for KEY=\${KEY} (can be repeated)
	  --ssh-key <path>         Add SSH key to agent (can be repeated)

	Examples
	  $ claudex
	  $ claudex --no-docker
	  $ claudex --docker-shell
	  $ claudex --docker-exec
	  $ claudex -p "Hello, Claude"
`, {
		importMeta: import.meta,
		flags: flagsConfig,
		allowUnknownFlags: true,
	});

	// Derive known flags from config to avoid duplication
	const knownBooleanFlags = new Set<string>();
	const knownStringFlags = new Set<string>();

	for (const [key, config] of Object.entries(flagsConfig)) {
		const kebab = key.replace(/([A-Z])/g, '-$1').toLowerCase();
		if (config.type === 'boolean') {
			knownBooleanFlags.add(`--${kebab}`);
			if ('default' in config && config.default === true) {
				knownBooleanFlags.add(`--no-${kebab}`);
			}
		} else if (config.type === 'string') {
			knownStringFlags.add(`--${kebab}`);
		}
	}

	await ensureHookSetup();

	// Ensure MCP server is configured in ~/.claude.json
	const currentFileUrl = import.meta.url;
	const currentFilePath = fileURLToPath(currentFileUrl);
	const projectRoot = path.resolve(path.dirname(currentFilePath), '..');
	await ensureMcpServerConfig(projectRoot);

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
	} = cli.flags;

	// Pass through unknown flags and input to claude
	// Filter out claudex-specific flags and their values
	const claudeArgs: string[] = [];
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (knownBooleanFlags.has(arg)) {
			// Skip boolean flag
			continue;
		}
		if (knownStringFlags.has(arg)) {
			// Skip string flag and its value
			i++;
			continue;
		}
		// Check for --flag=value format
		const eqIdx = arg.indexOf('=');
		if (eqIdx !== -1) {
			const flagPart = arg.slice(0, eqIdx);
			if (knownStringFlags.has(flagPart) || knownBooleanFlags.has(flagPart)) {
				continue;
			}
		}
		claudeArgs.push(arg);
	}

	// Check directory safety and potentially create temp directory
	let cwd = process.cwd();
	let tempDirCreated: string | undefined;

	if (!allowUnsafeDirectory) {
		const safetyCheck = await isUnsafeDirectory(cwd);
		if (safetyCheck.unsafe) {
			tempDirCreated = await fs.mkdtemp(path.join(os.tmpdir(), 'claudex-'));
			console.error(`Warning: Running in ${safetyCheck.reason} (${cwd}).`);
			console.error(`Creating temporary directory: ${tempDirCreated}`);
			cwd = tempDirCreated;
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
			process.exit(1);
		}

		if (containers.length > 1) {
			console.error(`Multiple running claudex containers found for ${cwdBasename}:`);
			for (const container of containers) {
				console.error(`  ${container}`);
			}
			console.error('\nPlease stop all but one container, or exec manually with:');
			console.error('  docker exec -it <container-name> bash');
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

	if (useDocker) {
		const cwdBasename = path.basename(cwd);
		const config = await getMergedConfig(cwd);

		// Merge CLI flags with config
		if (cliPackages?.length) {
			config.packages = [...(config.packages ?? []), ...cliPackages];
		}
		if (cliVolumes?.length) {
			const parsedVolumes = cliVolumes.map(parseVolumeSpec);
			config.volumes = [...(config.volumes ?? []), ...parsedVolumes];
		}
		if (cliEnv?.length) {
			config.env = config.env ?? {};
			for (const spec of cliEnv) {
				const [key, value] = parseEnvSpec(spec);
				config.env[key] = value;
			}
		}
		if (cliSshKeys?.length) {
			config.ssh = config.ssh ?? {};
			config.ssh.keys = [...(config.ssh.keys ?? []), ...cliSshKeys];
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
			...(dockerSudo ? [] : ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']),
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
		if (config.volumes) {
			for (const volume of config.volumes) {
				const expandedVolume = expandVolumePaths(volume);
				dockerArgs.push('-v', `${expandedVolume.host}:${expandedVolume.container}`);
			}
		}

		// Resolve environment variables from config
		const resolvedEnv: Record<string, string> = {};
		if (config.env) {
			for (const [key, value] of Object.entries(config.env)) {
				// Check if value is a reference to host environment variable
				const match = value.match(/^\$\{(.+)\}$/);
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

		// Print env overrides
		if (Object.keys(resolvedEnv).length > 0) {
			console.error('Environment overrides:');
			for (const [key, value] of Object.entries(resolvedEnv)) {
				console.error(`  ${key}=${value}`);
			}
		}

		// Add environment variables to docker args
		for (const [key, value] of Object.entries(resolvedEnv)) {
			dockerArgs.push('-e', `${key}=${value}`);
		}

		// Start SSH agent with configured keys
		const sshKeys = getSshKeys(config);
		sshAgent = await startSshAgent(sshKeys);
		if (sshAgent) {
			dockerArgs.push('-v', `${sshAgent.socketPath}:/ssh-agent`);
			dockerArgs.push('-e', 'SSH_AUTH_SOCK=/ssh-agent');
		}

		// Get filtered known_hosts content for configured SSH hosts
		const sshHosts = getSshHosts(config);
		const knownHostsContent = await getFilteredKnownHosts(sshHosts);
		if (knownHostsContent) {
			dockerArgs.push('-e', `CLAUDEX_KNOWN_HOSTS_CONTENT=${knownHostsContent}`);
		}

		dockerArgs.push('-w', cwd);

		if (useDockerShell) {
			dockerArgs.push('--entrypoint', 'bash', imageName);
		} else {
			dockerArgs.push('--entrypoint', 'node', imageName, cliInDockerPath, ...claudeArgs);
		}

		claudeChildProcess = execa('docker', dockerArgs, {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
		});
	} else {
		claudeChildProcess = execa('claude', claudeArgs, {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
		});
	}

	try {
		await createClaudeCodeMemory();
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
		if (tempDirCreated) {
			console.log(`Temporary directory used: ${tempDirCreated}`);
		}

		// Cleanup SSH agent if we started one
		if (sshAgent) {
			console.log('Cleaning up SSH agent...');
			await sshAgent.cleanup();
		}

		// Only check for updates when running on host (not in Docker)
		if (!useDocker) {
			console.log('Checking for updates...');
			await checkForClaudeCodeUpdate();
		}
	}
}

interface HookConfig {
	type: string;
	command: string;
}

interface HookMatcher {
	matcher: string;
	hooks: HookConfig[];
}

interface Settings {
	hooks?: {
		[key: string]: HookMatcher[];
	};
}

async function setupHookSymlinks() {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');

	try {
		const settingsContent = await fs.readFile(settingsPath, 'utf8');
		const settings: Settings = JSON.parse(settingsContent);

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
				await fs.mkdir(hookDir, { recursive: true });

				// Remove existing symlink/file if it exists
				try {
					await fs.unlink(hookCommand);
				} catch {
					// Ignore if file doesn't exist
				}

				// Create symlink
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

export async function mainInDocker() {
	await setupHookSymlinks();
	await setupKnownHosts();

	// Now exec claude with all arguments
	const args = process.argv.slice(2);

	await execa('claude', args, {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	});

	console.log('Shutting down container...');
}
