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
	z.object({ tool_name: z.literal('TodoWrite'), tool_input: z.unknown() }),
	z.object({ tool_name: z.literal('Task'), tool_input: z.unknown() }),
]));

type ToolInput = z.infer<typeof toolInputSchema>;

async function main() {
	const input = await readStdin();
	const toolInput = parseJsonWithSchema(input, toolInputSchema);
	const toolName = toolInput.tool_name ?? '';
	const command = toolInput.tool_name === 'Bash' ? toolInput.tool_input.command : '';
	const sessionId = toolInput.session_id ?? '';
	const transcriptPath = toolInput.transcript_path ?? '';

	if (toolName === 'TodoWrite' || toolName === 'Task') {
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
			...input,
			tool_input: {
				...input.tool_input,
				old_string: '__OMITTED__',
				new_string: '__OMITTED__',
			},
		};
	}

	if (input.tool_name === 'MultiEdit') {
		return {
			...input,
			tool_input: {
				...input.tool_input,
				edits: '__OMITTED__',
			},
		};
	}

	if (input.tool_name === 'Write') {
		return {
			...input,
			tool_input: {
				...input.tool_input,
				content: '__OMITTED__',
			},
		};
	}

	return input;
}

await main();
