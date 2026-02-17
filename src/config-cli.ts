import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createPatch } from 'diff';
import {
	getMergedConfig,
	getConfigDir,
	readSingleConfigFile,
	writeSingleConfigFile,
	findConfigFileForProject,
	findConfigFileForGroup,
	findConfigFileForProfile,
	readAllConfigFiles,
	getGitWorktreeParentPath,
	expandTilde,
	resolveHooks,
	resolveMcpServers,
	baseConfigSchema,
	validTopLevelKeys,
	fixedSubKeyFields,
	recordFields,
	allMcpServerFlags,
	type RootConfig,
	type BaseConfig,
	type ProjectConfig,
} from './config.js';
import { allConfigKeys } from './hooks/rules/index.js';
import { collapseHomedir } from './utils.js';

type Action = 'list' | 'get' | 'set' | 'add' | 'remove' | 'unset' | 'keys' | 'group' | 'ungroup';

type Scope =
	| { type: 'project'; path: string; fromCwd?: boolean }
	| { type: 'global' }
	| { type: 'group'; name: string }
	| { type: 'profile'; name: string };

type ParsedArgs = {
	action: Action;
	scope: Scope;
	file?: string;
	key?: string;
	value?: string;
	extraValues?: string[];
	members?: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
	const args = [ ...argv ];

	let scope: Scope | undefined;
	let file: string | undefined;
	let isGlobal = false;
	let members = false;

	const positionals: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		switch (arg) {
			case '--global': {
				isGlobal = true;

				break;
			}

			case '--project': {
				i++;
				const projectPath = args[i];
				if (!projectPath) {
					throw new Error('--project requires a path argument');
				}

				scope = { type: 'project', path: projectPath };

				break;
			}

			case '--group': {
				i++;
				const groupName = args[i];
				if (!groupName) {
					throw new Error('--group requires a name argument');
				}

				scope = { type: 'group', name: groupName };

				break;
			}

			case '--profile': {
				i++;
				const profileName = args[i];
				if (!profileName) {
					throw new Error('--profile requires a name argument');
				}

				scope = { type: 'profile', name: profileName };

				break;
			}

			case '--file': {
				i++;
				file = args[i];
				if (!file) {
					throw new Error('--file requires a path argument');
				}

				break;
			}

			case '--members': {
				members = true;

				break;
			}

			default: {
				positionals.push(arg);
			}
		}
	}

	const action = positionals[0] as Action;
	const key = positionals[1];
	const value = positionals[2];
	const extraValues = (action === 'add' || action === 'group') ? positionals.slice(2) : undefined;

	if (action === 'ungroup') {
		if (isGlobal) {
			if (scope) {
				throw new Error('--global cannot be combined with --project or --group');
			}

			scope = { type: 'global' };
		}

		scope ??= { type: 'project', path: process.cwd(), fromCwd: true };

		return {
			action, scope, file, key: undefined, value: undefined, extraValues: positionals.slice(1), members,
		};
	}

	if (isGlobal) {
		if (scope) {
			throw new Error('--global cannot be combined with --project or --group');
		}

		scope = { type: 'global' };
	}

	scope ??= { type: 'project', path: process.cwd(), fromCwd: true };

	return {
		action, scope, file, key, value, extraValues, members,
	};
}

function collapseTilde(filePath: string): string {
	const homedir = fs.realpathSync(os.homedir());
	const realPath = fs.realpathSync(filePath);
	if (realPath === homedir || realPath.startsWith(homedir + '/')) {
		return '~' + realPath.slice(homedir.length);
	}

	return filePath;
}

function serializeConfig(config: RootConfig): string {
	return JSON.stringify(config, null, 2) + '\n';
}

function printDiff(filePath: string, oldContent: string, newContent: string): void {
	if (oldContent === newContent) {
		return;
	}

	const patch = createPatch(collapseTilde(filePath), oldContent, newContent);
	process.stderr.write(patch);
}

function findProjectKey(projects: Record<string, unknown>, scopePath: string): string | undefined {
	const expandedScopePath = expandTilde(scopePath);
	return Object.keys(projects).find(key => expandTilde(key) === expandedScopePath);
}

