import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import {
	getMergedConfig,
	readAllConfigFiles,
	getConfigDir,
	validTopLevelKeys,
	fixedSubKeyFields,
	recordFields,
	type BaseConfig,
	type ConfigFileEntry,
} from './config/index.js';
import {
	configMain, formatValue, getKeyEntries,
	type Scope, type ParsedArgs,
} from './config-cli.js';
import { getGitWorktreeParentPath } from './git.js';
import { collapseHomedir, expandTilde } from './utils.js';

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type InquirerPrompts = Awaited<typeof import('@inquirer/prompts')>;

async function loadInquirer(): Promise<InquirerPrompts> {
	return import('@inquirer/prompts');
}

type PlacementOption = {
	scope: Scope;
	file: string;
	label: string;
};

type ActionContext = {
	inquirer: InquirerPrompts;
	mergedConfig: Record<string, unknown>;
	entries: ConfigFileEntry[];
};

function truncateValue(value: unknown, maxLength: number): string {
	const formatted = formatValue(value);
	if (!formatted) {
		return '(not set)';
	}

	const oneLine = formatted.replaceAll('\n', ' ');
	if (oneLine.length <= maxLength) {
		return oneLine;
	}

	return oneLine.slice(0, maxLength - 3) + '...';
}

function getFieldType(field: string): string {
	const entries = getKeyEntries();
	const entry = entries.find(keyEntry => keyEntry.key === field);
	return entry?.type ?? 'string';
}

function getActionsForType(fieldType: string, hasValue: boolean): Array<{ name: string; value: string }> {
	const actions: Array<{ name: string; value: string }> = [];

	if (fieldType.endsWith('[]')) {
		actions.push({ name: 'Add value', value: 'add' });
		if (hasValue) {
			actions.push({ name: 'Remove value', value: 'remove' });
		}
	} else if (fieldType === 'boolean') {
		actions.push(
			{ name: 'Set to true', value: 'set-true' },
			{ name: 'Set to false', value: 'set-false' },
		);
	} else {
		actions.push({ name: 'Set value', value: 'set' });
	}

	if (hasValue) {
		actions.push({ name: 'Unset (remove entirely)', value: 'unset' });
	}

	actions.push({ name: 'Back', value: 'back' });

	return actions;
}

function getSubKeyActions(hasValue: boolean): Array<{ name: string; value: string }> {
	const actions: Array<{ name: string; value: string }> = [
		{ name: 'Edit subkeys', value: 'subkeys' },
	];

	if (hasValue) {
		actions.push({ name: 'Unset (remove entirely)', value: 'unset' });
	}

	actions.push({ name: 'Back', value: 'back' });
	return actions;
}

async function resolveProjectScope(): Promise<{ scope: Scope; projectPath: string }> {
	const cwd = process.cwd();
	let projectPath = cwd;
	const worktreeParent = await getGitWorktreeParentPath(projectPath);
	if (worktreeParent) {
		projectPath = worktreeParent;
	}

	projectPath = collapseHomedir(fs.realpathSync(projectPath));

	return {
		scope: { type: 'project', path: projectPath },
		projectPath,
	};
}

function findKeyInSection(section: BaseConfig, key: string, arrayValue?: string): boolean {
	const field = key.includes('.') ? key.slice(0, key.indexOf('.')) : key;
	const subKey = key.includes('.') ? key.slice(key.indexOf('.') + 1) : undefined;

	const record = section as Record<string, unknown>;
	if (subKey) {
		const parent = record[field];
		if (typeof parent !== 'object' || parent === null) {
			return false;
		}

		if (!(subKey in (parent as Record<string, unknown>))) {
			return false;
		}

		if (arrayValue === undefined) {
			return true;
		}

		const subValue = (parent as Record<string, unknown>)[subKey];
		return Array.isArray(subValue) && subValue.some(item => String(item) === arrayValue);
	}

	if (record[field] === undefined) {
		return false;
	}

	if (arrayValue === undefined) {
		return true;
	}

	const fieldValue = record[field];
	return Array.isArray(fieldValue) && (fieldValue as unknown[]).some(item => String(item) === arrayValue);
}

