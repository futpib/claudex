import fs from 'node:fs';
import readline from 'node:readline';
import type { ExtractedContent, SearchTarget } from './types.js';

function createReadlineInterface(filePath: string): readline.Interface {
	return readline.createInterface({
		input: fs.createReadStream(filePath, { encoding: 'utf8' }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
}

type ExtractOptions = {
	targets: Set<SearchTarget>;
	sessionId: string;
};

export async function * extractCodexContent(
	filePath: string,
	options: ExtractOptions,
): AsyncGenerator<ExtractedContent> {
	if (!options.targets.has('user')) {
		return;
	}

	const rl = createReadlineInterface(filePath);
	let resolvedSessionId = options.sessionId;

	for await (const line of rl) {
		if (!line) {
			continue;
		}

		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}

		const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : '';
		const payload = entry.payload as Record<string, unknown> | undefined;

		if (entry.type === 'session_meta' && payload && typeof payload.id === 'string') {
			resolvedSessionId = payload.id;
			continue;
		}

		if (!payload) {
			continue;
		}

		if (entry.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
			yield {
				target: 'user',
				text: payload.message,
				sessionId: resolvedSessionId,
				timestamp,
			};
			continue;
		}

		if (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
			const { content } = payload;
			if (!Array.isArray(content)) {
				continue;
			}

			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === 'input_text' && typeof block.text === 'string') {
					yield {
						target: 'user',
						text: block.text,
						sessionId: resolvedSessionId,
						timestamp,
					};
				}
			}
		}
	}
}
