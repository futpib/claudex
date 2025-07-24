#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */

import process from 'node:process';
import { z } from 'zod';
import { parseJson } from '../utils.js';
import { readStdin, formatTranscriptInfo, logMessage } from './shared.js';

const userPromptSubmitInputSchema = z.object({
	session_id: z.string(),
	transcript_path: z.string(),
	cwd: z.string(),
	hook_event_name: z.literal('UserPromptSubmit'),
	prompt: z.string(),
});

async function main() {
	const input = await readStdin();
	const hookInput = userPromptSubmitInputSchema.parse(parseJson(input));
	const sessionId = hookInput.session_id || '';
	const transcriptPath = hookInput.transcript_path || '';
	const prompt = hookInput.prompt || '';

	const transcriptInfo = formatTranscriptInfo(sessionId, transcriptPath);
	const message = `Session: ${sessionId}${transcriptInfo}, Event: UserPromptSubmit, Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`;
	await logMessage(message);

	process.exit(0);
}

await main();
