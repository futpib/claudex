import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { paths } from '../paths.js';
import type { ClaudexConfig } from '../config/index.js';

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

// Image refs we pin to cached digests. BuildKit otherwise re-resolves these
// against the registry on every build, even on a full cache hit.
const pinnedImageRefs = [
	'archlinux:latest',
	'docker/dockerfile:1',
] as const;

const digestCacheFile = 'image-digests.json';

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

async function readCachedDigests(): Promise<Record<string, string>> {
	try {
		const content = await fs.readFile(path.join(paths.cache, digestCacheFile), 'utf8');
		const parsed = JSON.parse(content) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, string>;
		}
	} catch {
		// missing or malformed — treat as empty cache
	}

	return {};
}

async function writeCachedDigests(digests: Record<string, string>): Promise<void> {
	await fs.mkdir(paths.cache, { recursive: true });
	const finalPath = path.join(paths.cache, digestCacheFile);
	// Atomic write: concurrent claudex launches (across projects or within one)
	// all share this cache file. Rename is atomic on POSIX, so readers never
	// see a truncated file; last writer wins, and since writers are producing
	// the same upstream-resolved digests, "losing" the race is harmless.
	const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmpPath, JSON.stringify(digests, null, 2));
	await fs.rename(tmpPath, finalPath);
}

export function pinDockerfile(content: string, digests: Record<string, string>): string {
	let result = content;
	for (const ref of pinnedImageRefs) {
		const digest = digests[ref];
		if (!digest) {
			continue;
		}

		// Append @<digest> to occurrences of the ref that aren't followed by
		// another ref-like character (avoids matching longer tags that share
		// a prefix, e.g. `docker/dockerfile:10` vs `docker/dockerfile:1`).
		const pattern = new RegExp(`${escapeRegExp(ref)}(?![\\w.:@/-])`, 'g');
		result = result.replaceAll(pattern, `${ref}@${digest}`);
	}

	return result;
}

async function resolveImageDigest(ref: string): Promise<string | undefined> {
	try {
		const { stdout } = await execa('docker', [
			'buildx', 'imagetools', 'inspect', ref,
			'--format', '{{.Manifest.Digest}}',
		], { timeout: 15_000 });
		const digest = stdout.trim();
		return /^sha256:[a-f0-9]+$/.test(digest) ? digest : undefined;
	} catch {
		return undefined;
	}
}

export function getDockerImageMeta(cwd: string) {
	const userInfo = os.userInfo();
	const userId = userInfo.uid;
	const { username } = userInfo;

	const currentFileUrl = import.meta.url;
	const currentFilePath = fileURLToPath(currentFileUrl);
	const projectRoot = path.resolve(path.dirname(currentFilePath), '../..');
	const dockerfilePath = path.join(projectRoot, 'Dockerfile');

	const cwdBasename = path.basename(cwd);

	const imageName = `claudex-${cwdBasename}`.toLowerCase();

	return {
		userId, username, projectRoot, dockerfilePath, imageName,
	};
}

export async function ensureDockerImage(cwd: string, config: ClaudexConfig, pull = false, noCache = false) {
	const { userId, username, projectRoot, dockerfilePath, imageName } = getDockerImageMeta(cwd);

	const commonArgs: string[] = [
		'--build-arg',
		`USER_ID=${userId}`,
		'--build-arg',
		`USERNAME=${username}`,
	];

	if (config.packages && config.packages.length > 0) {
		commonArgs.push('--build-arg', `PACKAGES=${config.packages.join(' ')}`);
	}

	if (config.rootInitCommands && config.rootInitCommands.length > 0) {
		commonArgs.push('--build-arg', `ROOT_INIT_COMMANDS=${JSON.stringify(config.rootInitCommands)}`);
	}

	if (config.userInitCommands && config.userInitCommands.length > 0) {
		commonArgs.push('--build-arg', `USER_INIT_COMMANDS=${JSON.stringify(config.userInitCommands)}`);
	}

	commonArgs.push('-t', imageName, '-');

	// Without --pull=false, BuildKit contacts the registry on every build to
	// re-resolve mutable tags (e.g. archlinux:latest), adding seconds of latency
	// even on a full cache hit. Skip that unless the caller explicitly wants a
	// pull, or is rebuilding without cache (where fresh bases are expected).
	const buildFlags = (useNoCache: boolean): string[] => {
		const flags = [ 'build' ];
		if (pull) {
			flags.push('--pull');
		} else if (!useNoCache) {
			flags.push('--pull=false');
		}

		if (useNoCache) {
			flags.push('--no-cache');
		}

		return flags;
	};

	const dockerfileContent = await fs.readFile(dockerfilePath, 'utf8');
	const cachedDigests = await readCachedDigests();
	const pinnedDockerfile = pinDockerfile(dockerfileContent, cachedDigests);

	const runBuild = async (args: string[], input: string) => execa('docker', args, {
		input,
		stdout: process.stdout,
		stderr: process.stderr,
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			DOCKER_BUILDKIT: '1',
		},
	});

	try {
		await runBuild([ ...buildFlags(noCache), ...commonArgs ], pinnedDockerfile);
	} catch (error) {
		if (noCache) {
			throw error;
		}

		// Stale digest cache can cause the pinned build to fail with "manifest
		// not found"; retry with the unpinned Dockerfile so the registry can
		// re-resolve the current digest.
		console.error('Docker build failed, retrying with --no-cache...');
		await runBuild([ ...buildFlags(true), ...commonArgs ], dockerfileContent);
	}

	return {
		userId, username, projectRoot, imageName, dockerfileContent,
	};
}

export async function refreshDockerDigestsInBackground(): Promise<void> {
	try {
		const current = await readCachedDigests();
		const resolved: Record<string, string> = { ...current };
		await Promise.all(pinnedImageRefs.map(async ref => {
			const digest = await resolveImageDigest(ref);
			if (digest) {
				resolved[ref] = digest;
			}
		}));
		await writeCachedDigests(resolved);
	} catch {
		// best-effort — next launch will retry
	}
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
