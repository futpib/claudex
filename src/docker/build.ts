import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { paths } from '../paths.js';
import type { ClaudexConfig } from '../config.js';

async function fetchLatestVersion(url: string): Promise<string | undefined> {
	try {
		const { stdout } = await execa('curl', [ '-sL', '--max-time', '5', url ]);
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function getLatestClaudeCodeVersion(): Promise<string | undefined> {
	return fetchLatestVersion('https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest');
}

async function getLatestYayVersion(): Promise<string | undefined> {
	try {
		const { stdout } = await execa('curl', [ '-sL', '--max-time', '5', 'https://aur.archlinux.org/rpc/v5/info?arg[]=yay' ]);
		const data = JSON.parse(stdout) as { results: Array<{ Version: string }> };
		return data.results[0]?.Version;
	} catch {
		return undefined;
	}
}

type RefreshTarget = {
	name: string;
	dockerTarget: string;
	getLatestVersion: () => Promise<string | undefined>;
};

const refreshTargets: RefreshTarget[] = [
	{ name: 'claude-code', dockerTarget: 'claude-code-installer', getLatestVersion: getLatestClaudeCodeVersion },
	{ name: 'yay', dockerTarget: 'yay-builder', getLatestVersion: getLatestYayVersion },
];

export async function ensureDockerImage(cwd: string, config: ClaudexConfig, pull = false, noCache = false) {
	const userInfo = os.userInfo();
	const userId = userInfo.uid;
	const { username } = userInfo;

	const currentFileUrl = import.meta.url;
	const currentFilePath = fileURLToPath(currentFileUrl);
	const projectRoot = path.resolve(path.dirname(currentFilePath), '../..');
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
		userId, username, projectRoot, imageName, dockerfileContent,
	};
}

export async function refreshDockerStagesInBackground(dockerfileContent: string) {
	const cacheDir = paths.cache;
	await fs.mkdir(cacheDir, { recursive: true });
	const lockFile = path.join(cacheDir, 'docker-refresh.lock');

	// Acquire lock (O_EXCL fails if file exists)
	let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		lockHandle = await fs.open(lockFile, 'wx');
	} catch {
		return; // Another refresh is already running
	}

	/* eslint-disable no-await-in-loop */
	// Determine which targets need rebuilding
	const targetsToRebuild: RefreshTarget[] = [];
	for (const target of refreshTargets) {
		const versionFile = path.join(cacheDir, `${target.name}-version`);
		const latestVersion = await target.getLatestVersion();
		if (!latestVersion) {
			continue;
		}

		let cachedVersion: string | undefined;
		try {
			const content = await fs.readFile(versionFile, 'utf8');
			cachedVersion = content.trim();
		} catch (error: unknown) {
			if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
				console.error(`Warning: failed to read ${versionFile}:`, error.message);
			}
		}

		if (cachedVersion !== latestVersion) {
			targetsToRebuild.push(target);
			// Write new version immediately so concurrent launches skip this target
			await fs.writeFile(versionFile, latestVersion);
		}
	}
	/* eslint-enable no-await-in-loop */

	if (targetsToRebuild.length === 0) {
		await lockHandle.close();
		try {
			await fs.unlink(lockFile);
		} catch (error: unknown) {
			if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
				console.error('Warning: failed to remove lock file:', error.message);
			}
		}

		return;
	}

	// Must not be async — execa returns a ResultPromise with .unref(), plain Promise does not
	// eslint-disable-next-line @typescript-eslint/promise-function-async
	const children = targetsToRebuild.map(target => execa('docker', [
		'build',
		'--no-cache',
		'--target',
		target.dockerTarget,
		'-',
	], {
		input: dockerfileContent,
		stdout: 'ignore',
		stderr: 'ignore',
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			DOCKER_BUILDKIT: '1',
		},
	}));

	// Release lock when all done — fire-and-forget (function already returned)
	void (async () => {
		await Promise.allSettled(children);
		await lockHandle?.close();
		try {
			await fs.unlink(lockFile);
		} catch (error: unknown) {
			if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
				console.error('Warning: failed to remove lock file:', error.message);
			}
		}
	})();

	for (const child of children) {
		child.unref();
	}
}
