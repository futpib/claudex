import { runParser, stringParserInputCompanion } from '@futpib/parser';
import { bashScriptParser } from '@futpib/parser/build/bashParser.js';
import type {
	BashCommand,
	BashCommandUnit,
	BashSimpleCommand,
	BashWord,
	BashWordPart,
} from '@futpib/parser/build/bash.js';

/**
 * Parse a bash command string into an AST.
 * Returns undefined if parsing fails.
 */
export async function parseBashCommand(command: string): Promise<BashCommand | undefined> {
	try {
		return await runParser(bashScriptParser, command, stringParserInputCompanion);
	} catch {
		return undefined;
	}
}

/**
 * Get the string value of a BashWord (expanding all literal parts).
 * Returns undefined if the word contains non-literal parts (variables, substitutions).
 */
function getWordLiteralValue(word: BashWord): string | undefined {
	let result = '';
	for (const part of word.parts) {
		const value = getWordPartLiteralValue(part);
		if (value === undefined) {
			return undefined;
		}

		result += value;
	}

	return result;
}

function getWordPartLiteralValue(part: BashWordPart): string | undefined {
	switch (part.type) {
		case 'literal': {
			return part.value;
		}

		case 'singleQuoted': {
			return part.value;
		}

		case 'doubleQuoted': {
			let result = '';
			for (const innerPart of part.parts) {
				const value = getWordPartLiteralValue(innerPart);
				if (value === undefined) {
					return undefined;
				}

				result += value;
			}

			return result;
		}

		case 'variable':
		case 'variableBraced':
		case 'commandSubstitution':
		case 'backtickSubstitution':
		case 'arithmeticExpansion':
		case 'processSubstitution': {
			// These types cannot be resolved to literal values
			return undefined;
		}
	}
}

/**
 * Extracts command names from a parsed bash command.
 * Recursively processes pipelines, lists, and command substitutions.
 */
function extractCommandNamesFromAst(command: BashCommand): Set<string> {
	const commands = new Set<string>();

	for (const entry of command.entries) {
		for (const unit of entry.pipeline.commands) {
			extractCommandNamesFromUnit(unit, commands);
		}
	}

	return commands;
}

function extractCommandNamesFromUnit(unit: BashCommandUnit, commands: Set<string>): void {
	switch (unit.type) {
		case 'simple': {
			if (unit.name) {
				const name = getWordLiteralValue(unit.name);
				if (name) {
					commands.add(name);
				}
			}

			// Check for command substitutions in arguments
			for (const arg of unit.args) {
				extractCommandNamesFromWord(arg, commands);
			}

			break;
		}

		case 'subshell':
		case 'braceGroup': {
			const subCommands = extractCommandNamesFromAst(unit.body);
			for (const cmd of subCommands) {
				commands.add(cmd);
			}

			break;
		}
	}
}

function extractCommandNamesFromWord(word: BashWord, commands: Set<string>): void {
	for (const part of word.parts) {
		extractCommandNamesFromWordPart(part, commands);
	}
}

function extractCommandNamesFromWordPart(part: BashWordPart, commands: Set<string>): void {
	switch (part.type) {
		case 'commandSubstitution':
		case 'backtickSubstitution':
		case 'processSubstitution': {
			const subCommands = extractCommandNamesFromAst(part.command);
			for (const cmd of subCommands) {
				commands.add(cmd);
			}

			break;
		}

		case 'doubleQuoted': {
			for (const innerPart of part.parts) {
				extractCommandNamesFromWordPart(innerPart, commands);
			}

			break;
		}

		case 'literal':
		case 'singleQuoted':
		case 'variable':
		case 'variableBraced':
		case 'arithmeticExpansion': {
			// These types don't contain commands
			break;
		}
	}
}

/**
 * Extracts actual command names from a bash command string.
 * This properly distinguishes between:
 * - Actual commands: cat file.txt
 * - Commands in strings: echo "cat file.txt" (cat is inside the string, not a command)
 * - Commands in substitutions: git commit -m "$(cat <<'EOF'...)" (recursively parses)
 */
export async function extractCommandNames(command: string): Promise<Set<string>> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return new Set();
	}

	return extractCommandNamesFromAst(ast);
}

/**
 * Checks if a bash command contains chain operators (&&, ||, ;).
 * Returns true if the command contains any of the banned operators.
 */
export async function hasChainOperators(command: string): Promise<boolean> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return false;
	}

	const bannedOperators = new Set([ '&&', '||', ';', '\n' ]);

	// Check if any entry has a banned separator
	for (const entry of ast.entries) {
		if (entry.separator && bannedOperators.has(entry.separator)) {
			return true;
		}
	}

	return false;
}

/**
 * If the command starts with `cd <path>` followed by a chain operator,
 * returns the cd target path. Returns undefined otherwise.
 */