function getSectionForScope(entry: ConfigFileEntry, scope: Scope): BaseConfig | undefined {
	switch (scope.type) {
		case 'global': {
			return entry.config;
		}

		case 'project': {
			if (!entry.config.projects) {
				return undefined;
			}

			const expandedPath = expandTilde(scope.path);
			for (const [ projectPath, projectConfig ] of Object.entries(entry.config.projects)) {
				if (expandTilde(projectPath) === expandedPath) {
					return projectConfig;
				}
			}

			return undefined;
		}

		case 'group': {
			return entry.config.groupDefinitions?.[scope.name];
		}

		case 'profile': {
			return entry.config.profileDefinitions?.[scope.name];
		}
	}
}

function findKeyInEntries(
	entries: ConfigFileEntry[],
	key: string,
	scope: Scope,
	arrayValue?: string,
): ConfigFileEntry | undefined {
	for (const entry of entries) {
		const section = getSectionForScope(entry, scope);
		if (section && findKeyInSection(section, key, arrayValue)) {
			return entry;
		}
	}

	return undefined;
}

function findGroupName(entries: ConfigFileEntry[], projectPath: string): string | undefined {
	const expandedPath = expandTilde(projectPath);
	for (const entry of entries) {
		if (!entry.config.projects) {
			continue;
		}

		for (const [ pp, pc ] of Object.entries(entry.config.projects)) {
			if (expandTilde(pp) === expandedPath && pc.group) {
				return pc.group;
			}
		}
	}

	return undefined;
}

type PlacementResult = {
	suggested: PlacementOption;
	alternatives: PlacementOption[];
};

async function computePlacement(
	key: string,
	entries: ConfigFileEntry[],
	arrayValue?: string,
): Promise<PlacementResult> {
	const configDir = getConfigDir();
	const defaultFile = path.join(configDir, 'config.json');
	const { projectPath } = await resolveProjectScope();

	const projectEntry = findKeyInEntries(entries, key, { type: 'project', path: projectPath }, arrayValue);
	const groupName = findGroupName(entries, projectPath);
	const groupEntry = groupName
		? findKeyInEntries(entries, key, { type: 'group', name: groupName }, arrayValue)
		: undefined;
	const globalEntry = findKeyInEntries(entries, key, { type: 'global' }, arrayValue);

	// Build all possible placement options
	const all: PlacementOption[] = [];

	if (projectEntry) {
		all.push({
			scope: { type: 'project', path: projectPath },
			file: projectEntry.path,
			label: `Project (${collapseHomedir(projectPath)}) in ${collapseHomedir(projectEntry.path)}`,
		});
	} else {
		all.push({
			scope: { type: 'project', path: projectPath },
			file: defaultFile,
			label: `Project (${collapseHomedir(projectPath)}) (new) in ${collapseHomedir(defaultFile)}`,
		});
	}

	if (groupName) {
		if (groupEntry) {
			all.push({
				scope: { type: 'group', name: groupName },
				file: groupEntry.path,
				label: `Group "${groupName}" in ${collapseHomedir(groupEntry.path)}`,
			});
		} else {
			all.push({
				scope: { type: 'group', name: groupName },
				file: defaultFile,
				label: `Group "${groupName}" (new) in ${collapseHomedir(defaultFile)}`,
			});
		}
	}

	if (globalEntry) {
		all.push({
			scope: { type: 'global' },
			file: globalEntry.path,
			label: `Global in ${collapseHomedir(globalEntry.path)}`,
		});
	} else {
		all.push({
			scope: { type: 'global' },
			file: defaultFile,
			label: `Global (new) in ${collapseHomedir(defaultFile)}`,
		});
	}

	// Smart suggestion priority:
	// 1. If key exists at project scope → suggest that
	// 2. If key exists at group scope → suggest group
	// 3. Otherwise → suggest project scope (new) in default config
	let suggested: PlacementOption;

	if (projectEntry) {
		suggested = all.find(option => option.scope.type === 'project' && option.file === projectEntry.path)!;
	} else if (groupEntry) {
		suggested = all.find(option => option.scope.type === 'group' && option.file === groupEntry.path)!;
	} else {
		suggested = all[0];
	}

	const alternatives = all.filter(option => option !== suggested);

	return { suggested, alternatives };
}

async function selectPlacement(
	inquirer: InquirerPrompts,
	key: string,
	entries: ConfigFileEntry[],
	arrayValue?: string,
): Promise<PlacementOption | undefined> {
	const { suggested, alternatives } = await computePlacement(key, entries, arrayValue);
	const all = [ suggested, ...alternatives ];

	const choice = await inquirer.select<string>({
		message: 'Where should this change be written?',
		default: suggested.label,
		choices: [
			...all.map(option => ({ name: option.label, value: option.label })),
			{ name: 'Cancel', value: 'cancel' },
		],
	});

	if (choice === 'cancel') {
		return undefined;
	}

	return all.find(option => option.label === choice);
}

