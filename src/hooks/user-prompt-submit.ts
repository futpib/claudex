#!/usr/bin/env node

import process from 'node:process';
import { readStdin, formatTranscriptInfo, logMessage } from './shared.js';

type UserPromptSubmitInput = {
	session_id: string;
	transcript_path: string;
	cwd: string;
	hook_event_name: 'UserPromptSubmit';
	prompt: string;
};

async function main() {
	const input = await readStdin();
	const hookInput: UserPromptSubmitInput = JSON.parse(input);
	const sessionId = hookInput.session_id || '';
	const transcriptPath = hookInput.transcript_path || '';
	const prompt = hookInput.prompt || '';

	const transcriptInfo = formatTranscriptInfo(sessionId, transcriptPath);
	const message = `Session: ${sessionId}${transcriptInfo}, Event: UserPromptSubmit, Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`;
	await logMessage(message);

	process.exit(0);
}

main().catch((error: unknown) => {
	console.error('Error in user-prompt-submit hook:', error);
	process.exit(1);
});
