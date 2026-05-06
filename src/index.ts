import process from 'node:process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import fsExtra from 'fs-extra';
import { execa } from 'execa';
import { DateTime } from 'luxon';
import { Command } from 'commander';
import { createClaudeCodeMemory } from './memory.js';
import { ensureHookSetup } from './hooks.js';
import {
	getMergedConfig, resolveMcpServers,
	resolveHooks, type ClaudexConfig,
	type LauncherDefinition,
	readAllConfigFiles, writeSingleConfigFile,
	resolveEnvFileSources, loadEnvFileSources,
} from './config/index.js';
import {
	configMain, configMainFromArgv, type Scope, type ParsedArgs,
} from './config-cli.js';
import { isUnsafeDirectory } from './safety.js';
import { isErrnoException, collapseHomedir, expandTilde } from './utils.js';
import { type SshAgentInfo } from './ssh/agent.js';
import { buildAddDirArgs, getContainerPrefix, runDockerContainer } from './docker/run.js';
import { resolveLauncherDefinition, buildLauncherCommand, resolveLauncherOverride } from './launcher.js';
import {
	launcherRegistry,
	effectiveSpecField, ensureAccountDirsForSpec,
	getAccountPrimaryDir, resolveLauncherSpec, walkSpecWraps,
	type LauncherSpec,
} from './launchers/registry.js';
import { copyResumeSessionIfElsewhere, encodeProjectPath } from './resume.js';

async function ensureMcpServerConfig(projectRoot: string, claudeConfigDir?: string) {
	const claudeJsonPath = claudeConfigDir
		? path.join(claudeConfigDir, '.claude.json')
		: path.join(os.homedir(), '.claude.json');
	let config: Record<string, unknown> = {};

	try {
		const content = await fs.readFile(claudeJsonPath, 'utf8');
		try {
			config = JSON.parse(content) as Record<string, unknown>;
		} catch {
			// Invalid JSON — warn and start fresh
			console.warn(`Warning: ${claudeJsonPath} contains invalid JSON; overwriting.`);
		}
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}

		// File doesn't exist yet — start with empty config
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
	dockerPull: boolean;
	dockerNoCache: boolean;
	dockerSkipBuild: boolean;
	dockerSudo: boolean;
	dockerInsecure: boolean;
	allowUnsafeDirectory: boolean;
	package: string[];
	volume: string[];
	env: string[];
	envFile: string[];
	envMode: string | undefined;
	sshKey: string[];
	dockerArg: string[];
	dockerArgs: string | undefined;
	launcher: string | undefined;
	model: string | undefined;
	account: string | undefined;
	noAccount: boolean;
};

