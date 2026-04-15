import process from 'node:process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';
import { paths } from '../paths.js';
import type { ClaudexConfig } from '../config/index.js';

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

async function fetchText(url: string): Promise<string | undefined> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
		if (!response.ok) {
			console.error(`Warning: GET ${url} returned ${response.status}`);
			return undefined;
		}

		const body = await response.text();
		return body.trim() || undefined;
	} catch (error) {
		console.error(`Warning: failed to fetch ${url}: ${describeError(error)}`);
		return undefined;
	}
}

async function getLatestClaudeCodeVersion(): Promise<string | undefined> {
	return fetchText('https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest');
}

async function getLatestYayVersion(): Promise<string | undefined> {
	const body = await fetchText('https://aur.archlinux.org/rpc/v5/info?arg[]=yay');
	if (!body) {
		return undefined;
	}

	try {
		const data = JSON.parse(body) as { results: Array<{ Version: string }> };
		return data.results[0]?.Version;
	} catch (error) {
		console.error(`Warning: failed to parse AUR response: ${describeError(error)}`);
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

function isEnoent(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readCachedDigests(): Promise<Record<string, string>> {
	const file = path.join(paths.cache, digestCacheFile);
	try {
		const content = await fs.readFile(file, 'utf8');
		const parsed = JSON.parse(content) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, string>;
		}

		console.error(`Warning: ${file} is not a JSON object; ignoring digest cache.`);
	} catch (error) {
		if (!isEnoent(error)) {
			console.error(`Warning: failed to read ${file}: ${describeError(error)}`);
		}
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
	const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temporaryPath, JSON.stringify(digests, null, 2));
	await fs.rename(temporaryPath, finalPath);
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
			'buildx',
			'imagetools',
			'inspect',
			ref,
			'--format',
			'{{.Manifest.Digest}}',
		], { timeout: 15_000 });
		const digest = stdout.trim();
		if (/^sha256:[a-f\d]+$/.test(digest)) {
			return digest;
		}

		console.error(`Warning: unexpected digest format for ${ref}: ${digest}`);
		return undefined;
	} catch (error) {
		console.error(`Warning: failed to resolve digest for ${ref}: ${describeError(error)}`);
		return undefined;
	}
}

// Maps imageName → { hash, builtAt }. Lets us skip `docker build` entirely
// (saving BuildKit's ~3s baseline) when nothing has changed, and drive the
// stale-while-revalidate rebuild in the background.
const imageHashCacheFile = 'image-hashes.json';

// Force a background rebuild if the cached image is older than this, even
// when no tracked input has changed. Catches upstream drift we don't track
// explicitly (e.g. arch package updates behind a `RUN pacman -Syu` layer).
const imageRefreshTtlMs = 7 * 24 * 60 * 60 * 1000;

type ImageCacheEntry = {
	hash: string;
	builtAt: number;
};

function isValidCacheEntry(value: unknown): value is ImageCacheEntry {
	return typeof value === 'object'
		&& value !== null
		&& typeof (value as ImageCacheEntry).hash === 'string'
		&& typeof (value as ImageCacheEntry).builtAt === 'number';
}

async function readImageHashCache(): Promise<Record<string, ImageCacheEntry>> {
	const file = path.join(paths.cache, imageHashCacheFile);
	try {
		const content = await fs.readFile(file, 'utf8');
		const parsed = JSON.parse(content) as unknown;
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const result: Record<string, ImageCacheEntry> = {};
			for (const [ key, value ] of Object.entries(parsed)) {
				if (isValidCacheEntry(value)) {
					result[key] = value;
				}
			}

			return result;
		}

		console.error(`Warning: ${file} is not a JSON object; ignoring image hash cache.`);
	} catch (error) {
		if (!isEnoent(error)) {
			console.error(`Warning: failed to read ${file}: ${describeError(error)}`);
		}
	}

	return {};
}

async function writeImageHashCache(cache: Record<string, ImageCacheEntry>): Promise<void> {
	await fs.mkdir(paths.cache, { recursive: true });
	const finalPath = path.join(paths.cache, imageHashCacheFile);
	const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temporaryPath, JSON.stringify(cache, null, 2));
	await fs.rename(temporaryPath, finalPath);
}

