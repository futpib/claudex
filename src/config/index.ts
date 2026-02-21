export {
	baseConfigSchema, rootConfigSchema,
	builtinLauncherDefinitions,
	allMcpServerFlags,
	validTopLevelKeys, fixedSubKeyFields, recordFields,
	resolveHooks, resolveMcpServers,
	type VolumeMount, type Volume, type SshConfig,
	type HooksDetail, type HooksConfig,
	type McpServersDetail, type McpServersConfig,
	type BaseConfig, type ProjectConfig, type RootConfig,
	type LauncherDefinition, type ClaudexConfig,
} from './schema.js';

export {
	expandEnvVars, expandPathEnv, expandEnvValues, expandVolumePaths,
} from './expand.js';

export {
	mergeBaseConfigs, mergeRootConfigs,
	readConfig, getMergedConfig,
	type MergedConfigResult,
} from './merge.js';

export {
	readRootConfig,
	getConfigDir,
	readSingleConfigFile, writeSingleConfigFile,
	readAllConfigFiles,
	findConfigFileForProject, findConfigFileForGroup, findConfigFileForProfile,
	type ConfigFileEntry, type FindConfigFileResult,
} from './io.js';