async function collectActionValues(
	context: ActionContext,
	key: string,
	action: string,
): Promise<Partial<ParsedArgs> | undefined> {
	const { inquirer, mergedConfig } = context;

	switch (action) {
		case 'set-true': {
			return { action: 'set', value: 'true' };
		}

		case 'set-false': {
			return { action: 'set', value: 'false' };
		}

		case 'set': {
			const currentValue = mergedConfig[key];
			const defaultValue = currentValue === undefined ? undefined : formatValue(currentValue);
			const value = await inquirer.input({
				message: `Value for ${key}:`,
				default: defaultValue ?? undefined,
			});
			return { action: 'set', value };
		}

		case 'add': {
			const values = await inquirer.input({
				message: `Value(s) to add to ${key} (space-separated):`,
			});
			const extraValues = values.split(/\s+/).filter(Boolean);
			if (extraValues.length === 0) {
				return undefined;
			}

			return { action: 'add', extraValues };
		}

		case 'remove': {
			const currentArray = mergedConfig[key];
			if (Array.isArray(currentArray) && currentArray.length > 0) {
				const toRemove = await inquirer.select<string>({
					message: `Select value to remove from ${key}:`,
					choices: (currentArray as unknown[]).map(item => ({
						name: String(item),
						value: String(item),
					})),
				});
				return { action: 'remove', value: toRemove };
			}

			const value = await inquirer.input({
				message: `Value to remove from ${key}:`,
			});
			return { action: 'remove', value };
		}

		case 'unset': {
			return { action: 'unset' };
		}

		default: {
			return undefined;
		}
	}
}

async function runAction(
	context: ActionContext,
	key: string,
	action: string,
): Promise<void> {
	const { inquirer, entries } = context;

	const values = await collectActionValues(context, key, action);
	if (!values) {
		return;
	}

	// For remove/unset, find the file that actually contains the value
	const lookupValue = (action === 'remove' || action === 'unset') ? values.value : undefined;
	const placement = await selectPlacement(inquirer, key, entries, lookupValue);
	if (!placement) {
		return;
	}

	const parsed: ParsedArgs = {
		action: values.action!,
		scope: placement.scope,
		file: placement.file,
		key,
		value: values.value,
		extraValues: values.extraValues,
	};

	try {
		await configMain(parsed);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
	}
}

function buildRecordSubKeyChoices(
	field: string,
	fieldValue: unknown,
): Array<{ name: string; value: string }> {
	// Env, extraHosts — show existing keys + option to add new
	const existingKeys = (fieldValue && typeof fieldValue === 'object')
		? Object.keys(fieldValue as Record<string, unknown>)
		: [];

	const choices = existingKeys.map(key => {
		const value = (fieldValue as Record<string, unknown>)[key];
		return { name: `${key} = ${truncateValue(value, 40)}`, value: key };
	});

	choices.push({ name: '+ Add new key', value: '__add_new__' });
	return choices;
}

function buildFixedSubKeyChoices(
	fixedKeys: Set<string>,
	fieldValue: unknown,
): Array<{ name: string; value: string }> {
	// Hooks, mcpServers, ssh — show fixed subkeys
	return [ ...fixedKeys ].map(key => {
		const value = fieldValue && typeof fieldValue === 'object'
			? (fieldValue as Record<string, unknown>)[key]
			: undefined;
		return { name: `${key}: ${truncateValue(value, 40)}`, value: key };
	});
}