function getSection(config: RootConfig, scope: Scope): BaseConfig | ProjectConfig | RootConfig | undefined {
	switch (scope.type) {
		case 'global': {
			return config;
		}

		case 'project': {
			if (!config.projects) {
				return undefined;
			}

			const key = findProjectKey(config.projects, scope.path);
			return key ? config.projects[key] : undefined;
		}

		case 'group': {
			return config.groupDefinitions?.[scope.name];
		}

		case 'profile': {
			return config.profileDefinitions?.[scope.name];
		}
	}
}

function ensureSection(config: RootConfig, scope: Scope): BaseConfig | ProjectConfig | RootConfig {
	switch (scope.type) {
		case 'global': {
			return config;
		}

		case 'project': {
			config.projects ??= {};
			const existingKey = findProjectKey(config.projects, scope.path);
			const key = existingKey ?? scope.path;
			config.projects[key] ??= {};
			return config.projects[key];
		}

		case 'group': {
			config.groupDefinitions ??= {};
			config.groupDefinitions[scope.name] ??= {};
			return config.groupDefinitions[scope.name];
		}

		case 'profile': {
			config.profileDefinitions ??= {};
			config.profileDefinitions[scope.name] ??= {};
			return config.profileDefinitions[scope.name];
		}
	}
}

type KeyInfo = {
	field: string;
	subKey?: string;
};

function parseKey(key: string): KeyInfo {
	const dotIndex = key.indexOf('.');
	if (dotIndex === -1) {
		return { field: key };
	}

	return {
		field: key.slice(0, dotIndex),
		subKey: key.slice(dotIndex + 1),
	};
}

const booleanCoercionFields = new Set(Object.entries(baseConfigSchema.shape)
	.filter(([ , schema ]) => schema.safeParse(true).success)
	.map(([ key ]) => key));

const numberCoercionFields = new Set(Object.entries(baseConfigSchema.shape)
	.filter(([ , schema ]) => schema.safeParse([ 1 ]).success)
	.map(([ key ]) => key));

function coerceValue(field: string, value: string): string | number | boolean {
	if (numberCoercionFields.has(field)) {
		const number_ = Number(value);
		if (!Number.isInteger(number_) || number_ <= 0) {
			throw new Error(`Invalid port number: ${value}`);
		}

		return number_;
	}

	if (booleanCoercionFields.has(field)) {
		if (value === 'true') {
			return true;
		}

		if (value === 'false') {
			return false;
		}

		throw new Error(`Invalid boolean value: ${value}. Expected 'true' or 'false'`);
	}

	return value;
}

function validateKey(keyInfo: KeyInfo, scope: Scope): void {
	// Check top-level field
	if (!validTopLevelKeys.has(keyInfo.field) && keyInfo.field !== 'group') {
		throw new Error(`Unknown configuration key: ${keyInfo.field}. Run 'claudex config keys' to see available keys.`);
	}

	// 'group' is only valid in project scope
	if (keyInfo.field === 'group' && scope.type !== 'project') {
		throw new Error('\'group\' can only be set in project scope (use --project)');
	}

	// Check subkey validity
	if (keyInfo.subKey) {
		if (recordFields.has(keyInfo.field)) {
			// Allow arbitrary subkeys for record fields
			return;
		}

		const validSubKeys = fixedSubKeyFields[keyInfo.field];
		if (validSubKeys && !validSubKeys.has(keyInfo.subKey)) {
			throw new Error(`Unknown subkey '${keyInfo.subKey}' for '${keyInfo.field}'. Valid subkeys: ${[ ...validSubKeys ].join(', ')}`);
		}
	}
}

function resolveBooleanToDetail(field: string, currentValue: unknown): unknown {
	if (currentValue !== true) {
		return currentValue;
	}

	if (field === 'hooks') {
		return resolveHooks(true);
	}

	if (field === 'mcpServers') {
		return resolveMcpServers(true);
	}

	return currentValue;
}

