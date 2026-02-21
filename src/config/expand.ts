import process from 'node:process';
import { expandTilde } from '../utils.js';
import type { Volume, VolumeMount } from './schema.js';

// These match bash builtin variable names ($UID, $EUID)
const builtinVars: Record<string, () => string> = {
	UID: () => String(process.getuid?.() ?? ''), // eslint-disable-line @typescript-eslint/naming-convention
	EUID: () => String(process.geteuid?.() ?? ''), // eslint-disable-line @typescript-eslint/naming-convention
};

export function expandEnvVars(value: string): string {
	return value.replaceAll(/\$(\w+)|\${(\w+)}/g, (_match, name1: string | undefined, name2: string | undefined) => {
		const name = name1 ?? name2;
		if (!name) {
			return _match;
		}

		return process.env[name] ?? builtinVars[name]?.() ?? _match;
	});
}

export function expandPathEnv(value: string): string {
	return value
		.split(':')
		.map(p => expandTilde(p))
		.join(':');
}

export function expandEnvValues(env: Record<string, string>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [ key, value ] of Object.entries(env)) {
		result[key] = key === 'PATH' ? expandPathEnv(value) : value;
	}

	return result;
}

function expandPath(value: string): string {
	return expandTilde(expandEnvVars(value));
}

export function expandVolumePaths(volume: Volume): VolumeMount {
	if (typeof volume === 'string') {
		const expandedPath = expandPath(volume);
		return {
			host: expandedPath,
			container: expandedPath,
		};
	}

	return {
		host: expandPath(volume.host),
		container: expandPath(volume.container),
	};
}
