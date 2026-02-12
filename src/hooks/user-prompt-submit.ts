#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */

import process from 'node:process';
import { z } from 'zod';
import { getMergedConfig, resolveHooks } from '../config.js';
import {
	readStdin, formatTranscriptInfo, logMessage, parseJsonWithSchema,
} from './shared.js';

const userPromptSubmitInputSchema = z.object({
	session_id: z.string(),
	transcript_path: z.string(),
	cwd: z.string(),
	hook_event_name: z.literal('UserPromptSubmit'),
	prompt: z.string(),
});

async function main() {
	const input = await readStdin();
	const hookInput = parseJsonWithSchema(input, userPromptSubmitInputSchema);
	const sessionId = hookInput.session_id || '';
	const transcriptPath = hookInput.transcript_path || '';
	const prompt = hookInput.prompt || '';

	const transcriptInfo = formatTranscriptInfo(sessionId, transcriptPath);

	const filteredInput = {
		prompt: prompt.slice(0, 200) + (prompt.length > 200 ? '...' : ''),
		cwd: hookInput.cwd,
	};

	const { config } = await getMergedConfig(hookInput.cwd);
	const hooks = resolveHooks(config.hooks);
	if (hooks.logPrompts) {
		const inputString = JSON.stringify(filteredInput);
		const message = `Session: ${sessionId}${transcriptInfo}, Event: UserPromptSubmit, Input: ${inputString}`;
		await logMessage(message);
	}

	process.exit(0);
}

await main();