async function handleSubKeyAddNew(
	context: ActionContext,
	field: string,
): Promise<void> {
	const { inquirer, entries } = context;
	const newKey = await inquirer.input({ message: 'New key name:' });
	if (!newKey) {
		return;
	}

	const newValue = await inquirer.input({ message: `Value for ${field}.${newKey}:` });
	const fullKey = `${field}.${newKey}`;
	const placement = await selectPlacement(inquirer, fullKey, entries);
	if (!placement) {
		return;
	}

	try {
		await configMain({
			action: 'set',
			scope: placement.scope,
			file: placement.file,
			key: fullKey,
			value: newValue,
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
	}
}

async function handleSubKeys(
	context: ActionContext,
	field: string,
): Promise<void> {
	const { inquirer, mergedConfig } = context;
	const fieldValue = mergedConfig[field];
	const isRecord = recordFields.has(field);
	const fixedKeys = fixedSubKeyFields[field];

	let subKeyChoices: Array<{ name: string; value: string }>;

	if (isRecord) {
		subKeyChoices = buildRecordSubKeyChoices(field, fieldValue);
	} else if (fixedKeys) {
		subKeyChoices = buildFixedSubKeyChoices(fixedKeys, fieldValue);
	} else {
		return;
	}

	subKeyChoices.push({ name: 'Back', value: '__back__' });

	const subKey = await inquirer.select<string>({
		message: `Select subkey of ${field}:`,
		choices: subKeyChoices,
	});

	if (subKey === '__back__') {
		return;
	}

	if (subKey === '__add_new__') {
		await handleSubKeyAddNew(context, field);
		return;
	}

	// Selected an existing subkey
	const fullKey = `${field}.${subKey}`;
	const subKeyType = getFieldType(fullKey);
	const currentValue = fieldValue && typeof fieldValue === 'object'
		? (fieldValue as Record<string, unknown>)[subKey]
		: undefined;
	const hasValue = currentValue !== undefined;

	const actions = getActionsForType(subKeyType, hasValue);
	const action = await inquirer.select<string>({
		message: `Action for ${fullKey} (current: ${truncateValue(currentValue, 50)}):`,
		choices: actions,
	});

	if (action === 'back') {
		return;
	}

	await runAction(context, fullKey, action);
}

export async function configTuiMain(): Promise<void> {
	let inquirer: InquirerPrompts;
	try {
		inquirer = await loadInquirer();
	} catch {
		console.error('Failed to load @inquirer/prompts. Make sure it is installed.');
		process.exitCode = 1;
		return;
	}

	try {
		await runOnce(inquirer);
	} catch (error) {
		// Clean exit on Ctrl-C (ExitPromptError)
		if (error && typeof error === 'object' && 'name' in error && (error as Error).name === 'ExitPromptError') {
			return;
		}

		throw error;
	}
}

async function runOnce(inquirer: InquirerPrompts): Promise<void> {
	const { config: mergedConfig } = await getMergedConfig(process.cwd());
	const entries = await readAllConfigFiles();
	const configRecord = mergedConfig as Record<string, unknown>;

	const topLevelKeys = [ ...validTopLevelKeys ];
	const keyChoices = topLevelKeys.map(key => ({
		name: `${key}: ${truncateValue(configRecord[key], 60)}`,
		value: key,
	}));

	// Move 'packages' to the top
	const packagesIndex = keyChoices.findIndex(choice => choice.value === 'packages');
	if (packagesIndex > 0) {
		const [ packages ] = keyChoices.splice(packagesIndex, 1);
		keyChoices.unshift(packages);
	}

	keyChoices.push({ name: 'Exit', value: '__exit__' });

	const selectedKey = await inquirer.select<string>({
		message: 'Select a configuration key:',
		choices: keyChoices,
	});

	if (selectedKey === '__exit__') {
		return;
	}

	const context: ActionContext = { inquirer, mergedConfig: configRecord, entries };

	const fieldType = getFieldType(selectedKey);
	const currentValue = configRecord[selectedKey];
	const hasValue = currentValue !== undefined;

	const hasFixedSubKeys = fixedSubKeyFields[selectedKey] !== undefined;
	const isRecordField = recordFields.has(selectedKey);

	if (hasFixedSubKeys || isRecordField) {
		await handleComplexField(context, selectedKey, hasValue);
		return;
	}

	const actions = getActionsForType(fieldType, hasValue);
	const action = await inquirer.select<string>({
		message: `Action for ${selectedKey} (current: ${truncateValue(currentValue, 50)}):`,
		choices: actions,
	});

	if (action !== 'back') {
		await runAction(context, selectedKey, action);
	}
}

async function handleComplexField(
	context: ActionContext,
	selectedKey: string,
	hasValue: boolean,
): Promise<void> {
	const { inquirer, mergedConfig } = context;
	const currentValue = mergedConfig[selectedKey];

	const actions = getSubKeyActions(hasValue);
	const action = await inquirer.select<string>({
		message: `Action for ${selectedKey} (current: ${truncateValue(currentValue, 50)}):`,
		choices: actions,
	});

	if (action === 'subkeys') {
		await handleSubKeys(context, selectedKey);
	} else if (action === 'unset') {
		await runAction(context, selectedKey, 'unset');
	}
}
