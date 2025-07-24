#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */

import process from 'node:process';
import { z } from 'zod';
import { parseJson } from '../utils.js';
import { readStdin, formatTranscriptInfo, logMessage } from './shared.js';

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

const baseToolInputSchema = z.object({
	session_id: z.string(),
	transcript_path: z.string(),
});

const toolInputSchema = baseToolInputSchema.and(z.discriminatedUnion('tool_name', [
	z.object({ tool_name: z.literal('Edit'), tool_input: editToolInputSchema }),
	z.object({ tool_name: z.literal('MultiEdit'), tool_input: multiEditToolInputSchema }),
	z.object({ tool_name: z.literal('Write'), tool_input: writeToolInputSchema }),
	z.object({ tool_name: z.literal('Bash'), tool_input: bashToolInputSchema }),
	z.object({ tool_name: z.string(), tool_input: z.record(z.unknown()) }),
]));

type ToolInput = z.infer<typeof toolInputSchema>;

async function main() {
	const input = await readStdin();
	const toolInput = toolInputSchema.parse(parseJson(input));
	const toolName = toolInput.tool_name ?? '';
	const command = (toolInput as any).tool_input?.command ?? '';
	const sessionId = toolInput.session_id ?? '';
	const transcriptPath = toolInput.transcript_path ?? '';

	if (toolName === 'TodoWrite' || toolName === 'Task') {
		process.exit(0);
	}

	try {
		const filteredInput = omitLongFields(toolInput);
		const logInput = filteredInput.tool_input;

		const toolInputString = JSON.stringify(logInput);
		const transcriptInfo = formatTranscriptInfo(sessionId, transcriptPath);
		const message = `Session: ${sessionId}${transcriptInfo}, Tool: ${toolName}, Input: ${toolInputString}`;
		await logMessage(message);
	} catch {}

	if (toolName === 'Bash' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('co-authored-by')) {
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

function omitLongFields(input: ToolInput): ToolInput {
	if (input.tool_name === 'Edit') {
		return {
			...input,
			tool_input: {
				...input.tool_input,
				old_string: '__OMITTED__',
				new_string: '__OMITTED__',
			},
		} as any;
	}

	if (input.tool_name === 'MultiEdit') {
		return {
			...input,
			tool_input: {
				...input.tool_input,
				edits: '__OMITTED__',
			},
		} as any;
	}

	if (input.tool_name === 'Write') {
		return {
			...input,
			tool_input: {
				...input.tool_input,
				content: '__OMITTED__',
			},
		} as any;
	}

	return input;
}

main().catch((error: unknown) => {
	console.error('Error in pre-tool-use hook:', error);
	process.exit(1);
});
