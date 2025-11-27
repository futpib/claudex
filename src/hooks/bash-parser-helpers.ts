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

		default: {
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
		case 'backtickSubstitution': {
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

	const bannedOperators = new Set([ '&&', '||', ';' ]);

	// Check if any entry has a banned separator
	for (const entry of ast.entries) {
		if (entry.separator && bannedOperators.has(entry.separator)) {
			return true;
		}
	}

	return false;
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
 * Checks if a git command uses the -C flag to run in a different directory.
 */
export async function hasGitCFlag(command: string): Promise<boolean> {
	const ast = await parseBashCommand(command);
	if (!ast) {
		return false;
	}

	return someSimpleCommand(ast, cmd => {
		const name = cmd.name ? getWordLiteralValue(cmd.name) : undefined;
		if (name !== 'git') {
			return false;
		}

		// Check args for -C flag
		for (const arg of cmd.args) {
			const value = getWordLiteralValue(arg);
			if (value === undefined) {
				continue;
			}

			// Check for standalone -C flag
			if (value === '-C') {
				return true;
			}

			// Check for combined short flags containing C (e.g., -vC)
			if (value.startsWith('-') && !value.startsWith('--') && value.includes('C')) {
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
}
