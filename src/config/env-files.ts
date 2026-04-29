import path from 'node:path';
import fs from 'node:fs/promises';
import { parse as parseDotenv } from 'dotenv';
import { expandTilde, isErrnoException } from '../utils.js';

// Suffixes after `.env.` that should NOT be auto-loaded — these are conventionally
// templates, not real env files.
const templateSuffixes = new Set([ 'example', 'sample', 'template', 'dist' ]);

export type EnvFileSource = {
	path: string;
	optional: boolean;
};

async function listAutoEnvFiles(cwd: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(cwd);
	} catch {
		return [];
	}

	const dotted: string[] = [];
	let hasEnv = false;

	for (const name of entries) {
		if (name === '.env') {
			hasEnv = true;
			continue;
		}

		if (!name.startsWith('.env.')) {
			continue;
		}

		const suffix = name.slice('.env.'.length);
		if (templateSuffixes.has(suffix)) {
			continue;
		}

		dotted.push(name);
	}

	dotted.sort((a, b) => a.localeCompare(b));
	const ordered = hasEnv ? [ '.env', ...dotted ] : dotted;
	return ordered.map(name => path.join(cwd, name));
}

function resolveExplicitPath(filePath: string, cwd: string): string {
	const expanded = expandTilde(filePath);
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

export async function resolveEnvFileSources(parameters: {
	envFile: boolean | string | undefined;
	envFiles: string[] | undefined;
	cliEnvFiles: string[];
	cwd: string;
}): Promise<EnvFileSource[]> {
	const { envFile, envFiles, cliEnvFiles, cwd } = parameters;
	const sources: EnvFileSource[] = [];

	if (envFile === true) {
		const autoPaths = await listAutoEnvFiles(cwd);
		for (const p of autoPaths) {
			sources.push({ path: p, optional: true });
		}
	} else if (typeof envFile === 'string') {
		sources.push({ path: resolveExplicitPath(envFile, cwd), optional: false });
	}

	for (const file of envFiles ?? []) {
		sources.push({ path: resolveExplicitPath(file, cwd), optional: false });
	}

	for (const file of cliEnvFiles) {
		sources.push({ path: resolveExplicitPath(file, cwd), optional: false });
	}

	return sources;
}

export async function loadEnvFileSources(sources: EnvFileSource[]): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const source of sources) {
		let content: string;
		try {
			// eslint-disable-next-line no-await-in-loop
			content = await fs.readFile(source.path, 'utf8');
		} catch (error) {
			if (source.optional && isErrnoException(error) && error.code === 'ENOENT') {
				continue;
			}

			if (isErrnoException(error) && error.code === 'ENOENT') {
				console.error(`Warning: env file not found: ${source.path}`);
				continue;
			}

			throw error;
		}

		const parsed = parseDotenv(content);
		Object.assign(result, parsed);
	}

	return result;
}
