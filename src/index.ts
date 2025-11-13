import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { checkForClaudeCodeUpdate } from './update.js';
import { createClaudeCodeMemory } from './memory.js';
import { ensureHookSetup } from './hooks.js';
import { paths } from './paths.js';
import { readConfig, expandVolumePaths } from './config.js';

async function ensureDockerImage(pull = false) {
	const userInfo = os.userInfo();
	const userId = userInfo.uid;
	const { username } = userInfo;

	const currentFileUrl = import.meta.url;
	const currentFilePath = fileURLToPath(currentFileUrl);
	const projectRoot = path.resolve(path.dirname(currentFilePath), '..');
	const dockerfilePath = path.join(projectRoot, 'Dockerfile');

	const config = await readConfig();

	// Always build image (Docker cache makes this fast if nothing changed)
	const buildArgs = [
		'build',
	];

	if (pull) {
		buildArgs.push('--pull');
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

	buildArgs.push('-t', 'claudex', '-');

	const dockerfileContent = await fs.readFile(dockerfilePath, 'utf8');

	await execa('docker', buildArgs, {
		input: dockerfileContent,
		stdout: process.stdout,
		stderr: process.stderr,
	});

	return { userId, username, projectRoot };
}

export async function main() {
	const args = process.argv.slice(2);

	await ensureHookSetup();

	const noDockerIndex = args.indexOf('--no-docker');
	const useDocker = noDockerIndex === -1;

	const dockerShellIndex = args.indexOf('--docker-shell');
	const useDockerShell = dockerShellIndex !== -1;

	const dockerPullIndex = args.indexOf('--docker-pull');
	const dockerPull = dockerPullIndex !== -1;

	const claudeArgs = args.filter((_, index) =>
		index !== noDockerIndex && index !== dockerShellIndex && index !== dockerPullIndex);

	let claudeChildProcess;

	if (useDocker) {
		const { username, projectRoot } = await ensureDockerImage(dockerPull);

		const config = await readConfig();

		const cwd = process.cwd();
		const homeDir = os.homedir();
		const claudeConfigDir = path.join(homeDir, '.claude');
		const claudeConfigFile = path.join(homeDir, '.claude.json');
		const cliInDockerPath = path.join(projectRoot, 'build', 'cli-in-docker.js');

		const dockerArgs = [
			'run',
			'--rm',
			'-it',
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

		// Add volumes from config
		if (config.volumes) {
			for (const volume of config.volumes) {
				const expandedVolume = expandVolumePaths(volume);
				dockerArgs.push('-v', `${expandedVolume.host}:${expandedVolume.container}`);
			}
		}

		// Add environment variables from config
		if (config.env) {
			for (const [key, value] of Object.entries(config.env)) {
				// Check if value is a reference to host environment variable
				const match = value.match(/^\$\{(.+)\}$/);
				if (match) {
					const hostVarName = match[1];
					const hostValue = process.env[hostVarName];
					if (hostValue !== undefined) {
						dockerArgs.push('-e', `${key}=${hostValue}`);
					}
					// Skip if host variable is not defined
				} else {
					// Use literal value
					dockerArgs.push('-e', `${key}=${value}`);
				}
			}
		}

		dockerArgs.push('-w', cwd);

		if (useDockerShell) {
			dockerArgs.push('--entrypoint', 'bash', 'claudex');
		} else {
			dockerArgs.push('--entrypoint', 'node', 'claudex', cliInDockerPath, ...claudeArgs);
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
		await checkForClaudeCodeUpdate();
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

export async function mainInDocker() {
	await setupHookSymlinks();

	// Now exec claude with all arguments
	const args = process.argv.slice(2);

	await execa('claude', args, {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	});
}
