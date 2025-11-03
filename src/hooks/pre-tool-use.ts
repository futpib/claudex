#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */

import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import invariant from 'invariant';
import { z } from 'zod';
import { paths } from '../paths.js';
import {
	readStdin, formatTranscriptInfo, logMessage, parseJsonWithSchema, ParseJsonWithSchemaError,
} from './shared.js';

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
	mcpToolInputSchema,
]);

const preToolUseHookInputSchema = baseToolInputSchema.and(z.union([ knownToolInputSchema, unknownToolInputSchema ]));

type KnownToolInput = z.infer<typeof knownToolInputSchema>;

// Skip logging for read-only tools and internal tools
const READ_ONLY_TOOLS = new Set([ 'Grep', 'LS', 'WebFetch', 'Glob', 'NotebookRead', 'WebSearch', 'BashOutput' ]);
const INTERNAL_TOOLS = new Set([ 'TodoWrite', 'Task' ]);

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

	if (READ_ONLY_TOOLS.has(toolName) || INTERNAL_TOOLS.has(toolName) || isMcpTool) {
		process.exit(0);
	}

	invariant(preToolUseHookWithKnownToolInput, 'Expected preToolUseHookInput to match knownToolInputSchema');
	const filteredInput = omitLongFields(preToolUseHookWithKnownToolInput);

	const toolInputString = JSON.stringify(filteredInput);
	const transcriptInfo = formatTranscriptInfo(sessionId, transcriptPath);
	const message = `Session: ${sessionId}${transcriptInfo}, Tool: ${toolName}, Input: ${toolInputString}`;
	await logMessage(message);

	// Ban git commit --amend commands entirely
	if (toolName === 'Bash' && typeof command === 'string' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('--amend')) {
		console.error('❌ git commit --amend is not allowed');
		console.error('Amending commits can alter git history and is not permitted.');
		process.exit(2);
	}

	// Ban git commit --no-verify commands
	if (toolName === 'Bash' && typeof command === 'string' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('--no-verify')) {
		console.error('❌ git commit --no-verify is not allowed');
		console.error('Bypassing pre-commit hooks can introduce code quality issues and is not permitted.');
		process.exit(2);
	}

	// Ban using bash commands for file operations that have dedicated tools
	if (toolName === 'Bash' && typeof command === 'string') {
		const fileOperationCommands = ['cat', 'sed', 'head', 'tail', 'awk'];
		const hasFileOperationCommand = fileOperationCommands.some(cmd => {
			// Match command as standalone word (not part of another word), case-sensitive
			const regex = new RegExp(`\\b${cmd}\\b`);
			return regex.test(command);
		});

		if (hasFileOperationCommand) {
			console.error('❌ Using bash commands (cat, sed, head, tail, awk) for file operations is not allowed');
			console.error('Please use the dedicated tools instead:');
			console.error('  - Read tool: for reading files (supports offset/limit for specific line ranges)');
			console.error('  - Edit tool: for editing files (instead of sed/awk)');
			console.error('  - Write tool: for creating files (instead of cat/echo redirection)');
			console.error('  - Grep tool: for searching file contents (instead of grep)');
			process.exit(2);
		}
	}

	if (toolName === 'Bash' && typeof command === 'string' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('co-authored-by')) {
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