async function resolveWriteFile(scope: Scope, file: string | undefined): Promise<string> {
	const configDir = getConfigDir();

	if (file) {
		return path.resolve(configDir, file);
	}

	const defaultFile = path.join(configDir, 'config.json');

	switch (scope.type) {
		case 'global': {
			return defaultFile;
		}

		case 'project': {
			const result = await findConfigFileForProject(scope.path);
			if (result === 'ambiguous') {
				throw new Error(`Project "${scope.path}" is defined in multiple config files. Use --file to specify which one.`);
			}

			if (result === 'none') {
				return defaultFile;
			}

			return result.path;
		}

		case 'group': {
			const result = await findConfigFileForGroup(scope.name);
			if (result === 'ambiguous') {
				throw new Error(`Group "${scope.name}" is defined in multiple config files. Use --file to specify which one.`);
			}

			if (result === 'none') {
				return defaultFile;
			}

			return result.path;
		}

		case 'profile': {
			const result = await findConfigFileForProfile(scope.name);
			if (result === 'ambiguous') {
				throw new Error(`Profile "${scope.name}" is defined in multiple config files. Use --file to specify which one.`);
			}

			if (result === 'none') {
				return defaultFile;
			}

			return result.path;
		}
	}
}

function getValue(section: BaseConfig | ProjectConfig | undefined, keyInfo: KeyInfo): unknown {
	if (!section) {
		return undefined;
	}

	const record = section as Record<string, unknown>;
	const fieldValue = record[keyInfo.field];

	if (keyInfo.subKey && fieldValue && typeof fieldValue === 'object') {
		return (fieldValue as Record<string, unknown>)[keyInfo.subKey];
	}

	return fieldValue;
}

function formatValue(value: unknown): string {
	if (value === undefined) {
		return '';
	}

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	return JSON.stringify(value, null, 2);
}

async function handleList(scope: Scope, members?: boolean): Promise<void> {
	if (members) {
		if (scope.type !== 'group') {
			throw new Error('--members requires --group');
		}

		const allFiles = await readAllConfigFiles();
		let merged: RootConfig = {};
		for (const entry of allFiles) {
			merged = { ...merged, ...entry.config };
		}

		if (merged.projects) {
			for (const [ projectPath, projectConfig ] of Object.entries(merged.projects)) {
				if ((projectConfig as Record<string, unknown>).group === scope.name) {
					console.log(projectPath);
				}
			}
		}

		return;
	}

	if (scope.type === 'project') {
		const { config } = await getMergedConfig(scope.path);
		console.log(JSON.stringify(config, null, 2));
		return;
	}

	// For global and group, read merged root config and extract section
	const { config: rootConfig } = await getMergedConfig(process.cwd());

	if (scope.type === 'global') {
		const { projects: _, groupDefinitions: _g, profileDefinitions: _pd, ...base } = rootConfig as unknown as RootConfig;
		console.log(JSON.stringify(base, null, 2));
		return;
	}

	if (scope.type === 'profile') {
		const allFiles = await readAllConfigFiles();
		let merged: RootConfig = {};
		for (const entry of allFiles) {
			merged = { ...merged, ...entry.config };
		}

		const profileConfig = merged.profileDefinitions?.[scope.name];
		if (profileConfig) {
			console.log(JSON.stringify(profileConfig, null, 2));
		} else {
			console.log('{}');
		}

		return;
	}

	// Group - get from merged root
	// We need to read the root config directly for group listing
	const allFiles = await readAllConfigFiles();
	let merged: RootConfig = {};
	for (const entry of allFiles) {
		merged = { ...merged, ...entry.config };
	}

	const groupConfig = merged.groupDefinitions?.[scope.name];
	if (groupConfig) {
		console.log(JSON.stringify(groupConfig, null, 2));
	} else {
		console.log('{}');
	}
}

async function handleGet(scope: Scope, key: string): Promise<void> {
	const keyInfo = parseKey(key);

	if (scope.type === 'project') {
		const { config } = await getMergedConfig(scope.path);
		const value = getValue(config, keyInfo);
		const formatted = formatValue(value);
		if (formatted) {
			console.log(formatted);
		}

		return;
	}

	// For global/group, we need the merged root config
	const { config } = await getMergedConfig(process.cwd());

	let section: BaseConfig | ProjectConfig | undefined;
	if (scope.type === 'global') {
		section = config;
	} else if (scope.type === 'profile') {
		// For profile, read root and get profile section
		const configModule = await import('./config.js');
		const allFiles = await configModule.readAllConfigFiles();
		let merged: RootConfig = {};
		for (const entry of allFiles) {
			merged = { ...merged, ...entry.config };
		}

		section = merged.profileDefinitions?.[scope.name];
	} else {
		// For group, read root and get group section
		const configModule = await import('./config.js');
		const allFiles = await configModule.readAllConfigFiles();
		let merged: RootConfig = {};
		for (const entry of allFiles) {
			merged = { ...merged, ...entry.config };
		}

		section = merged.groupDefinitions?.[scope.name];
	}

	const value = getValue(section, keyInfo);
	const formatted = formatValue(value);
	if (formatted) {
		console.log(formatted);
	}
}

