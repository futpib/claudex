#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */

import process from 'node:process';
import { z } from 'zod';
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

const baseToolInputSchema = z.object({
	session_id: z.string(),
	transcript_path: z.string(),
});

const toolInputSchema = baseToolInputSchema.and(z.union([
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
	z.object({ tool_name: z.literal('TodoWrite'), tool_input: z.unknown() }),
	z.object({ tool_name: z.literal('Task'), tool_input: z.unknown() }),
]));

type ToolInput = z.infer<typeof toolInputSchema>;

// Skip logging for read-only tools and internal tools
const READ_ONLY_TOOLS = new Set([ 'Grep', 'LS', 'WebFetch', 'Glob', 'NotebookRead', 'WebSearch' ]);
const INTERNAL_TOOLS = new Set([ 'TodoWrite', 'Task' ]);

async function main() {
	const input = await readStdin();
	const toolInput = parseJsonWithSchema(input, toolInputSchema);
	const toolName = toolInput.tool_name ?? '';
	const command = toolInput.tool_name === 'Bash' ? toolInput.tool_input.command : '';
	const sessionId = toolInput.session_id ?? '';
	const transcriptPath = toolInput.transcript_path ?? '';

	if (READ_ONLY_TOOLS.has(toolName) || INTERNAL_TOOLS.has(toolName)) {
		process.exit(0);
	}

	try {
		const filteredInput = omitLongFields(toolInput);

		const toolInputString = JSON.stringify(filteredInput);
		const transcriptInfo = formatTranscriptInfo(sessionId, transcriptPath);
		const message = `Session: ${sessionId}${transcriptInfo}, Tool: ${toolName}, Input: ${toolInputString}`;
		await logMessage(message);
	} catch {}

	if (toolName === 'Bash' && typeof command === 'string' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('co-authored-by')) {
		const markerPattern = /x-claude-code-actually-co-authored:\s*\d{4}/i;
		if (markerPattern.test(command)) {
			process.exit(0);
		} else {
			const pin = Math.floor(1000 + (Math.random() * 9000));
			console.error('⚠️  This commit includes co-authorship. Claude Code should:');
			console.error('1. Review the staged changes with \'git diff --cached -ub\'');
			console.error('2. Check the session history to verify if you made these changes');
			console.error('3. If you did co-author, add the following to the end of your commit message:');
			console.error(`   x-claude-code-actually-co-authored: ${pin}`);
			console.error('4. If not, remove the Co-authored-by line and try again.');
			process.exit(2);
		}
	}

	process.exit(0);
}

function omitLongFields(input: ToolInput): unknown {
	if (input.tool_name === 'Edit') {
		return {
			...input.tool_input,
			old_string: '__OMITTED__',
			new_string: '__OMITTED__',
		};
	}

	if (input.tool_name === 'MultiEdit') {
		return {
			...input.tool_input,
			edits: '__OMITTED__',
		};
	}

	if (input.tool_name === 'Write') {
		return {
			...input.tool_input,
			content: '__OMITTED__',
		};
	}

	return input.tool_input;
}

await main();
