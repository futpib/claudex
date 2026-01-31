#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */

import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import invariant from 'invariant';
import { z } from 'zod';
import { paths } from '../paths.js';
import { getMergedConfig, resolveHooks } from '../config.js';
import {
	readStdin, formatTranscriptInfo, logMessage, parseJsonWithSchema, ParseJsonWithSchemaError,
} from './shared.js';
import {
	extractCommandNames, hasChainOperators, hasGitCFlag, getGitCheckoutBStartPoint, getPipedFilterCommand,
} from './bash-parser-helpers.js';

const editToolInputSchema = z.object({
	file_path: z.string(),
	old_string: z.string(),
	new_string: z.string(),
	replace_all: z.boolean().optional(),
});

const multiEditToolInputSchema = z.object({
	file_path: z.string(),
	edits: z.array(z.object({
		old_string: z.string(),
		new_string: z.string(),
		replace_all: z.boolean().optional(),
	})),
});

const writeToolInputSchema = z.object({
	file_path: z.string(),
	content: z.string(),
});

const bashToolInputSchema = z.object({
	command: z.string(),
	description: z.string().optional(),
	timeout: z.number().optional(),
	run_in_background: z.boolean().optional(),
});

const readToolInputSchema = z.object({
	file_path: z.string(),
	offset: z.number().optional(),
	limit: z.number().optional(),
});

const grepToolInputSchema = z.object({
	pattern: z.string(),
	path: z.string().optional(),
	output_mode: z.string().optional(),
	glob: z.string().optional(),
	type: z.string().optional(),
	head_limit: z.number().optional(),
	multiline: z.boolean().optional(),
	'-A': z.number().optional(),
	'-B': z.number().optional(),
	'-C': z.number().optional(),
	'-i': z.boolean().optional(),
	'-n': z.boolean().optional(),
});

const exitPlanModeToolInputSchema = z.object({
	plan: z.string(),
});

const lsToolInputSchema = z.object({
	path: z.string(),
	ignore: z.array(z.string()).optional(),
});

const webFetchToolInputSchema = z.object({
	url: z.string(),
	prompt: z.string(),
});

const globToolInputSchema = z.object({
	pattern: z.string(),
	path: z.string().optional(),
});

const notebookReadToolInputSchema = z.object({
	notebook_path: z.string(),
	cell_id: z.string().optional(),
});

const notebookEditToolInputSchema = z.object({
	notebook_path: z.string(),
	new_source: z.string(),
	cell_id: z.string().optional(),
	cell_type: z.string().optional(),
	edit_mode: z.string().optional(),
});

const webSearchToolInputSchema = z.object({
	query: z.string(),
	allowed_domains: z.array(z.string()).optional(),
	blocked_domains: z.array(z.string()).optional(),
});

const bashOutputToolInputSchema = z.object({
	bash_id: z.string(),
	filter: z.string().optional(),
});

const killBashToolInputSchema = z.object({
	shell_id: z.string(),
});

const baseToolInputSchema = z.object({
	session_id: z.string(),
	transcript_path: z.string(),
});

const knownToolInputSchema = z.union([
	z.object({ tool_name: z.literal('Edit'), tool_input: editToolInputSchema }),
	z.object({ tool_name: z.literal('MultiEdit'), tool_input: multiEditToolInputSchema }),
	z.object({ tool_name: z.literal('Write'), tool_input: writeToolInputSchema }),
	z.object({ tool_name: z.literal('Bash'), tool_input: bashToolInputSchema }),
	z.object({ tool_name: z.literal('Read'), tool_input: readToolInputSchema }),
	z.object({ tool_name: z.literal('Grep'), tool_input: grepToolInputSchema }),
	z.object({ tool_name: z.literal('ExitPlanMode'), tool_input: exitPlanModeToolInputSchema }),
	z.object({ tool_name: z.literal('LS'), tool_input: lsToolInputSchema }),
	z.object({ tool_name: z.literal('WebFetch'), tool_input: webFetchToolInputSchema }),
	z.object({ tool_name: z.literal('Glob'), tool_input: globToolInputSchema }),
	z.object({ tool_name: z.literal('NotebookRead'), tool_input: notebookReadToolInputSchema }),
	z.object({ tool_name: z.literal('NotebookEdit'), tool_input: notebookEditToolInputSchema }),
	z.object({ tool_name: z.literal('WebSearch'), tool_input: webSearchToolInputSchema }),
	z.object({ tool_name: z.literal('BashOutput'), tool_input: bashOutputToolInputSchema }),
	z.object({ tool_name: z.literal('KillBash'), tool_input: killBashToolInputSchema }),
]);