async function handleSet(scope: Scope, key: string, value: string, file: string | undefined): Promise<void> {
	const keyInfo = parseKey(key);
	validateKey(keyInfo, scope);
	const filePath = await resolveWriteFile(scope, file);

	let config: RootConfig;
	try {
		config = await readSingleConfigFile(filePath);
	} catch {
		config = {};
	}

	const oldContent = serializeConfig(config);
	const section = ensureSection(config, scope);
	const coerced = coerceValue(keyInfo.field, value);

	if (keyInfo.subKey) {
		const record = section as Record<string, unknown>;
		const resolved = resolveBooleanToDetail(keyInfo.field, record[keyInfo.field]);
		const existing = (resolved ?? {}) as Record<string, unknown>;
		existing[keyInfo.subKey] = coerced;
		record[keyInfo.field] = existing;
	} else {
		// Scalar field
		(section as Record<string, unknown>)[keyInfo.field] = coerced;
	}

	await writeSingleConfigFile(filePath, config);
	printDiff(filePath, oldContent, serializeConfig(config));
}

async function getGlobalArrayValues(field: string): Promise<unknown[]> {
	const entries = await readAllConfigFiles();
	const values: unknown[] = [];
	for (const entry of entries) {
		const array = (entry.config as Record<string, unknown>)[field];
		if (Array.isArray(array)) {
			for (const item of array as unknown[]) {
				values.push(item);
			}
		}
	}

	return values;
}

async function handleAdd(scope: Scope, key: string, values: string[], file: string | undefined): Promise<void> {
	const keyInfo = parseKey(key);
	validateKey(keyInfo, scope);

	const filePath = await resolveWriteFile(scope, file);
	let config: RootConfig;
	try {
		config = await readSingleConfigFile(filePath);
	} catch {
		config = {};
	}

	const oldContent = serializeConfig(config);
	const section = ensureSection(config, scope);
	const record = section as Record<string, unknown>;

	const globalValues = scope.type === 'global' ? undefined : await getGlobalArrayValues(keyInfo.field);

	if (keyInfo.subKey) {
		// For nested array fields (ssh.keys, ssh.hosts)
		const resolved = resolveBooleanToDetail(keyInfo.field, record[keyInfo.field]);
		const parent = (resolved ?? {}) as Record<string, unknown>;
		const existing = (parent[keyInfo.subKey] ?? []) as unknown[];

		const globalParent = (globalValues?.find(v => typeof v === 'object' && v !== null) ?? {}) as Record<string, unknown>;
		const globalSubValues = globalValues ? (globalParent[keyInfo.subKey] ?? []) as unknown[] : [];

		for (const value of values) {
			const coerced = coerceValue(keyInfo.field, value);
			const collapsed = typeof coerced === 'string' ? collapseHomedir(coerced) : coerced;
			if (existing.includes(collapsed)) {
				console.error(`${key} already contains ${value} in ${scope.type} config`);
			} else if (globalSubValues.includes(collapsed)) {
				console.error(`${key} already contains ${value} in global config`);
			} else {
				existing.push(collapsed);
			}
		}

		parent[keyInfo.subKey] = existing;
		record[keyInfo.field] = parent;
	} else {
		const existing = (record[keyInfo.field] ?? []) as unknown[];

		for (const value of values) {
			const coerced = coerceValue(keyInfo.field, value);
			const collapsed = typeof coerced === 'string' ? collapseHomedir(coerced) : coerced;
			if (existing.includes(collapsed)) {
				console.error(`${keyInfo.field} already contains ${value} in ${scope.type} config`);
			} else if (globalValues?.includes(collapsed)) {
				console.error(`${keyInfo.field} already contains ${value} in global config`);
			} else {
				existing.push(collapsed);
			}
		}

		record[keyInfo.field] = existing;
	}

	await writeSingleConfigFile(filePath, config);
	printDiff(filePath, oldContent, serializeConfig(config));
}

