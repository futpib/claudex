import process from 'node:process';
import { execa } from 'execa';

export async function readStdin(): Promise<string> {
	let input = '';
	process.stdin.setEncoding('utf8');

	for await (const chunk of process.stdin) {
		input += chunk;
	}

	return input;
}

export function formatTranscriptInfo(sessionId: string, transcriptPath: string): string {
	return transcriptPath.includes(sessionId) ? '' : `, Transcript: ${transcriptPath}`;
}

export async function logMessage(message: string): Promise<void> {
	try {
		await execa('systemd-cat', [ '-t', 'claude-code', '-p', 'info' ], {
			input: message,
		});
	} catch {
		console.error(`[claude-code] ${message}`);
	}
}
