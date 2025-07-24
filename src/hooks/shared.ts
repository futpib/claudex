import process from 'node:process';
import { execa } from 'execa';
import { type z } from 'zod';
import { parseJson } from '../utils.js';

export class ParseJsonWithSchemaError extends Error {
	constructor(
		message: string,
		public readonly originalError: unknown,
		public readonly input: string,
	) {
		super(message);
		this.name = 'ParseJsonWithSchemaError';
	}
}

export function parseJsonWithSchema<T>(input: string, schema: z.ZodType<T>): T {
	let parsed: unknown;
	try {
		parsed = parseJson(input);
	} catch (error) {
		throw new ParseJsonWithSchemaError(
			'Failed to parse JSON',
			error,
			input,
		);
	}

	try {
		return schema.parse(parsed);
	} catch (error) {
		throw new ParseJsonWithSchemaError(
			'Failed to validate against schema',
			error,
			input,
		);
	}
}

export async function readStdin(): Promise<string> {
	let input = '';
	process.stdin.setEncoding('utf8');

	for await (const chunk of process.stdin) {
		input += String(chunk);
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