export async function main() {
	const program = new Command('claudex')
		.option('--no-docker', 'Run Claude Code directly on the host instead of in Docker')
		.option('--docker-shell', 'Start a new container and launch a bash shell in it instead of the launcher (use "claudex exec" to shell into an already-running container)')
		.option('--docker-pull', 'Pull the latest base image when building')
		.option('--docker-no-cache', 'Build the Docker image without cache')
		.option('--docker-skip-build, --docker-no-build', 'Skip Docker image build and use existing image')
		.option('--docker-sudo', 'Allow sudo inside the container (less secure)')
		.option('--docker-insecure', 'Disable all Docker hardening (caps, no-new-privileges, ipc, pids-limit)')
		.option('--docker-arg <arg>', 'Pass extra argument to docker run (repeatable)', collect, [])
		.option('--docker-args <args>', 'Extra arguments to pass to docker run (space-separated)')
		.option('--allow-unsafe-directory', 'Skip directory safety checks (home, hidden, unowned, no .git)')
		.option('--package <name>', 'Add pacman package to install in Docker (repeatable)', collect, [])
		.option('--volume <spec>', 'Add volume mount: path or host:container (repeatable)', collect, [])
	// eslint-disable-next-line no-template-curly-in-string
		.option('--env <spec>', 'Add env var: KEY=value or KEY for KEY=${KEY} (repeatable)', collect, [])
		.option('--env-file <path>', 'Load env vars from a dotenv-format file (repeatable)', collect, [])
		.option('--env-mode <mode>', 'How env-file vars reach the container: "explicit" (default; only env: {...} entries) or "all" (every loaded var)')
		.option('--ssh-key <path>', 'Add SSH key to agent (repeatable)', collect, [])
		.option('--launcher <name>', 'Select launcher by name (e.g. "ollama", "codex")')
		.option('--model <name>', 'Override the launcher\'s default model')
		.option('--account <name>', 'Use a specific claudex account')
		.option('--no-account', 'Ignore configured account and use default')
		.allowUnknownOption()
		.passThroughOptions()
		.argument('[claude-args...]')
		.action(async (claudeArgs: string[], options: MainOptions) => {
			await runMain(claudeArgs, options);
		});

	type ScopeOptions = {
		global?: boolean;
		project?: string;
		group?: string;
		profile?: string;
		file?: string;
		members?: boolean;
	};

	function resolveScope(options: ScopeOptions): Scope {
		if (options.project) {
			return { type: 'project', path: options.project };
		}

		if (options.group) {
			return { type: 'group', name: options.group };
		}

		if (options.profile) {
			return { type: 'profile', name: options.profile };
		}

		if (options.global) {
			return { type: 'global' };
		}

		return { type: 'project', path: process.cwd(), fromCwd: true };
	}

	async function runConfigAction(parsed: ParsedArgs) {
		try {
			await configMain(parsed);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}

	const configCommand = program
		.command('config')
		.description('Manage claudex configuration')
		.showHelpAfterError()
		.enablePositionalOptions();

	const scopeOptions = (cmd: Command) => cmd
		.option('--global', 'Use global config (default)')
		.option('--project <path>', 'Use project-scoped config')
		.option('--group <name>', 'Use group-scoped config')
		.option('--profile <name>', 'Use profile-scoped config')
		.option('--file <path>', 'Write to a specific file in config.json.d')
		.passThroughOptions();

	scopeOptions(configCommand.command('list').description('List merged configuration as JSON'))
		.option('--members', 'List project paths belonging to the group (requires --group)')
		.action(async (options: ScopeOptions) => {
			await runConfigAction({
				action: 'list', scope: resolveScope(options), file: options.file, members: options.members,
			});
		});

	scopeOptions(configCommand.command('get').description('Get a configuration value').argument('<key>'))
		.action(async (key: string, options: ScopeOptions) => {
			await runConfigAction({
				action: 'get', scope: resolveScope(options), file: options.file, key,
			});
		});

	scopeOptions(configCommand.command('set').description('Set a configuration value').argument('<key>').argument('<value>'))
		.action(async (key: string, value: string, options: ScopeOptions) => {
			await runConfigAction({
				action: 'set', scope: resolveScope(options), file: options.file, key, value,
			});
		});

	scopeOptions(configCommand.command('add').description('Append value(s) to an array field').argument('<key>').argument('<values...>'))
		.action(async (key: string, values: string[], options: ScopeOptions) => {
			await runConfigAction({
				action: 'add', scope: resolveScope(options), file: options.file, key, extraValues: values,
			});
		});

	scopeOptions(configCommand.command('remove').description('Remove a value from an array or record field').argument('<key>').argument('[value]'))
		.action(async (key: string, value: string | undefined, options: ScopeOptions) => {
			await runConfigAction({
				action: 'remove', scope: resolveScope(options), file: options.file, key, value,
			});
		});

	scopeOptions(configCommand.command('unset').description('Remove a key or a specific value from an array').argument('<key>').argument('[value]'))
		.action(async (key: string, value: string | undefined, options: ScopeOptions) => {
			await runConfigAction({
				action: 'unset', scope: resolveScope(options), file: options.file, key, value,
			});
		});

	configCommand.command('keys').description('List available configuration keys and their types')
		.action(async () => {
			await runConfigAction({ action: 'keys', scope: { type: 'global' } });
		});

	configCommand.command('group').description('Assign projects to a group')
		.argument('<name>', 'Group name')
		.argument('<paths...>', 'Project paths to assign')
		.option('--file <path>', 'Write to a specific file in config.json.d')
		.passThroughOptions()
		.action(async (name: string, paths: string[], options: { file?: string }) => {
			await runConfigAction({
				action: 'group', scope: { type: 'global' }, file: options.file, key: name, extraValues: paths,
			});
		});

	configCommand.command('ungroup').description('Remove group assignment from projects')
		.argument('<name>', 'Group name')
		.argument('<paths...>', 'Project paths to ungroup')
		.option('--file <path>', 'Write to a specific file in config.json.d')
		.passThroughOptions()
		.action(async (name: string, paths: string[], options: { file?: string }) => {
			await runConfigAction({
				action: 'ungroup',
				scope: { type: 'project', path: process.cwd(), fromCwd: true },
				file: options.file,
				extraValues: [ name, ...paths ],
			});
		});

	configCommand.command('profile').description('Add a profile to projects')
		.argument('<name>', 'Profile name')
		.argument('<paths...>', 'Project paths to assign')
		.option('--file <path>', 'Write to a specific file in config.json.d')
		.passThroughOptions()
		.action(async (name: string, paths: string[], options: { file?: string }) => {
			await runConfigAction({
				action: 'profile', scope: { type: 'global' }, file: options.file, key: name, extraValues: paths,
			});
		});

	configCommand.command('unprofile').description('Remove a profile from projects')
		.argument('<name>', 'Profile name')
		.argument('<paths...>', 'Project paths to unprofile')
		.option('--file <path>', 'Write to a specific file in config.json.d')
		.passThroughOptions()
		.action(async (name: string, paths: string[], options: { file?: string }) => {
			await runConfigAction({
				action: 'unprofile',
				scope: { type: 'project', path: process.cwd(), fromCwd: true },
				file: options.file,
				extraValues: [ name, ...paths ],
			});
		});

	program
		.command('config-interactive')
		.description('Interactive TUI for browsing and editing claudex configuration')
		.action(async () => {
			const { configTuiMain } = await import('./config-tui.js');
			await configTuiMain();
		});

	program
		.command('install')
		.description('Install packages into a running claudex container')
		.argument('<packages...>', 'Package names to install')
		.option('--no-save', 'Skip persisting packages to config')
		.option('--container <name>', 'Target a specific container')
		.action(async (packages: string[], options: { save: boolean; container?: string }) => {
			await runInstall(packages, options);
		});

	program
		.command('uninstall')
		.description('Uninstall packages from a running claudex container')
		.argument('<packages...>', 'Package names to uninstall')
		.option('--no-save', 'Skip removing packages from config')
		.option('--container <name>', 'Target a specific container')
		.action(async (packages: string[], options: { save: boolean; container?: string }) => {
			await runUninstall(packages, options);
		});

	program
		.command('ps')
		.description('List running claudex containers for the current project')
		.option('--all', 'Show containers for all projects, not just the current directory')
		.action(async (options: { all?: boolean }) => {
			await runPs(options);
		});

	program
		.command('attach')
		.description('Re-attach to an orphaned claudex container and clean up when done')
		.argument('[container]', 'Target a specific container by name')
		.action(async (container: string | undefined) => {
			await runAttach({ container });
		});

	program
		.command('exec')
		.description('Exec a bash shell into a running claudex container for current directory')
		.argument('[container]', 'Target a specific container by name')
		.option('--root', 'Exec as root with full privileges')
		.action(async (container: string | undefined, options: { root?: boolean }) => {
			await runExec(container, options);
		});

	program
		.command('prune')
		.description('Remove orphaned claudex containers')
		.option('--all', 'Remove orphaned containers for all projects, not just the current directory')
		.option('-f, --force', 'Skip confirmation prompt')
		.action(async (options: { all?: boolean; force?: boolean }) => {
			await runPrune(options);
		});

	program
		.command('mv <source> <destination>')
		.description('Move a project and its Claude session data to a new path')
		.option('--account <name>', 'Use a specific claudex account')
		.action(async (source: string, destination: string, options: { account?: string }) => {
			await runMv(source, destination, options);
		});

	program
		.command('confirm')
		.description('Confirm a pending action by its short ID')
		.argument('<id>', 'Short confirmation ID')
		.argument('<proof>', 'Proof text with exact quote from the user')
		.option('--exec', 'Execute the confirmed command after storing confirmation')
		.action(async (shortId: string, proof: string, options: { exec?: boolean }) => {
			const {
				loadPendingConfirmation, verifyConfirmationToken, storeConfirmation,
			} = await import('./confirm.js');
			const { buildToolUseMap, extractContent } = await import('./transcript/parser.js');

			let pending;
			try {
				pending = await loadPendingConfirmation(shortId);
			} catch {
				console.error(`❌ Unknown confirmation ID: ${shortId}`);
				process.exitCode = 1;
				return;
			}

			const { token, command } = pending;

			let payload;
			try {
				payload = await verifyConfirmationToken(token);
			} catch (error) {
				console.error(`❌ Invalid or expired confirmation token: ${error instanceof Error ? error.message : String(error)}`);
				process.exitCode = 1;
				return;
			}

			const { actionHash, sessionId, transcriptPath } = payload;

			try {
				const toolUseMap = await buildToolUseMap(transcriptPath);
				let found = false;

				for await (const content of extractContent(transcriptPath, toolUseMap, {
					targets: new Set([ 'user', 'queue-operation' ] as const),
					sessionId,
				})) {
					if (content.text.includes(proof)) {
						found = true;
						break;
					}
				}

				if (!found) {
					console.error('❌ Proof quote not found in session transcript.');
					console.error('The proof must contain an exact quote from the user in this session.');
					process.exitCode = 1;
					return;
				}
			} catch (error) {
				console.error(`❌ Failed to read session transcript: ${error instanceof Error ? error.message : String(error)}`);
				process.exitCode = 1;
				return;
			}

			await storeConfirmation(actionHash, sessionId, token, proof);
			console.log(`✅ Confirmation stored for action ${actionHash.slice(0, 12)}...`);

			if (options.exec) {
				if (!command) {
					console.error('❌ No command stored for this confirmation.');
					process.exitCode = 1;
					return;
				}

				console.log(`▶ Executing: ${command}`);
				const result = await execa('sh', [ '-c', command ], { stdio: 'inherit', reject: false });
				process.exitCode = result.exitCode ?? 0;
			}
		});

	await program.parseAsync(process.argv);
}

export type ExecaFn = (command: string, args: string[]) => Promise<{ stdout: string }>;

export const containerNamePattern = /^claudex-.+-[a-z\d]{6}$/;

export function filterContainerLines(lines: string[], prefix: string): string[] {
	return lines.filter(line => {
		const name = line.split('\t')[0];
		if (!name.startsWith(prefix)) {
			return false;
		}

		return /^[a-z\d]{6}$/.test(name.slice(prefix.length));
	});
}

export type FindContainerCaller = 'attach' | 'exec' | 'exec --root' | 'install' | 'uninstall';

function disambiguationHint(caller: FindContainerCaller): string {
	switch (caller) {
		case 'install':
		case 'uninstall': {
			return `Specify one with: claudex ${caller} --container <name> <packages...>`;
		}

		case 'attach':
		case 'exec':
		case 'exec --root': {
			return `Specify one with: claudex ${caller} <name>`;
		}
	}
}

export async function findRunningContainer(cwd: string, specificName?: string, execaFn: ExecaFn = execa, caller: FindContainerCaller = 'attach'): Promise<string> {
	if (specificName) {
		// Verify the specific container is running
		const result = await execaFn('docker', [ 'ps', '--filter', `name=^${specificName}$`, '--format', '{{.Names}}' ]);
		const containers = result.stdout.split('\n').filter(Boolean);
		if (containers.length === 0) {
			throw new Error(`Container '${specificName}' is not running.`);
		}

		return containers[0];
	}

	const cwdBasename = path.basename(cwd);
	const lines = await listContainers({ cwd, execaFn });

	if (lines.length === 0) {
		throw new Error(`No running claudex containers found for ${cwd}. Start one with: claudex`);
	}

	if (lines.length > 1) {
		const list = lines.map(line => {
			const [ name, ...createdParts ] = line.split('\t');
			const created = createdParts.join('\t').trim();
			const dt = created ? DateTime.fromSQL(created.replace(/ [+-]\d{2}$/, '')) : undefined;
			const relative = dt?.isValid ? dt.toRelative() : created;
			return relative ? `  ${name}  (created ${relative})` : `  ${name}`;
		}).join('\n');
		throw new Error(`Multiple running claudex containers found for ${cwdBasename}:\n${list}\n\n${disambiguationHint(caller)}`);
	}

	return lines[0].split('\t')[0];
}

async function runInstall(packages: string[], options: { save: boolean; container?: string }) {
	const cwd = process.cwd();

	let containerName: string;
	try {
		containerName = await findRunningContainer(cwd, options.container, execa, 'install');
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(1);
	}

	// Sync package database as privileged root (pacman -Sy needs CAP_CHOWN for temp dirs)
	const syncArgs = [ 'exec', '--privileged', '--user', 'root', containerName, 'pacman', '-Sy' ];
	console.error(`+ docker ${syncArgs.join(' ')}`);
	try {
		await execa('docker', syncArgs, {
			stdout: process.stdout,
			stderr: process.stderr,
		});
	} catch {
		console.error('Warning: failed to sync package database.');
	}

	// Install packages as privileged root (needs CAP_CHOWN etc.)
	const installArgs = [ 'exec', '--privileged', '--user', 'root', containerName, 'pacman', '-S', '--noconfirm', '--needed', ...packages ];
	console.error(`+ docker ${installArgs.join(' ')}`);
	try {
		await execa('docker', installArgs, {
			stdout: process.stdout,
			stderr: process.stderr,
		});
	} catch {
		console.error('Package installation failed.');
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(1);
	}

	// Persist to config unless --no-save
	if (options.save) {
		try {
			await configMainFromArgv([ 'add', 'packages', ...packages ]);
			console.error(`Saved packages to project config: ${packages.join(' ')}`);
		} catch (error) {
			console.error('Warning: failed to save packages to config:', error instanceof Error ? error.message : String(error));
		}
	}
}

async function runUninstall(packages: string[], options: { save: boolean; container?: string }) {
	const cwd = process.cwd();

	let containerName: string;
	try {
		containerName = await findRunningContainer(cwd, options.container, execa, 'uninstall');
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(1);
	}

	// Remove packages as privileged root
	const uninstallArgs = [ 'exec', '--privileged', '--user', 'root', containerName, 'pacman', '-Rns', '--noconfirm', ...packages ];
	console.error(`+ docker ${uninstallArgs.join(' ')}`);
	try {
		await execa('docker', uninstallArgs, {
			stdout: process.stdout,
			stderr: process.stderr,
		});
	} catch {
		console.error('Package removal failed.');
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(1);
	}

	// Remove from config unless --no-save
	if (options.save) {
		for (const pkg of packages) {
			try {
				// eslint-disable-next-line no-await-in-loop
				await configMainFromArgv([ 'remove', 'packages', pkg ]);
			} catch {
				// Package may not be in config — ignore
			}
		}

		console.error(`Removed packages from project config: ${packages.join(' ')}`);
	}
}

async function listContainers(options: { all?: boolean; cwd?: string; execaFn?: ExecaFn }): Promise<string[]> {
	const cwd = options.cwd ?? process.cwd();
	const containerPrefix = options.all ? 'claudex-' : getContainerPrefix(cwd);
	const execaFn = options.execaFn ?? execa;

	const result = await execaFn('docker', [
		'ps',
		'--filter',
		`name=^${containerPrefix}`,
		'--format',
		'{{.Names}}\t{{.CreatedAt}}\t{{.Status}}',
	]);

	// Docker's name filter is a substring match, so filter more precisely in code.
	const lines = result.stdout.split('\n').filter(Boolean);
	if (options.all) {
		return lines.filter(line => containerNamePattern.test(line.split('\t')[0]));
	}

	return filterContainerLines(lines, containerPrefix);
}

async function isContainerAttached(name: string): Promise<boolean> {
	try {
		const pgrepResult = await execa('pgrep', [ '-f', `docker attach ${name}` ]);
		return Boolean(pgrepResult.stdout.trim());
	} catch {
		// Pgrep exits non-zero when no match — container is orphaned
		return false;
	}
}

async function isContainerRunning(name: string): Promise<boolean> {
	try {
		const result = await execa('docker', [ 'inspect', '--format', '{{.State.Running}}', name ]);
		return result.stdout.trim() === 'true';
	} catch {
		return false;
	}
}

type AttachOutcome = 'detach' | 'die' | 'unknown';

// Subscribes to `docker events` for die/detach events on the container. Runs
// for the lifetime of the attach — call stop() once the attach child exits
// to read whichever event fired (if any). Detach events are per-client, so
// multiple clients each see their own detach event; die fires once for all.
function watchAttachEvents(containerName: string): {
	stop: () => Promise<AttachOutcome>;
} {
	let outcome: AttachOutcome = 'unknown';
	const child = execa('docker', [
		'events',
		'--filter',
		`container=${containerName}`,
		'--filter',
		'event=die',
		'--filter',
		'event=detach',
		'--format',
		'{{.Status}}',
	]);

	child.stdout?.setEncoding('utf8');
	child.stdout?.on('data', (chunk: string) => {
		for (const line of chunk.split('\n')) {
			const event = line.trim();
			if (event === 'die') {
				outcome = 'die';
			} else if (event === 'detach' && outcome === 'unknown') {
				outcome = 'detach';
			}
		}
	});
	// eslint-disable-next-line promise/prefer-await-to-then -- fire-and-forget on long-running subprocess; the function returns a stop handle
	child.catch(() => {
		// Killing the events subscription throws; ignore
	});

	return {
		async stop() {
			child.kill('SIGTERM');
			try {
				await child;
			} catch {
				// Expected on SIGTERM
			}

			return outcome;
		},
	};
}

// Cleanup rule for the PRIMARY attach (the `claudex` run that created the
// container). This process owns the container's lifecycle.
async function cleanupOrDetachPrimary(containerName: string, outcome: AttachOutcome): Promise<void> {
	if (outcome === 'detach') {
		console.error(`Detached from ${containerName}. Re-attach with: claudex attach ${containerName}`);
		return;
	}

	// Outcome === 'die' or 'unknown' — if unknown, fall back to state check
	if (outcome === 'unknown' && await isContainerRunning(containerName)) {
		console.error(`Detached from ${containerName}. Re-attach with: claudex attach ${containerName}`);
		return;
	}

	try {
		await execa('docker', [ 'rm', '-f', containerName ]);
	} catch {
		// Container may already be removed
	}
}

// Cleanup rule for SECONDARY attach (`claudex attach` re-attach). Never
// removes the container — the primary owns that decision. If the container
// exited while we were attached, inform the user; otherwise it's a normal
// detach.
function reportSecondaryOutcome(containerName: string, outcome: AttachOutcome): void {
	if (outcome === 'die') {
		console.error(`Container ${containerName} exited. Remove it with: claudex prune`);
		return;
	}

	console.error(`Detached from ${containerName}. Re-attach with: claudex attach ${containerName}`);
}

async function runPs(options: { all?: boolean }) {
	const cwd = process.cwd();
	const lines = await listContainers(options);

	if (lines.length === 0) {
		console.error(options.all
			? 'No running claudex containers found.'
			: `No running claudex containers found for ${cwd}.`);
		return;
	}

	type Row = {
		name: string;
		created: string;
		status: string;
		attached: string;
	};

	const rows: Row[] = [];

	for (const line of lines) {
		const [ name, ...rest ] = line.split('\t');
		const created = rest[0] ?? '';
		const status = rest[1] ?? '';

		// eslint-disable-next-line no-await-in-loop
		const attached = await isContainerAttached(name) ? 'attached' : 'orphaned';

		rows.push({
			name,
			created,
			status,
			attached,
		});
	}

	// Calculate column widths
	const headers: Row = {
		name: 'NAME',
		created: 'CREATED',
		status: 'STATUS',
		attached: 'ATTACHED',
	};
	const cols = {
		name: Math.max(headers.name.length, ...rows.map(r => r.name.length)),
		created: Math.max(headers.created.length, ...rows.map(r => r.created.length)),
		status: Math.max(headers.status.length, ...rows.map(r => r.status.length)),
		attached: Math.max(headers.attached.length, ...rows.map(r => r.attached.length)),
	};

	const formatRow = (r: typeof headers) =>
		`${r.name.padEnd(cols.name)}  ${r.created.padEnd(cols.created)}  ${r.status.padEnd(cols.status)}  ${r.attached}`;

	console.log(formatRow(headers));
	for (const row of rows) {
		console.log(formatRow(row));
	}
}

async function runAttach(options: { container?: string }) {
	const cwd = process.cwd();

	let containerName: string;
	try {
		containerName = await findRunningContainer(cwd, options.container, execa, 'attach');
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(1);
	}

	console.error(`Attaching to ${containerName}...`);

	const events = watchAttachEvents(containerName);
	try {
		await execa('docker', [ 'attach', containerName ], {
			stdin: process.stdin,
			stdout: process.stdout,
			stderr: process.stderr,
		});
	} catch {
		// Docker attach exits 1 on clean detach (Ctrl+P Ctrl+Q); defer to event check
	}

	const outcome = await events.stop();
	reportSecondaryOutcome(containerName, outcome);
}

async function runExec(container: string | undefined, options: { root?: boolean }) {
	const cwd = process.cwd();

	let containerName: string;
	try {
		containerName = await findRunningContainer(cwd, container, execa, options.root ? 'exec --root' : 'exec');
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(1);
	}

	const execArgs = options.root
		? [ 'exec', '-it', '--privileged', '--user', 'root', containerName, 'bash' ]
		: [ 'exec', '-it', containerName, 'bash' ];

	await execa('docker', execArgs, {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	});
}

async function runPrune(options: { all?: boolean; force?: boolean }) {
	const lines = await listContainers(options);

	const orphaned: string[] = [];
	for (const line of lines) {
		const name = line.split('\t')[0];
		// eslint-disable-next-line no-await-in-loop
		if (!await isContainerAttached(name)) {
			orphaned.push(name);
		}
	}

	if (orphaned.length === 0) {
		console.error('No orphaned containers to remove.');
		return;
	}

	if (!options.force) {
		console.error(`WARNING! This will remove ${orphaned.length} orphaned container${orphaned.length === 1 ? '' : 's'}:`);
		for (const name of orphaned) {
			console.error(`  ${name}`);
		}

		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		const answer = await new Promise<string>(resolve => {
			rl.question('Are you sure you want to continue? [y/N] ', resolve);
		});
		rl.close();

		if (answer.toLowerCase() !== 'y') {
			return;
		}
	}

	for (const name of orphaned) {
		try {
			// eslint-disable-next-line no-await-in-loop
			await execa('docker', [ 'rm', '-f', name ]);
			console.error(`Removed: ${name}`);
		} catch (error) {
			console.error(`Failed to remove ${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function runMv(source: string, destination: string, options: { account?: string }) {
	const resolvedSource = path.resolve(expandTilde(source));
	const resolvedDestination = path.resolve(expandTilde(destination));

	// Move the actual project directory first
	try {
		await fsExtra.move(resolvedSource, resolvedDestination);
		console.error(`Moved ${collapseHomedir(resolvedSource)} → ${collapseHomedir(resolvedDestination)}`);
	} catch (error) {
		if (isErrnoException(error) && error.code === 'ENOENT') {
			console.error(`Error: source directory does not exist: ${collapseHomedir(resolvedSource)}`);
		} else {
			console.error(`Error: failed to move directory: ${error instanceof Error ? error.message : String(error)}`);
		}

		process.exitCode = 1;
		return;
	}

	const mergedConfig = await getMergedConfig(resolvedDestination);
	const account = options.account ?? mergedConfig.account;
	const claudeConfigDir = getAccountPrimaryDir(launcherRegistry.claude, account);
	if (!claudeConfigDir) {
		throw new Error('Claude launcher is missing account metadata');
	}

	const projectsDir = path.join(claudeConfigDir, 'projects');

	const encodedSource = encodeProjectPath(resolvedSource);
	const encodedDestination = encodeProjectPath(resolvedDestination);
	const sourceDataDir = path.join(projectsDir, encodedSource);
	const destinationDataDir = path.join(projectsDir, encodedDestination);

	// Move Claude project data directory
	try {
		await fs.access(destinationDataDir);
		console.error(`Error: destination data directory already exists: ${collapseHomedir(destinationDataDir)}`);
		process.exitCode = 1;
		return;
	} catch {
		// Doesn't exist — good
	}

	try {
		await fsExtra.move(sourceDataDir, destinationDataDir);
		console.error(`Moved ${collapseHomedir(sourceDataDir)} → ${collapseHomedir(destinationDataDir)}`);
	} catch (error) {
		if (isErrnoException(error) && error.code === 'ENOENT') {
			console.error(`Warning: no Claude project data at ${collapseHomedir(sourceDataDir)} (no sessions yet?)`);
		} else {
			throw error;
		}
	}

	// Update claudex config project keys
	const collapsedSource = collapseHomedir(resolvedSource);
	const collapsedDestination = collapseHomedir(resolvedDestination);
	const sourceKeys = new Set([ resolvedSource, collapsedSource ]);

	const configEntries = await readAllConfigFiles();
	for (const entry of configEntries) {
		if (!entry.config.projects) {
			continue;
		}

		const matchingKey = Object.keys(entry.config.projects).find(key => sourceKeys.has(expandTilde(key)));
		if (!matchingKey) {
			continue;
		}

		const projectConfig = entry.config.projects[matchingKey];
		const { [matchingKey]: _, ...remainingProjects } = entry.config.projects;
		entry.config.projects = { ...remainingProjects, [collapsedDestination]: projectConfig };

		// eslint-disable-next-line no-await-in-loop
		await writeSingleConfigFile(entry.path, entry.config);
		console.error(`Updated project key in ${collapseHomedir(entry.path)}: ${matchingKey} → ${collapsedDestination}`);
	}
}


async function runMain(claudeArgs: string[], options: MainOptions) {
	const {
		docker: useDocker,
		dockerShell: useDockerShell,
		dockerPull,
		dockerNoCache,
		dockerSkipBuild,
		dockerSudo,
		dockerInsecure,
		allowUnsafeDirectory,
		package: cliPackages,
		volume: cliVolumes,
		env: cliEnv,
		envFile: cliEnvFiles,
		envMode: cliEnvModeRaw,
		sshKey: cliSshKeys,
		dockerArg: cliDockerArg,
		dockerArgs: cliDockerArgsString,
		launcher: cliLauncher,
		model: cliModel,
		account: cliAccount,
		noAccount,
	} = options;

	let cliEnvMode: 'all' | 'explicit' | undefined;
	if (cliEnvModeRaw === 'all' || cliEnvModeRaw === 'explicit') {
		cliEnvMode = cliEnvModeRaw;
	} else if (cliEnvModeRaw !== undefined) {
		throw new Error(`Invalid --env-mode value: ${cliEnvModeRaw}. Expected 'all' or 'explicit'.`);
	}

	const cliDockerArgs = [ ...cliDockerArg, ...(cliDockerArgsString ? cliDockerArgsString.split(' ') : []) ];

	// Read config early for hook/mcp gating
	const earlyConfig = await getMergedConfig(process.cwd());
	const hooksResolved = resolveHooks(earlyConfig.config.hooks);
	const mcpServersResolved = resolveMcpServers(earlyConfig.config.mcpServers);

	const account = noAccount ? undefined : (cliAccount ?? earlyConfig.account);

	const earlyLauncherName = cliLauncher ?? earlyConfig.config.launcher;
	const earlySpec: LauncherSpec = resolveLauncherSpec(earlyLauncherName ?? 'claude', earlyConfig.launcherDefinitions);
	const earlyLauncherDef = earlyLauncherName
		? resolveLauncherDefinition(earlyLauncherName, earlyConfig.launcherDefinitions)
		: undefined;

	await ensureAccountDirsForSpec(earlySpec, account);

	// Companion launchers: ensure their account dirs exist too, so docker bind
	// mounts have something to mount. Skip names already in the primary's wraps
	// chain (they share account dirs).
	const earlyPrimaryNames = new Set(walkSpecWraps(earlySpec).map(s => s.name));
	for (const name of earlyConfig.config.launchers ?? []) {
		if (earlyPrimaryNames.has(name)) {
			continue;
		}

		const compSpec = resolveLauncherSpec(name, earlyConfig.launcherDefinitions);
		// eslint-disable-next-line no-await-in-loop
		await ensureAccountDirsForSpec(compSpec, account);
	}

	if (account) {
		console.error(`Account: ${account}`);
	}

	const earlyHookStrategy = effectiveSpecField(earlySpec, 'hookStrategy');
	if (earlyHookStrategy === 'claude-settings') {
		const claudeDir = getAccountPrimaryDir(launcherRegistry.claude, account);
		await ensureHookSetup(claudeDir, earlyConfig.config.launcherOverrides?.claude?.settings);
	}

	if (earlyHookStrategy === 'opencode-plugin') {
		const { ensureOpenCodePluginSetup } = await import('./hooks.js');
		await ensureOpenCodePluginSetup();
	}

	if (earlyHookStrategy === 'codex-hooks-json') {
		const codexDir = getAccountPrimaryDir(launcherRegistry.codex, account);
		if (codexDir) {
			const { ensureCodexHookSetup } = await import('./hooks.js');
			await ensureCodexHookSetup(codexDir);
		}
	}

	// Ensure MCP server is configured wherever the active launcher expects it.
	const currentFileUrl = import.meta.url;
	const currentFilePath = fileURLToPath(currentFileUrl);
	const projectRoot = path.resolve(path.dirname(currentFilePath), '..');
	const earlyMcpWiring = effectiveSpecField(earlySpec, 'mcpWiring');
	if (mcpServersResolved.claudex) {
		switch (earlyMcpWiring) {
			case 'claude-json': {
				const claudeDir = account ? getAccountPrimaryDir(launcherRegistry.claude, account) : undefined;
				await ensureMcpServerConfig(projectRoot, claudeDir);
				break;
			}

			case 'opencode-config': {
				const opencodeConfigDir = getAccountPrimaryDir(launcherRegistry.opencode, account);
				if (opencodeConfigDir) {
					const { ensureOpencodeMcpConfig } = await import('./hooks.js');
					await ensureOpencodeMcpConfig(opencodeConfigDir, projectRoot);
				}

				break;
			}

			case 'codex-config': {
				const codexDir = getAccountPrimaryDir(launcherRegistry.codex, account);
				if (codexDir) {
					const { ensureCodexMcpConfig } = await import('./hooks.js');
					await ensureCodexMcpConfig(codexDir, projectRoot);
				}

				break;
			}

			case 'none':
			case undefined: {
				break;
			}
		}
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

	await copyResumeSessionIfElsewhere(claudeArgs, cwd, earlySpec, account);

	let claudeChildProcess;
	let dockerContainerName: string | undefined;
	let dockerAttachEvents: ReturnType<typeof watchAttachEvents> | undefined;
	let sshAgent: SshAgentInfo | undefined;
	let hostSocket: { socketPath: string; cleanup: () => Promise<void> } | undefined;
	let cleanupHostPortProxies: (() => void) | undefined;

	const launcherName = earlyLauncherName;
	const launcherDef: LauncherDefinition | undefined = earlyLauncherDef;
	if (launcherName) {
		console.error(`Launcher: ${launcherName}`);
	}

	if (useDocker) {
		const { config, profileVolumes, group, profiles, project } = await getMergedConfig(cwd);

		if (project) {
			console.error(`Project: ${collapseHomedir(project)}`);
		}

		if (group) {
			console.error(`Group: ${group}`);
		}

		if (profiles && profiles.length > 0) {
			console.error(`Profiles: ${profiles.join(', ')}`);
		}

		const cliInDockerPath = path.join(projectRoot, 'build', 'cli.js');

		const spec = resolveLauncherSpec(launcherName ?? 'claude', earlyConfig.launcherDefinitions);
		const permissionFlags = effectiveSpecField(spec, 'permissionFlags');
		const launcherOverride = resolveLauncherOverride(config.launcherOverrides, launcherName, launcherDef);
		const dockerClaudeArgs = [
			...(permissionFlags?.dangerouslySkip && config.dockerDangerouslySkipPermissions ? [ permissionFlags.dangerouslySkip ] : []),
			...(permissionFlags?.allowDangerouslySkip && config.dockerAllowDangerouslySkipPermissions ? [ permissionFlags.allowDangerouslySkip ] : []),
			...(launcherOverride.args ?? []),
			...claudeArgs,
		];

		({
			childProcess: claudeChildProcess,
			containerName: dockerContainerName,
			sshAgent,
			hostSocket,
			cleanupHostPortProxies,
		} = await runDockerContainer({
			cwd,
			config,
			account,
			profileVolumes,
			launcherDef,
			launcherName,
			launcherDefinitions: earlyConfig.launcherDefinitions,
			cliPackages,
			cliVolumes,
			cliEnv,
			cliEnvFiles,
			cliEnvMode,
			cliSshKeys,
			cliModel,
			dockerSudo,
			dockerInsecure,
			cliDockerArgs,
			useDockerShell,
			dockerPull,
			dockerNoCache,
			dockerSkipBuild,
			claudeArgs: dockerClaudeArgs,
			cliInDockerPath,
		}));

		if (dockerContainerName) {
			dockerAttachEvents = watchAttachEvents(dockerContainerName);
		}
	} else {
		// Load config for settingSources even in non-Docker mode
		const { config, profileVolumes } = await getMergedConfig(cwd);
		const spec = resolveLauncherSpec(launcherName ?? 'claude', earlyConfig.launcherDefinitions);
		const cliFeatures = effectiveSpecField(spec, 'cliFeatures');

		// Load env-file values for non-Docker mode. In 'all' mode every loaded var is
		// added to the child env; in 'explicit' mode they only feed ${VAR} resolution.
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
		const envMode = cliEnvMode ?? config.envMode ?? 'explicit';
		const childEnv: Record<string, string | undefined> = { ...process.env };
		if (envMode === 'all') {
			Object.assign(childEnv, envFileValues);
		}

		const envLookup: Record<string, string | undefined> = { ...process.env, ...envFileValues };

		// Resolve config.env entries against the file-augmented lookup so ${VAR}
		// references can pick up values from env files.
		if (config.env) {
			for (const [ key, value ] of Object.entries(config.env)) {
				const match = /^\${(.+)}$/.exec(value);
				if (match) {
					const looked = envLookup[match[1]];
					if (looked !== undefined) {
						childEnv[key] = looked;
					}
				} else {
					childEnv[key] = value;
				}
			}
		}

		const claudeFullArgs: string[] = [];
		if (cliFeatures?.settingSources) {
			const settingSources = config.settingSources ?? 'user,local';
			console.error(`Setting sources: ${settingSources}`);
			claudeFullArgs.push('--setting-sources', settingSources);
		}

		if (cliFeatures?.addDir) {
			const addDirArgs = await buildAddDirArgs(config, cwd, projectRoot, profileVolumes);
			claudeFullArgs.push(...addDirArgs);
		}

		const launcherOverride = resolveLauncherOverride(config.launcherOverrides, launcherName, launcherDef);
		if (launcherOverride.args) {
			claudeFullArgs.push(...launcherOverride.args);
		}

		if (launcherOverride.env) {
			for (const [ key, value ] of Object.entries(launcherOverride.env)) {
				const match = /^\${(.+)}$/.exec(value);
				if (match) {
					const looked = envLookup[match[1]];
					if (looked !== undefined) {
						childEnv[key] = looked;
					}
				} else {
					childEnv[key] = value;
				}
			}
		}

		claudeFullArgs.push(...claudeArgs);

		if (launcherDef) {
			const { command: launcherCmd, args: launcherArgs } = buildLauncherCommand(launcherDef, cliModel, claudeFullArgs, launcherName);
			claudeChildProcess = execa(launcherCmd, launcherArgs, {
				stdin: process.stdin,
				stdout: process.stdout,
				stderr: process.stderr,
				env: childEnv,
			});
		} else {
			claudeChildProcess = execa('claude', claudeFullArgs, {
				stdin: process.stdin,
				stdout: process.stdout,
				stderr: process.stderr,
				env: childEnv,
			});
		}
	}

	try {
		await createClaudeCodeMemory(earlyConfig.config.hooksDescriptions === false ? undefined : hooksResolved, account ? getAccountPrimaryDir(launcherRegistry.claude, account) : undefined);
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
	} catch {
		// Docker attach exits non-zero on clean detach (Ctrl+P Ctrl+Q); defer to event check
	} finally {
		// If the user detached, leave the container for re-attach.
		// If the entrypoint exited, remove the container.
		if (dockerContainerName && dockerAttachEvents) {
			const outcome = await dockerAttachEvents.stop();
			await cleanupOrDetachPrimary(dockerContainerName, outcome);
		}

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
