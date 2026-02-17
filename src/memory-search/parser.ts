import fs from 'node:fs';
import readline from 'node:readline';
import type { ExtractedContent, SearchTarget } from './types.js';

type ToolUseMap = Map<string, string>;

function createReadlineInterface(filePath: string): readline.Interface {
	return readline.createInterface({
		input: fs.createReadStream(filePath, { encoding: 'utf8' }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
}

export async function buildToolUseMap(filePath: string): Promise<ToolUseMap> {
	const map: ToolUseMap = new Map();
	const rl = createReadlineInterface(filePath);

	for await (const line of rl) {
		if (!line) {
			continue;
		}

		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			collectToolUseIds(entry, map);
		} catch {}
	}

	return map;
}

function collectToolUseIdsFromContent(content: unknown, map: ToolUseMap): void {
	if (!Array.isArray(content)) {
		return;
	}

	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
			map.set(block.id, block.name);
		}
	}
}

function collectToolUseIds(entry: Record<string, unknown>, map: ToolUseMap): void {
	if (entry.type === 'assistant') {
		const message = entry.message as Record<string, unknown> | undefined;
		if (message) {
			collectToolUseIdsFromContent(message.content, map);
		}
	} else if (entry.type === 'progress') {
		const data = entry.data as Record<string, unknown> | undefined;
		if (data?.message) {
			const nestedMessage = data.message as Record<string, unknown>;
			if (nestedMessage.message) {
				const innerMessage = nestedMessage.message as Record<string, unknown>;
				collectToolUseIdsFromContent(innerMessage.content, map);
			}
		}
	}
}

export async function * extractContent(
	filePath: string,
	toolUseMap: ToolUseMap,
	targets: Set<SearchTarget>,
	sessionId: string,
): AsyncGenerator<ExtractedContent> {
	const rl = createReadlineInterface(filePath);

	for await (const line of rl) {
		if (!line) {
			continue;
		}

		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			yield * extractFromEntry(entry, toolUseMap, targets, sessionId);
		} catch {}
	}
}

type ExtractContext = {
	toolUseMap: ToolUseMap;
	targets: Set<SearchTarget>;
	sessionId: string;
	timestamp: string;
};

function * extractFromEntry(
	entry: Record<string, unknown>,
	toolUseMap: ToolUseMap,
	targets: Set<SearchTarget>,
	sessionId: string,
): Generator<ExtractedContent> {
	const timestamp = (typeof entry.timestamp === 'string' ? entry.timestamp : '');
	const entrySessionId = (typeof entry.sessionId === 'string' ? entry.sessionId : sessionId);
	const context: ExtractContext = {
		toolUseMap, targets, sessionId: entrySessionId, timestamp,
	};

	switch (entry.type) {
		case 'user': {
			yield * extractFromUserEntry(entry, context);

			break;
		}

		case 'assistant': {
			yield * extractFromAssistantEntry(entry, context);

			break;
		}

		case 'progress': {
			yield * extractFromProgressEntry(entry, context);

			break;
		}
	// No default
	}
}

function * extractFromUserEntry(
	entry: Record<string, unknown>,
	context: ExtractContext,
): Generator<ExtractedContent> {
	const { toolUseMap, targets, sessionId, timestamp } = context;
	const message = entry.message as Record<string, unknown> | undefined;
	if (!message) {
		return;
	}

	const { content } = message;

	if (targets.has('user')) {
		if (typeof content === 'string') {
			yield {
				target: 'user', text: content, sessionId, timestamp,
			};
		} else if (Array.isArray(content)) {
			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === 'text' && typeof block.text === 'string') {
					yield {
						target: 'user', text: block.text, sessionId, timestamp,
					};
				}
			}
		}
	}

	if (Array.isArray(content)) {
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
				const toolName = toolUseMap.get(block.tool_use_id);
				const isBash = toolName === 'Bash';
				const target: SearchTarget = isBash ? 'bash-output' : 'tool-result';

				if (!targets.has(target)) {
					continue;
				}

				const resultText = extractToolResultText(block);
				if (resultText) {
					yield {
						target, text: resultText, toolName: toolName ?? 'unknown', sessionId, timestamp,
					};
				}
			}
		}
	}
}

function extractToolResultText(block: Record<string, unknown>): string | undefined {
	if (typeof block.content === 'string') {
		return block.content;
	}

	if (Array.isArray(block.content)) {
		const parts: string[] = [];
		for (const item of block.content as Array<Record<string, unknown>>) {
			if (typeof item.text === 'string') {
				parts.push(item.text);
			}
		}

		return parts.length > 0 ? parts.join('\n') : undefined;
	}

	return undefined;
}

function formatToolInput(input: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [ key, value ] of Object.entries(input)) {
		if (typeof value === 'string') {
			lines.push(value.includes('\n') ? `${key}:\n${value}` : `${key}: ${value}`);
		} else if (typeof value === 'number' || typeof value === 'boolean') {
			lines.push(`${key}: ${String(value)}`);
		} else if (value !== null && value !== undefined) {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		}
	}

	return lines.join('\n');
}

function * extractFromAssistantEntry(
	entry: Record<string, unknown>,
	context: ExtractContext,
): Generator<ExtractedContent> {
	const { targets, sessionId, timestamp } = context;
	const message = entry.message as Record<string, unknown> | undefined;
	if (!message) {
		return;
	}

	const { content } = message;
	if (!Array.isArray(content)) {
		return;
	}

	for (const block of content as Array<Record<string, unknown>>) {
		if (block.type === 'text' && typeof block.text === 'string' && targets.has('assistant')) {
			yield {
				target: 'assistant', text: block.text, sessionId, timestamp,
			};
		}

		if (block.type === 'tool_use') {
			const name = block.name as string | undefined;
			const input = block.input as Record<string, unknown> | undefined;

			if (name === 'Bash' && targets.has('bash-command') && input && typeof input.command === 'string') {
				yield {
					target: 'bash-command', text: input.command, toolName: 'Bash', sessionId, timestamp,
				};
			}

			if (targets.has('tool-use') && name) {
				const inputText = input ? formatToolInput(input) : '';
				yield {
					target: 'tool-use', text: inputText, toolName: name, sessionId, timestamp,
				};
			}
		}
	}
}

function * extractFromProgressEntry(
	entry: Record<string, unknown>,
	context: ExtractContext,
): Generator<ExtractedContent> {
	const data = entry.data as Record<string, unknown> | undefined;
	if (!data?.message) {
		return;
	}

	const nestedMessage = data.message as Record<string, unknown>;
	if (!nestedMessage.message) {
		return;
	}

	const innerMessage = nestedMessage.message as Record<string, unknown>;
	const nestedType = nestedMessage.type as string | undefined;

	const syntheticEntry: Record<string, unknown> = {
		type: nestedType === 'assistant' ? 'assistant' : 'user',
		message: innerMessage,
		timestamp: context.timestamp,
		sessionId: context.sessionId,
	};

	yield * extractFromEntry(syntheticEntry, context.toolUseMap, context.targets, context.sessionId);
}