async function handleUnset(scope: Scope, key: string, value: string | undefined, file: string | undefined): Promise<void> {
	const keyInfo = parseKey(key);
	const filePath = await resolveWriteFile(scope, file);

	let config: RootConfig;
	try {
		config = await readSingleConfigFile(filePath);
	} catch {
		config = {};
	}

	const oldContent = serializeConfig(config);

	const section = getSection(config, scope);
	if (!section) {
		return;
	}

	const record = section as Record<string, unknown>;

	if (keyInfo.subKey) {
		const resolved = resolveBooleanToDetail(keyInfo.field, record[keyInfo.field]);
		if (resolved !== record[keyInfo.field]) {
			record[keyInfo.field] = resolved;
		}

		if (value === undefined) {
			// Remove entire sub-key from record
			const parent = record[keyInfo.field] as Record<string, unknown> | undefined;
			if (!parent) {
				return;
			}

			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete parent[keyInfo.subKey];
			if (Object.keys(parent).length === 0) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete record[keyInfo.field];
			}
		} else {
			// Remove specific value from nested array (e.g., ssh.keys <value>)
			const parent = record[keyInfo.field] as Record<string, unknown> | undefined;
			if (!parent) {
				return;
			}

			const array = parent[keyInfo.subKey];
			if (Array.isArray(array)) {
				parent[keyInfo.subKey] = array.filter((v: unknown) => String(v) !== value);
				if ((parent[keyInfo.subKey] as unknown[]).length === 0) {
					// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
					delete parent[keyInfo.subKey];
				}
			} else {
				// Delete record entry (e.g., env.KEY, extraHosts.HOST)
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete parent[keyInfo.subKey];
			}

			if (Object.keys(parent).length === 0) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete record[keyInfo.field];
			}
		}
	} else if (value === undefined) {
		// Remove entire key
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete record[keyInfo.field];
	} else {
		// Remove specific value from array
		const array = record[keyInfo.field];
		if (Array.isArray(array)) {
			const coerced = coerceValue(keyInfo.field, value);
			record[keyInfo.field] = array.filter((v: unknown) => v !== coerced);
			if ((record[keyInfo.field] as unknown[]).length === 0) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete record[keyInfo.field];
			}
		}
	}

	await writeSingleConfigFile(filePath, config);
	printDiff(filePath, oldContent, serializeConfig(config));
}

async function handleRemove(scope: Scope, key: string, value: string | undefined, file: string | undefined): Promise<void> {
	const keyInfo = parseKey(key);

	if (!keyInfo.subKey && value === undefined) {
		throw new Error('remove requires a value argument (e.g., remove packages vim or remove packages.vim)');
	}

	const filePath = await resolveWriteFile(scope, file);

	let config: RootConfig;
	try {
		config = await readSingleConfigFile(filePath);
	} catch {
		config = {};
	}

	const oldContent = serializeConfig(config);

	const section = getSection(config, scope);
	if (!section) {
		return;
	}

	const record = section as Record<string, unknown>;

	if (keyInfo.subKey) {
		const resolved = resolveBooleanToDetail(keyInfo.field, record[keyInfo.field]);
		if (resolved !== record[keyInfo.field]) {
			record[keyInfo.field] = resolved;
		}
	}

	if (keyInfo.subKey && value !== undefined) {
		// Nested array: `remove ssh.keys ~/.ssh/id_ed25519`
		const parent = record[keyInfo.field] as Record<string, unknown> | undefined;
		if (!parent) {
			return;
		}

		const array = parent[keyInfo.subKey];
		const collapsedValue = collapseHomedir(value);
		if (Array.isArray(array)) {
			parent[keyInfo.subKey] = array.filter((v: unknown) => String(v) !== collapsedValue && String(v) !== value);
			if ((parent[keyInfo.subKey] as unknown[]).length === 0) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete parent[keyInfo.subKey];
			}
		}

		if (Object.keys(parent).length === 0) {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete record[keyInfo.field];
		}
	} else if (keyInfo.subKey) {
		// Dot notation without value: `remove packages.vim` or `remove env.FOO`
		const fieldValue = record[keyInfo.field];
		if (fieldValue === undefined) {
			return;
		}

		if (Array.isArray(fieldValue)) {
			// `remove packages.vim` → remove 'vim' from packages array
			const coerced = coerceValue(keyInfo.field, keyInfo.subKey);
			record[keyInfo.field] = fieldValue.filter((v: unknown) => v !== coerced);
			if ((record[keyInfo.field] as unknown[]).length === 0) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete record[keyInfo.field];
			}
		} else if (typeof fieldValue === 'object' && fieldValue !== null) {
			// `remove env.FOO` → delete FOO from env record
			const parent = fieldValue as Record<string, unknown>;
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete parent[keyInfo.subKey];
			if (Object.keys(parent).length === 0) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete record[keyInfo.field];
			}
		}
	} else {
		// Flat: `remove packages vim`
		const fieldValue = record[keyInfo.field];
		if (fieldValue === undefined) {
			return;
		}

		if (Array.isArray(fieldValue)) {
			const coerced = coerceValue(keyInfo.field, value!);
			const collapsed = typeof coerced === 'string' ? collapseHomedir(coerced) : coerced;
			record[keyInfo.field] = fieldValue.filter((v: unknown) => v !== collapsed && v !== coerced);
			if ((record[keyInfo.field] as unknown[]).length === 0) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete record[keyInfo.field];
			}
		} else if (typeof fieldValue === 'object' && fieldValue !== null) {
			// `remove env FOO` → delete FOO from env record
			const parent = fieldValue as Record<string, unknown>;
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete parent[value!];
			if (Object.keys(parent).length === 0) {
				// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
				delete record[keyInfo.field];
			}
		}
	}

	await writeSingleConfigFile(filePath, config);
	printDiff(filePath, oldContent, serializeConfig(config));
}