const mcpToolInputSchema = z.object({
	tool_name: z.string().regex(/^mcp__.*__.*$/),
	tool_input: z.unknown(),
});

const unknownToolInputSchema = z.union([
	z.object({ tool_name: z.literal('TodoWrite'), tool_input: z.unknown() }),
	z.object({ tool_name: z.literal('Task'), tool_input: z.unknown() }),
	z.object({ tool_name: z.literal('AskUserQuestion'), tool_input: z.unknown() }),
	mcpToolInputSchema,
]);

const preToolUseHookInputSchema = baseToolInputSchema.and(z.union([ knownToolInputSchema, unknownToolInputSchema ]));

type KnownToolInput = z.infer<typeof knownToolInputSchema>;

// Skip logging for read-only tools and internal tools
const READ_ONLY_TOOLS = new Set([ 'Grep', 'LS', 'WebFetch', 'Glob', 'NotebookRead', 'WebSearch', 'BashOutput' ]);
const INTERNAL_TOOLS = new Set([ 'TodoWrite', 'Task', 'AskUserQuestion' ]);

async function main() {
	const input = await readStdin();

	const preToolUseHookInput = parseJsonWithSchema(input, preToolUseHookInputSchema);

	const preToolUseHookWithKnownToolInput = knownToolInputSchema.safeParse(preToolUseHookInput).data;

	const toolName = preToolUseHookInput.tool_name ?? '';
	const command = preToolUseHookWithKnownToolInput?.tool_name === 'Bash' ? preToolUseHookWithKnownToolInput.tool_input.command : '';
	const sessionId = preToolUseHookInput.session_id ?? '';
	const transcriptPath = preToolUseHookInput.transcript_path ?? '';

	// Check if this is an MCP tool
	const isMcpTool = toolName.startsWith('mcp__');

	// Load config and resolve hooks
	const { config } = await getMergedConfig(process.cwd());
	const hooks = resolveHooks(config.hooks);

	// Ban web searches containing "2024" to encourage using current year
	if (hooks.banOutdatedYearInSearch && preToolUseHookWithKnownToolInput?.tool_name === 'WebSearch') {
		const { query } = preToolUseHookWithKnownToolInput.tool_input;
		if (/\b2024\b/.test(query)) {
			const currentYear = new Date().getFullYear();
			console.error('❌ Web searches containing "2024" are not allowed');
			console.error(`The current year is ${currentYear}. Please update your search query to use the current year.`);
			process.exit(2);
		}
	}

	if (!hooks.logToolUse || READ_ONLY_TOOLS.has(toolName) || INTERNAL_TOOLS.has(toolName) || isMcpTool) {
		// Skip logging
	} else {
		invariant(preToolUseHookWithKnownToolInput, 'Expected preToolUseHookInput to match knownToolInputSchema');
		const filteredInput = omitLongFields(preToolUseHookWithKnownToolInput);

		const toolInputString = JSON.stringify(filteredInput);
		const transcriptInfo = formatTranscriptInfo(sessionId, transcriptPath);
		const message = `Session: ${sessionId}${transcriptInfo}, Tool: ${toolName}, Input: ${toolInputString}`;
		await logMessage(message);
	}

	if (READ_ONLY_TOOLS.has(toolName) || INTERNAL_TOOLS.has(toolName) || isMcpTool) {
		process.exit(0);
	}

	// Ban git -C commands (running git in a different directory)
	if (hooks.banGitC && toolName === 'Bash' && typeof command === 'string' && await hasGitCFlag(command)) {
		console.error('❌ git -C is not allowed');
		console.error('Running git commands in a different directory is not permitted.');
		console.error('Please cd to the target directory and run git commands there instead.');
		process.exit(2);
	}

	// Check for git checkout -b with start-point when already on detached HEAD at that point
	if (hooks.banGitCheckoutRedundantStartPoint && toolName === 'Bash' && typeof command === 'string') {
		const startPoint = await getGitCheckoutBStartPoint(command);
		if (startPoint) {
			try {
				// Check if HEAD is detached (symbolic-ref fails when detached)
				await execa('git', [ 'symbolic-ref', '-q', 'HEAD' ]);
			} catch {
				// HEAD is detached, check if start-point matches current HEAD
				try {
					const [ headResult, startPointResult ] = await Promise.all([
						execa('git', [ 'rev-parse', 'HEAD' ]),
						execa('git', [ 'rev-parse', startPoint ]),
					]);
					if (headResult.stdout.trim() === startPointResult.stdout.trim()) {
						console.error('❌ Unnecessary start-point in git checkout -b');
						console.error(`You are already on a detached HEAD at ${startPoint}.`);
						console.error('Just use: git checkout -b <branch-name>');
						console.error(`Instead of: git checkout -b <branch-name> ${startPoint}`);
						process.exit(2);
					}
				} catch {
					// If rev-parse fails, skip this check
				}
			}
		}
	}

	// Ban git add -A commands
	if (hooks.banGitAddAll && toolName === 'Bash' && typeof command === 'string') {
		const actualCommands = await extractCommandNames(command);
		if (actualCommands.has('git')) {
			// Check if this is a git add command with banned flags
			// Parse tokens to find git add and its arguments
			const gitAddPattern = /\bgit\s+add\s+/;
			if (gitAddPattern.test(command)) {
				// Check for -A in short flags, --all, or --no-ignore-removal
				const bannedFlagPattern = /\bgit\s+add\s+(?:[^|;&]*?\s)?(?:-[a-zA-Z]*A(?:\s|$)|--all\b|--no-ignore-removal\b)/;
				if (bannedFlagPattern.test(command)) {
					console.error('❌ git add -A/--all/--no-ignore-removal is not allowed');
					console.error('These flags stage all changes including deletions across the entire repository.');
					console.error('Please use "git add ." to stage changes in the current directory instead.');
					process.exit(2);
				}
			}
		}
	}

	// Ban git commit --amend commands entirely
	if (hooks.banGitCommitAmend && toolName === 'Bash' && typeof command === 'string' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('--amend')) {
		console.error('❌ git commit --amend is not allowed');
		console.error('Amending commits can alter git history and is not permitted.');
		process.exit(2);
	}

	// Ban git commit --no-verify commands
	if (hooks.banGitCommitNoVerify && toolName === 'Bash' && typeof command === 'string' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('--no-verify')) {
		console.error('❌ git commit --no-verify is not allowed');
		console.error('Bypassing pre-commit hooks can introduce code quality issues and is not permitted.');
		process.exit(2);
	}

	// Ban running bash commands in background
	if (hooks.banBackgroundBash && preToolUseHookWithKnownToolInput?.tool_name === 'Bash' && preToolUseHookWithKnownToolInput.tool_input.run_in_background === true) {
		console.error('❌ Running bash commands in background is not allowed');
		console.error('Background bash processes cannot be monitored properly and may cause issues.');
		process.exit(2);
	}

	// Ban bash commands using &&, ||, or ; operators
	if (hooks.banCommandChaining && toolName === 'Bash' && typeof command === 'string' && await hasChainOperators(command)) {
		console.error('❌ Chaining bash commands with &&, ||, or ; is not allowed');
		console.error('Please run commands separately for better tracking and error handling.');
		process.exit(2);
	}

	// Ban piping command output to filter commands (grep, head, tail, etc.)
	if (hooks.banPipeToFilter && toolName === 'Bash' && typeof command === 'string') {
		const pipedFilter = await getPipedFilterCommand(command);
		if (pipedFilter) {
			console.error(`❌ Piping output to ${pipedFilter} is not allowed`);
			console.error('Run the command first, then search its output file using the Read or Grep tools.');
			console.error('For long output, the command result will include an output file path you can search.');
			process.exit(2);
		}
	}

	// Ban using bash commands for file operations that have dedicated tools
	if (hooks.banFileOperationCommands && toolName === 'Bash' && typeof command === 'string') {
		const fileOperationCommands = new Set([ 'cat', 'sed', 'head', 'tail', 'awk' ]);

		// Extract actual command invocations (not commands in strings or comments)
		const actualCommands = await extractCommandNames(command);

		// Check if any of the actual commands are file operation commands
		const bannedCommands = [ ...actualCommands ].filter(cmd => fileOperationCommands.has(cmd));

		if (bannedCommands.length > 0) {
			// Allow cat with heredoc syntax (e.g., cat <<'EOF' or cat <<EOF)
			// This is commonly used for formatting multi-line strings (e.g., in git commits)
			const catHeredocPattern = /\bcat\s+<<-?['"]?\w+['"]?/;
			if (bannedCommands.includes('cat') && catHeredocPattern.test(command)) {
				// This is a legitimate use of cat with heredoc, allow it
			} else {
				console.error('❌ Using bash commands (cat, sed, head, tail, awk) for file operations is not allowed');
				console.error(`Found: ${bannedCommands.join(', ')}`);
				console.error('Please use the dedicated tools instead:');
				console.error('  - Read tool: for reading files (supports offset/limit for specific line ranges)');
				console.error('  - Edit tool: for editing files (instead of sed/awk)');
				console.error('  - Write tool: for creating files (instead of cat/echo redirection)');
				console.error('  - Grep tool: for searching file contents (instead of grep)');
				process.exit(2);
			}
		}
	}

	if (hooks.requireCoAuthorshipProof && toolName === 'Bash' && typeof command === 'string' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('co-authored-by')) {
		const markerPattern = /x-claude-code-co-authorship-proof:\s*([a-f\d]{64})/i;
		const match = markerPattern.exec(command);
		if (match) {
			const submittedPin = match[1];
			const proofsDir = path.join(paths.data, 'co-authorship-proofs');
			const proofFile = path.join(proofsDir, `${submittedPin}.json`);

			try {
				await fs.access(proofFile);
				process.exit(0);
			} catch {
				console.error(`❌ Invalid co-authorship proof PIN: ${submittedPin}`);
				console.error('The provided PIN does not correspond to a valid proof submission.');
				process.exit(2);
			}
		} else {
			console.error('⚠️  This commit includes co-authorship. Claude Code must:');
			console.error('1. FIRST run \'git diff --cached\' to see what changes are being committed');
			console.error('2. ACTUALLY check the session transcript - did Claude Code make these specific changes?');
			console.error('3. If Claude Code genuinely co-authored, submit proof with:');
			console.error('   claudex-submit-co-authorship-proof "Claude Code made changes X, Y, Z in this session"');
			console.error('4. Add the returned PIN right after the Co-authored-by line:');
			console.error('   Co-authored-by: Claude <claude@anthropic.com>');
			console.error('   x-claude-code-co-authorship-proof: <PIN-FROM-SUBMIT-PROOF>');
			console.error('5. If Claude Code did NOT make these changes, remove Co-authored-by and try again.');
			process.exit(2);
		}
	}

	process.exit(0);
}

function omitLongFields(input: KnownToolInput): unknown {
	if (input.tool_name === 'Edit') {
		const { old_string: _oldString, new_string: _newString, ...rest } = input.tool_input;
		return rest;
	}

	if (input.tool_name === 'MultiEdit') {
		const { edits, ...rest } = input.tool_input;
		return rest;
	}

	if (input.tool_name === 'Write') {
		const { content, ...rest } = input.tool_input;
		return rest;
	}

	return input.tool_input;
}

await main();
