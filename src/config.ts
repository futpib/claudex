import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { paths } from './paths.js';

export interface VolumeMount {
	host: string;
	container: string;
}

export type Volume = string | VolumeMount;

export interface ClaudexConfig {
	packages?: string[];
	volumes?: Volume[];
	env?: Record<string, string>;
}

function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}
	return filePath;
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

export async function readConfig(): Promise<ClaudexConfig> {
	const configPath = path.join(paths.config, 'config.json');

	try {
		const configContent = await fs.readFile(configPath, 'utf8');
		const config = JSON.parse(configContent) as ClaudexConfig;

		return {
			packages: config.packages ?? [],
			volumes: config.volumes ?? [],
			env: config.env ?? {},
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
