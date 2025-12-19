import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { paths } from './paths.js';

export interface VolumeMount {
	host: string;
	container: string;
}

export type Volume = string | VolumeMount;

export interface SshConfig {
	keys?: string[];
	keysByPath?: Record<string, string[]>;
}

export interface ClaudexConfig {
	packages?: string[];
	volumes?: Volume[];
	env?: Record<string, string>;
	ssh?: SshConfig;
}

export function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
}

export function getSshKeysForPath(config: ClaudexConfig, cwd: string): string[] {
	const keys: string[] = [];

	// Add global keys
	if (config.ssh?.keys) {
		for (const key of config.ssh.keys) {
			keys.push(expandTilde(key));
		}
	}

	// Add path-specific keys
	if (config.ssh?.keysByPath) {
		for (const [ pathPrefix, pathKeys ] of Object.entries(config.ssh.keysByPath)) {
			const expandedPrefix = expandTilde(pathPrefix);
			if (cwd === expandedPrefix || cwd.startsWith(expandedPrefix + '/')) {
				for (const key of pathKeys) {
					keys.push(expandTilde(key));
				}
			}
		}
	}

	return keys;
}

export function expandVolumePaths(volume: Volume): VolumeMount {
	if (typeof volume === 'string') {
		const expandedPath = expandTilde(volume);
		return {
			host: expandedPath,
			container: expandedPath,
		};
	}

	return {
		host: expandTilde(volume.host),
		container: expandTilde(volume.container),
	};
}

function sortVolumes(volumes: Volume[]): Volume[] {
	return volumes.slice().sort((a, b) => {
		const aKey = typeof a === 'string' ? a : a.host;
		const bKey = typeof b === 'string' ? b : b.host;
		return aKey.localeCompare(bKey);
	});
}

function sortEnv(env: Record<string, string>): Record<string, string> {
	const sortedKeys = Object.keys(env).sort((a, b) => a.localeCompare(b));
	const sortedEnv: Record<string, string> = {};
	for (const key of sortedKeys) {
		sortedEnv[key] = env[key];
	}
	return sortedEnv;
}

export async function readConfig(): Promise<ClaudexConfig> {
	const configPath = path.join(paths.config, 'config.json');

	try {
		const configContent = await fs.readFile(configPath, 'utf8');
		const config = JSON.parse(configContent) as ClaudexConfig;

		return {
			packages: config.packages ? [...config.packages].sort((a, b) => a.localeCompare(b)) : [],
			volumes: config.volumes ? sortVolumes(config.volumes) : [],
			env: config.env ? sortEnv(config.env) : {},
			ssh: config.ssh,
		};
	} catch {
		// Return defaults if config doesn't exist or is invalid
		return {
			packages: [],
			volumes: [],
			env: {},
		};
	}
}