type KeyEntry = { key: string; type: string };

function getKeyEntries(): KeyEntry[] {
	const entries: KeyEntry[] = [];

	const fieldTypes: Record<string, string> = {
		packages: 'string[]',
		volumes: 'string[]',
		hostPorts: 'number[]',
		shareVolumes: 'boolean',
		settingSources: 'string',
		hooks: 'boolean',
		mcpServers: 'boolean',
		notifications: 'boolean',
		hooksDescriptions: 'boolean',
		profiles: 'string[]',
	};

	for (const field of validTopLevelKeys) {
		entries.push({ key: field, type: fieldTypes[field] ?? 'string' });

		switch (field) {
			case 'env':
			case 'extraHosts': {
				const placeholder = field === 'env' ? '<KEY>' : '<HOST>';
				entries.push({ key: `${field}.${placeholder}`, type: 'string' });
				break;
			}

			case 'ssh': {
				entries.push(
					{ key: 'ssh.keys', type: 'string[]' },
					{ key: 'ssh.hosts', type: 'string[]' },
				);
				break;
			}

			case 'hooks': {
				for (const subKey of allConfigKeys) {
					entries.push({ key: `hooks.${subKey}`, type: 'boolean' });
				}

				break;
			}

			case 'mcpServers': {
				for (const subKey of allMcpServerFlags) {
					entries.push({ key: `mcpServers.${subKey}`, type: 'boolean' });
				}

				break;
			}

			default: {
				break;
			}
		}
	}

	entries.push({ key: 'group', type: 'string (project only)' });

	return entries;
}

function handleKeys(): void {
	const entries = getKeyEntries();
	const maxKeyLength = Math.max(...entries.map(entry => entry.key.length));

	for (const entry of entries) {
		console.log(`${entry.key.padEnd(maxKeyLength + 4)}${entry.type}`);
	}
}

async function handleGroup(name: string, paths: string[], file: string | undefined): Promise<void> {
	const scope: Scope = { type: 'global' };
	const filePath = await resolveWriteFile(scope, file);

	let config: RootConfig;
	try {
		config = await readSingleConfigFile(filePath);
	} catch {
		config = {};
	}

	const oldContent = serializeConfig(config);

	// Auto-create group if it doesn't exist
	config.groupDefinitions ??= {};
	config.groupDefinitions[name] ??= {};

	// Resolve all paths concurrently (worktree → parent repo, then tilde-collapse)
	config.projects ??= {};
	const resolvedPaths = await Promise.all(paths.map(async projectPath => {
		let resolvedPath = path.resolve(projectPath);
		const worktreeParent = await getGitWorktreeParentPath(resolvedPath);
		if (worktreeParent) {
			resolvedPath = worktreeParent;
		}

		return collapseTilde(resolvedPath);
	}));

	// Assign each project to the group
	for (const resolvedPath of resolvedPaths) {
		const existingKey = findProjectKey(config.projects, resolvedPath);
		const key = existingKey ?? resolvedPath;
		config.projects[key] ??= {};
		(config.projects[key] as Record<string, unknown>).group = name;
	}

	await writeSingleConfigFile(filePath, config);
	printDiff(filePath, oldContent, serializeConfig(config));
}