export async function getLeadingCdTarget(command: string): Promise<string | undefined> {
	const ast = await parseBashCommand(command);
	if (!ast || ast.entries.length < 2) {
		return undefined;
	}

	const firstEntry = ast.entries[0];
	const bannedOperators = new Set([ '&&', '||', ';', '\n' ]);
	if (!firstEntry.separator || !bannedOperators.has(firstEntry.separator)) {
		return undefined;
	}

	const pipelineCommands = firstEntry.pipeline.commands;
	if (pipelineCommands.length !== 1) {
		return undefined;
	}

	const unit = pipelineCommands[0];
	if (unit.type !== 'simple') {
		return undefined;
	}

	const name = unit.name ? getWordLiteralValue(unit.name) : undefined;
	if (name !== 'cd' || unit.args.length !== 1) {
		return undefined;
	}

	return getWordLiteralValue(unit.args[0]);
}

/**
 * Recursively check if any simple command in the AST matches a predicate.
 */
function someSimpleCommand(
	command: BashCommand,
	predicate: (cmd: BashSimpleCommand) => boolean,
): boolean {
	for (const entry of command.entries) {
		for (const unit of entry.pipeline.commands) {
			if (someSimpleCommandInUnit(unit, predicate)) {
				return true;
			}
		}
	}

	return false;
}

function someSimpleCommandInUnit(
	unit: BashCommandUnit,
	predicate: (cmd: BashSimpleCommand) => boolean,
): boolean {
	switch (unit.type) {
		case 'simple': {
			return predicate(unit);
		}

		case 'subshell':
		case 'braceGroup': {
			return someSimpleCommand(unit.body, predicate);
		}
	}
}

/**
 * Gets the start-point from a `git checkout -b <branch> <start-point>` command.
 * Returns undefined if not a git checkout -b command or if no start-point is specified.
 */

export async function getGitCheckoutBranchStartPoint(command: string): Promise<string | undefined> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return undefined;
	}

	let result: string | undefined;

	someSimpleCommand(ast, cmd => {
		const name = cmd.name ? getWordLiteralValue(cmd.name) : undefined;
		if (name !== 'git') {
			return false;
		}

		const args = cmd.args.map(arg => getWordLiteralValue(arg)).filter((arg): arg is string => arg !== undefined);

		// Find 'checkout' subcommand
		const checkoutIndex = args.indexOf('checkout');
		if (checkoutIndex === -1) {
			return false;
		}

		// Look for -b flag after checkout
		const argsAfterCheckout = args.slice(checkoutIndex + 1);
		const bFlagIndex = argsAfterCheckout.findIndex(arg => arg === '-b' || arg === '-B');
		if (bFlagIndex === -1) {
			return false;
		}

		// After -b <branch>, there might be a start-point
		// Pattern: git checkout -b <branch> [<start-point>]
		// We need to skip the branch name and get the next positional argument
		const argsAfterBranchFlag = argsAfterCheckout.slice(bFlagIndex + 1);

		// Skip the branch name (first positional arg after -b)
		// Then look for the start-point (second positional arg, if any)
		let positionalCount = 0;
		for (const arg of argsAfterBranchFlag) {
			if (arg.startsWith('-')) {
				continue; // Skip flags
			}

			positionalCount++;
			if (positionalCount === 2) {
				result = arg;
				return true;
			}
		}

		return false;
	});

	return result;
}

/**
 * Checks if a git command uses the -C flag to run in a different directory.
 */
/**
 * Checks if a command pipes output to a filter command (grep, head, tail, awk, sed, etc.).
 * Returns the name of the filter command if found, undefined otherwise.
 */
export const filterCommands = new Set([ 'grep', 'head', 'tail', 'awk', 'sed', 'cut', 'sort', 'uniq', 'wc', 'tr' ]);

export async function getPipedFilterCommand(command: string): Promise<string | undefined> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return undefined;
	}

	for (const entry of ast.entries) {
		const pipelineCommands = entry.pipeline.commands;
		// If there's more than one command in the pipeline, check if any after the first is a filter
		if (pipelineCommands.length > 1) {
			for (let i = 1; i < pipelineCommands.length; i++) {
				const unit = pipelineCommands[i];
				if (unit.type === 'simple' && unit.name) {
					const name = getWordLiteralValue(unit.name);
					if (name && filterCommands.has(name)) {
						return name;
					}
				}
			}
		}
	}

	return undefined;
}

/**
 * Gets the command name used with find -exec or -execdir.
 * Returns the command name if found, undefined otherwise.
 */
export async function getFindExecCommand(command: string): Promise<string | undefined> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return undefined;
	}

	let result: string | undefined;

	someSimpleCommand(ast, cmd => {
		const name = cmd.name ? getWordLiteralValue(cmd.name) : undefined;
		if (name !== 'find') {
			return false;
		}

		for (let i = 0; i < cmd.args.length; i++) {
			const value = getWordLiteralValue(cmd.args[i]);
			if ((value === '-exec' || value === '-execdir') && i + 1 < cmd.args.length) {
				const execCmd = getWordLiteralValue(cmd.args[i + 1]);
				if (execCmd) {
					result = execCmd;
					return true;
				}
			}
		}

		return false;
	});

	return result;
}

