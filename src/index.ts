import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { Command } from 'commander';
import { createClaudeCodeMemory } from './memory.js';
import { ensureHookSetup } from './hooks.js';
import {
	getMergedConfig, resolveMcpServers,
	resolveHooks, type ClaudexConfig,
	type LauncherDefinition,
} from './config.js';
import { configMain } from './config-cli.js';
import { isUnsafeDirectory } from './safety.js';
import { type SshAgentInfo } from './ssh/agent.js';
import { buildAddDirArgs, runDockerContainer } from './docker/run.js';
import { resolveLauncherDefinition, buildLauncherCommand } from './launcher.js';

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
	launcher: string | undefined;
	model: string | undefined;
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
		.option('--launcher <name>', 'Select launcher by name (e.g. "ollama")')
		.option('--model <name>', 'Override the launcher\'s default model')
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

	program
		.command('install')
		.description('Install packages into a running claudex container')
		.argument('<packages...>', 'Package names to install')
		.option('--no-save', 'Skip persisting packages to config')
		.option('--container <name>', 'Target a specific container')
		.action(async (packages: string[], options: { save: boolean; container?: string }) => {
			await runInstall(packages, options);
		});

	await program.parseAsync(process.argv);
}

export async function findRunningContainer(cwd: string, specificName?: string): Promise<string> {
	if (specificName) {
		// Verify the specific container is running
		const result = await execa('docker', [ 'ps', '--filter', `name=^${specificName}$`, '--format', '{{.Names}}' ]);
		const containers = result.stdout.split('\n').filter(Boolean);
		if (containers.length === 0) {
			throw new Error(`Container '${specificName}' is not running.`);
		}

		return containers[0];
	}

	const cwdBasename = path.basename(cwd);
	const containerPrefix = `claudex-${cwdBasename}-`;

	const result = await execa('docker', [ 'ps', '--filter', `name=${containerPrefix}`, '--format', '{{.Names}}' ]);
	const containers = result.stdout.split('\n').filter(Boolean);

	if (containers.length === 0) {
		throw new Error(`No running claudex containers found for ${cwdBasename}. Start one with: claudex`);
	}

	if (containers.length > 1) {
		const list = containers.map(c => `  ${c}`).join('\n');
		throw new Error(`Multiple running claudex containers found for ${cwdBasename}:\n${list}\n\nSpecify one with --container <name>`);
	}

	return containers[0];
}

async function runInstall(packages: string[], options: { save: boolean; container?: string }) {
	const cwd = process.cwd();

	let containerName: string;
	try {
		containerName = await findRunningContainer(cwd, options.container);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(1);
	}

	// Try pacman first
	try {
		await execa('docker', [ 'exec', '--user', 'root', containerName, 'pacman', '-S', '--noconfirm', '--needed', ...packages ], {
			stdout: process.stdout,
			stderr: process.stderr,
		});
	} catch {
		// Fallback to yay for AUR packages — yay must run as non-root
		console.error('pacman failed, trying yay...');
		const { stdout: username } = await execa('docker', [ 'exec', containerName, 'whoami' ]);
		try {
			await execa('docker', [ 'exec', '--user', 'root', containerName, 'su', '-', username.trim(), '-c', `yay -S --noconfirm --needed ${packages.join(' ')}` ], {
				stdout: process.stdout,
				stderr: process.stderr,
			});
		} catch {
			console.error('Package installation failed.');
			// eslint-disable-next-line unicorn/no-process-exit
			process.exit(1);
		}
	}

	// Persist to config unless --no-save
	if (options.save) {
		try {
			await configMain([ 'add', '--project', cwd, 'packages', ...packages ]);
			console.error(`Saved packages to project config: ${packages.join(' ')}`);
		} catch (error) {
			console.error('Warning: failed to save packages to config:', error instanceof Error ? error.message : String(error));
		}
	}
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
		launcher: cliLauncher,
		model: cliModel,
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
		const containerName = await findRunningContainer(cwd);
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
	let cleanupHostPortProxies: (() => void) | undefined;

	// Resolve launcher definition
	const launcherName = cliLauncher ?? earlyConfig.config.launcher;
	let launcherDef: LauncherDefinition | undefined;
	if (launcherName) {
		launcherDef = resolveLauncherDefinition(launcherName, earlyConfig.launcherDefinitions);
		console.error(`Launcher: ${launcherName}`);
	}

	if (useDocker) {
		const { config, profileVolumes } = await getMergedConfig(cwd);
		const cliInDockerPath = path.join(projectRoot, 'build', 'cli-in-docker.js');

		({
			childProcess: claudeChildProcess,
			sshAgent,
			hostSocket,
			cleanupHostPortProxies,
		} = await runDockerContainer({
			cwd,
			config,
			profileVolumes,
			launcherDef,
			cliPackages,
			cliVolumes,
			cliEnv,
			cliSshKeys,
			cliModel,
			dockerSudo,
			useDockerShell,
			dockerPull,
			dockerNoCache,
			claudeArgs,
			cliInDockerPath,
		}));
	} else {
		// Load config for settingSources even in non-Docker mode
		const { config, profileVolumes } = await getMergedConfig(cwd);
		const settingSources = config.settingSources ?? 'user,local';
		console.error(`Setting sources: ${settingSources}`);

		const addDirArgs = await buildAddDirArgs(config, cwd, projectRoot, profileVolumes);

		const claudeFullArgs = [ '--setting-sources', settingSources, ...addDirArgs, ...claudeArgs ];

		if (launcherDef) {
			const { command: launcherCmd, args: launcherArgs } = buildLauncherCommand(launcherDef, cliModel, claudeFullArgs);
			claudeChildProcess = execa(launcherCmd, launcherArgs, {
				stdin: process.stdin,
				stdout: process.stdout,
				stderr: process.stderr,
			});
		} else {
			claudeChildProcess = execa('claude', claudeFullArgs, {
				stdin: process.stdin,
				stdout: process.stdout,
				stderr: process.stderr,
			});
		}
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

		// Cleanup host port proxies if we started them
		cleanupHostPortProxies?.();
	}
}

export { resolveLauncherDefinition, buildLauncherCommand } from './launcher.js';
