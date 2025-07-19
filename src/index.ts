import process from 'node:process';

import { execa } from 'execa';
import { checkForClaudeCodeUpdate } from './update.js';
import { createClaudeCodeMemory } from './memory.js';

export async function main() {
	const args = process.argv.slice(2);
	const claudeChildProcess = execa('claude', args, {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	});

	try {
		await createClaudeCodeMemory();
	} catch (error) {
		if (!(
			error instanceof Error
			&& error.message.includes('ENOENT')
		)) {
			throw error;
		}
	}

	try {
		await claudeChildProcess;
	} finally {
		await checkForClaudeCodeUpdate();
	}
}
