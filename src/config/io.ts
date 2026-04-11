import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../paths.js';
import { isErrnoException, expandTilde } from '../utils.js';
import { mergeRootConfigs } from './merge.js';
import { rootConfigSchema, type RootConfig } from './schema.js';

function parseConfigFile(filePath: string, content: string): RootConfig {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	try {
		return rootConfigSchema.parse(json);
	} catch (error) {
		throw new Error(`Invalid config in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

type ReadRootConfigResult = {
	config: RootConfig;
	configFiles: string[];
};

export async function readRootConfig(): Promise<ReadRootConfigResult> {
	const configDir = paths.config;
	const configPath = path.join(configDir, 'config.json');
	const configJsonDirectoryPath = path.join(configDir, 'config.json.d');

	let merged: RootConfig = {};
	const configFiles: string[] = [];

	// Read main config.json
	try {
		const content = await fs.readFile(configPath, 'utf8');
		merged = parseConfigFile(configPath, content);
		configFiles.push(configPath);
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	// Read all .json files from config.json.d/
	try {
		const files = await fs.readdir(configJsonDirectoryPath);
		const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

		for (const file of jsonFiles) {
			const filePath = path.join(configJsonDirectoryPath, file);
			// eslint-disable-next-line no-await-in-loop
			const content = await fs.readFile(filePath, 'utf8');
			const parsed = parseConfigFile(filePath, content);
			merged = mergeRootConfigs(merged, parsed);
			configFiles.push(filePath);
		}
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	return { config: merged, configFiles };
}

export function getConfigDir(): string {
	return paths.config;
}

export async function readSingleConfigFile(filePath: string): Promise<RootConfig> {
	const content = await fs.readFile(filePath, 'utf8');
	return parseConfigFile(filePath, content);
}

export async function writeSingleConfigFile(filePath: string, config: RootConfig): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n');
}

export type ConfigFileEntry = {
	path: string;
	config: RootConfig;
};

export async function readAllConfigFiles(): Promise<ConfigFileEntry[]> {
	const configDir = paths.config;
	const configPath = path.join(configDir, 'config.json');
	const configJsonDirectoryPath = path.join(configDir, 'config.json.d');
	const entries: ConfigFileEntry[] = [];

	try {
		const content = await fs.readFile(configPath, 'utf8');
		entries.push({ path: configPath, config: parseConfigFile(configPath, content) });
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	try {
		const files = await fs.readdir(configJsonDirectoryPath);
		const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

		for (const file of jsonFiles) {
			const filePath = path.join(configJsonDirectoryPath, file);
			// eslint-disable-next-line no-await-in-loop
			const content = await fs.readFile(filePath, 'utf8');
			entries.push({ path: filePath, config: parseConfigFile(filePath, content) });
		}
	} catch (error) {
		if (!isErrnoException(error) || error.code !== 'ENOENT') {
			throw error;
		}
	}

	return entries;
}

export type FindConfigFileResult = ConfigFileEntry | 'ambiguous' | 'none';

export async function findConfigFileForProject(projectPath: string): Promise<FindConfigFileResult> {
	const entries = await readAllConfigFiles();
	const expandedProjectPath = expandTilde(projectPath);
	const matches = entries.filter(entry => {
		if (!entry.config.projects) {
			return false;
		}

		return Object.keys(entry.config.projects).some(key => expandTilde(key) === expandedProjectPath);
	});

	if (matches.length === 1) {
		return matches[0];
	}

	if (matches.length > 1) {
		return 'ambiguous';
	}

	return 'none';
}

export async function findConfigFileForGroup(groupName: string): Promise<FindConfigFileResult> {
	const entries = await readAllConfigFiles();
	const matches = entries.filter(entry => entry.config.groupDefinitions?.[groupName] !== undefined);

	if (matches.length === 1) {
		return matches[0];
	}

	if (matches.length > 1) {
		return 'ambiguous';
	}

	return 'none';
}

export async function findConfigFileForProfile(profileName: string): Promise<FindConfigFileResult> {
	const entries = await readAllConfigFiles();
	const matches = entries.filter(entry => entry.config.profileDefinitions?.[profileName] !== undefined);

	if (matches.length === 1) {
		return matches[0];
	}

	if (matches.length > 1) {
		return 'ambiguous';
	}

	return 'none';
}