async function handleUngroup(paths: string[], file: string | undefined): Promise<void> {
	const scope: Scope = { type: 'global' };
	const filePath = await resolveWriteFile(scope, file);

	let config: RootConfig;
	try {
		config = await readSingleConfigFile(filePath);
	} catch {
		config = {};
	}

	const oldContent = serializeConfig(config);

	if (!config.projects) {
		await writeSingleConfigFile(filePath, config);
		printDiff(filePath, oldContent, serializeConfig(config));
		return;
	}

	// Resolve all paths concurrently (worktree → parent repo, then tilde-collapse)
	const resolvedPaths = await Promise.all(paths.map(async projectPath => {
		let resolvedPath = path.resolve(projectPath);
		const worktreeParent = await getGitWorktreeParentPath(resolvedPath);
		if (worktreeParent) {
			resolvedPath = worktreeParent;
		}

		return collapseTilde(resolvedPath);
	}));

	// Remove group from each project
	for (const resolvedPath of resolvedPaths) {
		const existingKey = findProjectKey(config.projects, resolvedPath);
		if (!existingKey) {
			continue;
		}

		const project = config.projects[existingKey] as Record<string, unknown>;

		delete project.group;

		// Clean up empty project entries
		if (Object.keys(project).length === 0) {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete config.projects[existingKey];
		}
	}

	// Clean up empty projects object
	if (Object.keys(config.projects).length === 0) {
		delete config.projects;
	}

	await writeSingleConfigFile(filePath, config);
	printDiff(filePath, oldContent, serializeConfig(config));
}

export async function configMain(argv: string[]): Promise<void> {
	const parsed = parseArgs(argv);

	// Resolve implicit cwd scope: worktree → parent repo, absolute → tilde
	if (parsed.scope.type === 'project' && parsed.scope.fromCwd) {
		const worktreeParent = await getGitWorktreeParentPath(parsed.scope.path);
		if (worktreeParent) {
			parsed.scope.path = worktreeParent;
		}

		parsed.scope.path = collapseTilde(parsed.scope.path);
	}

	switch (parsed.action) {
		case 'list': {
			await handleList(parsed.scope, parsed.members);
			break;
		}

		case 'get': {
			if (!parsed.key) {
				throw new Error('get requires a key argument');
			}

			await handleGet(parsed.scope, parsed.key);
			break;
		}

		case 'set': {
			if (!parsed.key) {
				throw new Error('set requires a key argument');
			}

			if (parsed.value === undefined) {
				throw new Error('set requires a value argument');
			}

			await handleSet(parsed.scope, parsed.key, parsed.value, parsed.file);
			break;
		}

		case 'add': {
			if (!parsed.key) {
				throw new Error('add requires a key argument');
			}

			if (!parsed.extraValues || parsed.extraValues.length === 0) {
				throw new Error('add requires at least one value argument');
			}

			await handleAdd(parsed.scope, parsed.key, parsed.extraValues, parsed.file);
			break;
		}

		case 'remove': {
			if (!parsed.key) {
				throw new Error('remove requires a key argument');
			}

			await handleRemove(parsed.scope, parsed.key, parsed.value, parsed.file);
			break;
		}

		case 'unset': {
			if (!parsed.key) {
				throw new Error('unset requires a key argument');
			}

			await handleUnset(parsed.scope, parsed.key, parsed.value, parsed.file);
			break;
		}

		case 'keys': {
			handleKeys();
			break;
		}

		case 'group': {
			if (!parsed.key) {
				throw new Error('group requires a name argument');
			}

			if (!parsed.extraValues || parsed.extraValues.length === 0) {
				throw new Error('group requires at least one project path');
			}

			await handleGroup(parsed.key, parsed.extraValues, parsed.file);
			break;
		}

		case 'ungroup': {
			if (!parsed.extraValues || parsed.extraValues.length === 0) {
				throw new Error('ungroup requires at least one project path');
			}

			await handleUngroup(parsed.extraValues, parsed.file);
			break;
		}
	}
}
