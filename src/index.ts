import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execa } from 'execa';
import { checkForClaudeCodeUpdate } from './update.js';
import { createClaudeCodeMemory } from './memory.js';
import { ensureHookSetup } from './hooks.js';

async function ensureDockerImage() {
	const userInfo = os.userInfo();
	const userId = userInfo.uid;
	const { username } = userInfo;

	// Check if image exists
	const { stdout } = await execa('docker', [ 'images', '-q', 'claudex' ]);

	if (!stdout.trim()) {
		// Image doesn't exist, build it
		const currentFileUrl = import.meta.url;
		const currentFilePath = fileURLToPath(currentFileUrl);
		const projectRoot = path.resolve(path.dirname(currentFilePath), '..');

		console.log('Building Docker image with your user configuration...');
		await execa('docker', [
			'build',
			'--build-arg',
			`USER_ID=${userId}`,
			'--build-arg',
			`USERNAME=${username}`,
			'-t',
			'claudex',
			projectRoot,
		], {
			stdout: process.stdout,
			stderr: process.stderr,
		});
		console.log('Docker image built successfully!');
	}

	return { userId, username };
}

export async function main() {
	const args = process.argv.slice(2);

	await ensureHookSetup();

	const noDockerIndex = args.indexOf('--no-docker');
	const useDocker = noDockerIndex === -1;

	const shellIndex = args.indexOf('--shell');
	const useShell = shellIndex !== -1;

	const claudeArgs = args.filter((_, index) =>
		index !== noDockerIndex && index !== shellIndex);

	let claudeChildProcess;

	if (useDocker) {
		const { username } = await ensureDockerImage();

		const cwd = process.cwd();
		const homeDir = os.homedir();
		const claudeConfigDir = path.join(homeDir, '.claude');
		const claudeConfigFile = path.join(homeDir, '.claude.json');

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
			'-w',
			cwd,
		];

		if (useShell) {
			dockerArgs.push('--entrypoint', 'bash', 'claudex');
		} else {
			dockerArgs.push('claudex', ...claudeArgs);
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