async function readTrackedVersions(): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	await Promise.all(refreshTargets.map(async target => {
		const file = path.join(paths.cache, `${target.name}-version`);
		try {
			const content = await fs.readFile(file, 'utf8');
			result[target.name] = content.trim();
		} catch (error) {
			if (!isEnoent(error)) {
				console.error(`Warning: failed to read ${file}: ${describeError(error)}`);
			}
		}
	}));
	return result;
}

function computeBuildHash(
	pinnedDockerfile: string,
	commonArgs: readonly string[],
	versions: Record<string, string>,
): string {
	const hash = crypto.createHash('sha256');
	hash.update(pinnedDockerfile);
	for (const arg of commonArgs) {
		hash.update('\0');
		hash.update(arg);
	}

	for (const [ name, version ] of Object.entries(versions).sort(([ a ], [ b ]) => a.localeCompare(b))) {
		hash.update('\0');
		hash.update(`${name}=${version}`);
	}

	return hash.digest('hex');
}

async function imageExistsLocally(imageName: string): Promise<boolean> {
	try {
		await execa('docker', [ 'image', 'inspect', imageName ], {
			stdout: 'ignore',
			stderr: 'ignore',
		});
		return true;
	} catch {
		return false;
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

function buildDockerCommonArgs(
	config: ClaudexConfig,
	userId: number,
	username: string,
	imageName: string,
): string[] {
	const args: string[] = [
		'--build-arg',
		`USER_ID=${userId}`,
		'--build-arg',
		`USERNAME=${username}`,
	];

	if (config.packages && config.packages.length > 0) {
		args.push('--build-arg', `PACKAGES=${config.packages.join(' ')}`);
	}

	if (config.rootInitCommands && config.rootInitCommands.length > 0) {
		args.push('--build-arg', `ROOT_INIT_COMMANDS=${JSON.stringify(config.rootInitCommands)}`);
	}

	if (config.userInitCommands && config.userInitCommands.length > 0) {
		args.push('--build-arg', `USER_INIT_COMMANDS=${JSON.stringify(config.userInitCommands)}`);
	}

	args.push('-t', imageName, '-');
	return args;
}

export async function ensureDockerImage(cwd: string, config: ClaudexConfig, pull = false, noCache = false) {
	const { userId, username, projectRoot, dockerfilePath, imageName } = getDockerImageMeta(cwd);
	const commonArgs = buildDockerCommonArgs(config, userId, username, imageName);

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
	const versions = await readTrackedVersions();

	// Short-circuit: if the hash of (Dockerfile + build-args + tracked
	// versions) matches what produced the current local image, skip BuildKit
	// entirely — even a fully-cached build has a ~3s client→daemon→export
	// floor. Stale-while-revalidate: a background task rebuilds stale images.
	const buildHash = computeBuildHash(pinnedDockerfile, commonArgs, versions);
	if (!pull && !noCache) {
		const hashes = await readImageHashCache();
		if (hashes[imageName]?.hash === buildHash && await imageExistsLocally(imageName)) {
			return {
				userId, username, projectRoot, imageName, dockerfileContent,
			};
		}
	}

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

	const hashes = await readImageHashCache();
	hashes[imageName] = { hash: buildHash, builtAt: Date.now() };
	await writeImageHashCache(hashes);

	return {
		userId, username, projectRoot, imageName, dockerfileContent,
	};
}

async function fetchLatestDigests(): Promise<Record<string, string>> {
	const current = await readCachedDigests();
	const resolved: Record<string, string> = { ...current };
	await Promise.all(pinnedImageRefs.map(async ref => {
		const digest = await resolveImageDigest(ref);
		if (digest) {
			resolved[ref] = digest;
		}
	}));
	return resolved;
}

async function fetchLatestVersions(): Promise<Record<string, string>> {
	const resolved = await readTrackedVersions();
	await Promise.all(refreshTargets.map(async target => {
		const latestVersion = await target.getLatestVersion();
		if (latestVersion) {
			resolved[target.name] = latestVersion;
		}
	}));
	return resolved;
}

async function writeVersionCache(versions: Record<string, string>): Promise<void> {
	await fs.mkdir(paths.cache, { recursive: true });
	await Promise.all(Object.entries(versions).map(async ([ name, version ]) => {
		await fs.writeFile(path.join(paths.cache, `${name}-version`), version);
	}));
}

async function acquireImageRefreshLock(imageName: string): Promise<{ release: () => Promise<void> } | undefined> {
	await fs.mkdir(paths.cache, { recursive: true });
	const lockFile = path.join(paths.cache, `docker-image-refresh.${imageName}.lock`);
	let lockHandle: Awaited<ReturnType<typeof fs.open>>;
	try {
		lockHandle = await fs.open(lockFile, 'wx');
	} catch {
		return undefined;
	}

	return {
		async release() {
			await lockHandle.close();
			try {
				await fs.unlink(lockFile);
			} catch (error: unknown) {
				if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
					console.error('Warning: failed to remove lock file:', error.message);
				}
			}
		},
	};
}

// Stale-while-revalidate: ensureDockerImage always serves fast (pinning + hash
// short-circuit). This orchestrator runs after every launch to rebuild the
// image in the background when upstream has drifted or the TTL has expired.
// Caches (digests, versions, hash) are only persisted after a successful
// rebuild, so an interrupted background run leaves the next foreground launch
// with consistent state — it short-circuits on the old image and we retry.
export async function refreshDockerImageInBackground(cwd: string, config: ClaudexConfig): Promise<void> {
	const { userId, username, dockerfilePath, imageName } = getDockerImageMeta(cwd);

	const lock = await acquireImageRefreshLock(imageName);
	if (!lock) {
		return;
	}

	try {
		const [ latestDigests, latestVersions ] = await Promise.all([
			fetchLatestDigests(),
			fetchLatestVersions(),
		]);

		const dockerfileContent = await fs.readFile(dockerfilePath, 'utf8');
		const pinnedDockerfile = pinDockerfile(dockerfileContent, latestDigests);
		const commonArgs = buildDockerCommonArgs(config, userId, username, imageName);
		const freshHash = computeBuildHash(pinnedDockerfile, commonArgs, latestVersions);

		const hashes = await readImageHashCache();
		const stored = hashes[imageName];
		const hashChanged = stored?.hash !== freshHash;
		const ttlExpired = stored ? (Date.now() - stored.builtAt) > imageRefreshTtlMs : true;

		if (!hashChanged && !ttlExpired && await imageExistsLocally(imageName)) {
			return;
		}

		// TTL-driven rebuilds use --no-cache so untracked drift (arch package
		// updates inside `RUN pacman -Syu`) is picked up. Hash-driven rebuilds
		// can rely on BuildKit invalidation from changed digests/ARGs.
		const args = [ 'build', '--pull=false' ];
		if (ttlExpired && !hashChanged) {
			args.push('--no-cache');
		}

		args.push(...commonArgs);

		try {
			await execa('docker', args, {
				input: pinnedDockerfile,
				// Capture stderr so we can surface it on failure; suppress it
				// on success (it's noisy in the middle of a session).
				stdout: 'ignore',
				stderr: 'pipe',
				env: {
					...process.env,
					// eslint-disable-next-line @typescript-eslint/naming-convention
					DOCKER_BUILDKIT: '1',
				},
			});
			await writeCachedDigests(latestDigests);
			await writeVersionCache(latestVersions);
			hashes[imageName] = { hash: freshHash, builtAt: Date.now() };
			await writeImageHashCache(hashes);
		} catch (error) {
			// Rebuild failed — leave the old caches alone so the next
			// foreground launch keeps short-circuiting on the old image.
			let stderr = '';
			if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string') {
				stderr = error.stderr.trim();
			}

			console.error(`Warning: background docker build failed for ${imageName}: ${describeError(error)}${stderr ? `\n${stderr}` : ''}`);
		}
	} finally {
		await lock.release();
	}
}
