import type { KnownToolInput, PreToolUseHookInput } from '../schemas.js';
import type * as bashParserHelpers from '../bash-parser-helpers.js';
import { banGitC } from './ban-git-c.js';
import { banCargoManifestPath } from './ban-cargo-manifest-path.js';
import { banYarnCwd } from './ban-yarn-cwd.js';
import { banGitAddAll } from './ban-git-add-all.js';
import { banGitCommitAmend } from './ban-git-commit-amend.js';
import { banGitCommitNoVerify } from './ban-git-commit-no-verify.js';
import { banGitCheckoutRedundantStartPoint } from './ban-git-checkout-redundant-start-point.js';
import { banBackgroundBash } from './ban-background-bash.js';
import { banBashMinusC } from './ban-bash-minus-c.js';
import { banCommandChaining } from './ban-command-chaining.js';
import { banPipeToFilter } from './ban-pipe-to-filter.js';
import { banFileOperationCommands } from './ban-file-operation-commands.js';
import { banFindCommand } from './ban-find-command.js';
import { banFindExec } from './ban-find-exec.js';
import { banGrepCommand } from './ban-grep-command.js';
import { banOutdatedYearInSearch } from './ban-outdated-year-in-search.js';
import { banWrongPackageManager } from './ban-wrong-package-manager.js';
import { banAbsolutePaths } from './ban-absolute-paths.js';
import { banHomeDirAbsolutePaths } from './ban-home-dir-absolute-paths.js';
import { requireCoAuthorshipProof } from './require-co-authorship-proof.js';
import { logToolUse } from './log-tool-use.js';

export type RuleViolation = {
	type: 'violation';
	messages: string[];
};

export type RuleResult = RuleViolation | { type: 'pass' } | { type: 'side-effect' };

export type RuleContext = {
	input: PreToolUseHookInput;
	knownInput: KnownToolInput | undefined;
	toolName: string;
	sessionId: string;
	transcriptPath: string;
	command: string;
	cwd: string;
	helpers: typeof bashParserHelpers;
	hooks: Record<string, boolean | undefined>;
};

export type RuleMeta = {
	name: string;
	configKey: string;
	recommended: boolean;
	phase: 'pre-exit' | 'main';
	description: string;
};

export type Rule = {
	meta: RuleMeta;
	fn: (context: RuleContext) => Promise<RuleResult> | RuleResult;
};

export const allRules: Rule[] = [
	banGitC,
	banCargoManifestPath,
	banYarnCwd,
	banGitAddAll,
	banGitCommitAmend,
	banGitCommitNoVerify,
	banGitCheckoutRedundantStartPoint,
	banBackgroundBash,
	banBashMinusC,
	banCommandChaining,
	banPipeToFilter,
	banFileOperationCommands,
	banFindCommand,
	banFindExec,
	banGrepCommand,
	banOutdatedYearInSearch,
	banAbsolutePaths,
	banHomeDirAbsolutePaths,
	banWrongPackageManager,
	requireCoAuthorshipProof,
	logToolUse,
];

export const rulesByConfigKey = new Map<string, Rule>(allRules.map(r => [ r.meta.configKey, r ]));

export const extraConfigEntries: Array<{ configKey: string; recommended: boolean }> = [
	{ configKey: 'logPrompts', recommended: true },
	{ configKey: 'logReadOnlyToolUse', recommended: true },
];

export const allConfigKeys: string[] = [
	...allRules.map(r => r.meta.configKey),
	...extraConfigEntries.map(entry => entry.configKey),
];