/**
 * Gets the path from a `git -C <path>` command.
 * Returns the path if found, undefined otherwise.
 */
export async function getGitChangeDirectoryPath(command: string): Promise<string | undefined> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return undefined;
	}

	let result: string | undefined;

	someSimpleCommand(ast, cmd => {
		const name = cmd.name ? getWordLiteralValue(cmd.name) : undefined;
		if (name !== 'git') {
			return false;
		}

		// Check args for -C flag
		for (let i = 0; i < cmd.args.length; i++) {
			const value = getWordLiteralValue(cmd.args[i]);
			if (value === undefined) {
				continue;
			}

			// Check for standalone -C flag followed by path
			if (value === '-C' && i + 1 < cmd.args.length) {
				const pathValue = getWordLiteralValue(cmd.args[i + 1]);
				if (pathValue) {
					result = pathValue;
					return true;
				}

				result = '';
				return true;
			}

			// Check for combined short flags containing C (e.g., -vC)
			if (value.startsWith('-') && !value.startsWith('--') && value.includes('C')) {
				result = '';
				return true;
			}

			// If we hit a non-flag argument (git subcommand), stop checking
			// -C must come before the subcommand
			if (!value.startsWith('-')) {
				break;
			}
		}

		return false;
	});

	return result;
}

export async function hasGitChangeDirectoryFlag(command: string): Promise<boolean> {
	return (await getGitChangeDirectoryPath(command)) !== undefined;
}

/**
 * Checks if a cargo command uses the --manifest-path flag.
 */
/**
 * Finds the first argument in a bash command that is an absolute path under the given cwd.
 * Uses the AST to only check actual command arguments, not string contents.
 * Returns the absolute path if found, undefined otherwise.
 */
export async function findAbsolutePathUnderCwd(command: string, cwd: string): Promise<string | undefined> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return undefined;
	}

	const cwdWithSlash = cwd.endsWith('/') ? cwd : cwd + '/';
	let found: string | undefined;

	someSimpleCommand(ast, cmd => {
		// Check command name
		if (cmd.name) {
			const name = getWordLiteralValue(cmd.name);
			if (name && (name === cwd || name.startsWith(cwdWithSlash))) {
				found = name;
				return true;
			}
		}

		// Check arguments
		for (const arg of cmd.args) {
			const value = getWordLiteralValue(arg);
			if (value && (value === cwd || value.startsWith(cwdWithSlash))) {
				found = value;
				return true;
			}
		}

		return false;
	});

	return found;
}

/**
 * Finds the first argument in a bash command that is an absolute path under the given home directory.
 * Uses the AST to only check actual command arguments, not string contents.
 * Returns the absolute path if found, undefined otherwise.
 */
export async function findAbsolutePathUnderHome(command: string, homeDir: string): Promise<string | undefined> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return undefined;
	}

	const homeDirWithSlash = homeDir.endsWith('/') ? homeDir : homeDir + '/';
	let found: string | undefined;

	someSimpleCommand(ast, cmd => {
		// Check command name
		if (cmd.name) {
			const name = getWordLiteralValue(cmd.name);
			if (name && (name === homeDir || name.startsWith(homeDirWithSlash))) {
				found = name;
				return true;
			}
		}

		// Check arguments
		for (const arg of cmd.args) {
			const value = getWordLiteralValue(arg);
			if (value && (value === homeDir || value.startsWith(homeDirWithSlash))) {
				found = value;
				return true;
			}
		}

		return false;
	});

	return found;
}

/**
 * Checks if a command wraps execution in `bash -c` or `sh -c`.
 * Returns true if found.
 */
export async function hasBashCommandFlag(command: string): Promise<boolean> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return false;
	}

	return someSimpleCommand(ast, cmd => {
		const name = cmd.name ? getWordLiteralValue(cmd.name) : undefined;
		if (name !== 'bash' && name !== 'sh') {
			return false;
		}

		for (const arg of cmd.args) {
			const value = getWordLiteralValue(arg);
			if (value === '-c') {
				return true;
			}
		}

		return false;
	});
}

export async function hasCargoManifestPathFlag(command: string): Promise<boolean> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return false;
	}

	return someSimpleCommand(ast, cmd => {
		const name = cmd.name ? getWordLiteralValue(cmd.name) : undefined;
		if (name !== 'cargo') {
			return false;
		}

		// Check args for --manifest-path flag
		for (const arg of cmd.args) {
			const value = getWordLiteralValue(arg);
			if (value === undefined) {
				continue;
			}

			// Check for standalone --manifest-path flag
			if (value === '--manifest-path') {
				return true;
			}

			// Check for --manifest-path=<path> format
			if (value.startsWith('--manifest-path=')) {
				return true;
			}
		}

		return false;
	});
}
