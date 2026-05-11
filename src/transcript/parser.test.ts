import path from 'node:path';
import {
	mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'ava';
import { buildToolUseMap, extractContent } from './parser.js';
import type { ExtractedContent, SearchTarget } from './types.js';

async function writeTranscript(lines: Array<Record<string, unknown>>): Promise<{ filePath: string; dispose: () => Promise<void> }> {
	const dir = await mkdtemp(path.join(tmpdir(), 'claudex-parser-test-'));
	const filePath = path.join(dir, 'transcript.jsonl');
	await writeFile(filePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
	return {
		filePath,
		async dispose() {
			await rm(dir, { recursive: true });
		},
	};
}

async function collectContent(filePath: string, targets: SearchTarget[], sessionId: string): Promise<ExtractedContent[]> {
	const toolUseMap = await buildToolUseMap(filePath);
	const out: ExtractedContent[] = [];
	for await (const content of extractContent(filePath, toolUseMap, {
		targets: new Set(targets),
		sessionId,
	})) {
		out.push(content);
	}

	return out;
}

function makeAskUserQuestionPair(toolUseId: string, sessionId: string, answers: Record<string, string>, contentText = 'wrapped tool result text'): Array<Record<string, unknown>> {
	return [
		{
			type: 'assistant',
			sessionId,
			message: {
				role: 'assistant',
				content: [ {
					type: 'tool_use',
					id: toolUseId,
					name: 'AskUserQuestion',
					input: {},
				} ],
			},
		},
		{
			type: 'user',
			sessionId,
			message: {
				role: 'user',
				content: [ {
					type: 'tool_result',
					// eslint-disable-next-line @typescript-eslint/naming-convention
					tool_use_id: toolUseId,
					content: contentText,
				} ],
			},
			toolUseResult: { answers },
		},
	];
}

test('extracts AskUserQuestion answers as ask-user-answer target', async t => {
	const sessionId = 'test-session';
	const entries = makeAskUserQuestionPair(
		'toolu_test_aq_1',
		sessionId,
		{ 'Pick one': 'Enable the setting via API' },
	);

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'ask-user-answer' ], sessionId);
		t.is(items.length, 1);
		t.is(items[0].target, 'ask-user-answer');
		t.is(items[0].text, 'Enable the setting via API');
		t.is(items[0].toolName, 'AskUserQuestion');
	} finally {
		await fixture.dispose();
	}
});

test('does not yield ask-user-answer when target not requested', async t => {
	const sessionId = 'test-session';
	const entries = makeAskUserQuestionPair(
		'toolu_test_aq_2',
		sessionId,
		{ 'Pick one': 'some answer' },
	);

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'user', 'queue-operation' ], sessionId);
		t.deepEqual(items.filter(c => c.target === 'ask-user-answer'), []);
	} finally {
		await fixture.dispose();
	}
});

test('yields one ask-user-answer per answer for multi-question polls', async t => {
	const sessionId = 'test-session';
	const entries = makeAskUserQuestionPair(
		'toolu_test_aq_3',
		sessionId,
		{
			'first question': 'answer one',
			'second question': 'answer two',
		},
	);

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'ask-user-answer' ], sessionId);
		const texts = items.map(i => i.text).sort();
		t.deepEqual(texts, [ 'answer one', 'answer two' ]);
	} finally {
		await fixture.dispose();
	}
});

test('ask-user-answer does not collide with tool-result target', async t => {
	const sessionId = 'test-session';
	const entries = makeAskUserQuestionPair(
		'toolu_test_aq_4',
		sessionId,
		{ 'Pick one': 'clean answer' },
		'wrapper text from runtime',
	);

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'tool-result', 'ask-user-answer' ], sessionId);
		const askAnswers = items.filter(c => c.target === 'ask-user-answer');
		const toolResults = items.filter(c => c.target === 'tool-result');
		t.is(askAnswers.length, 1);
		t.is(askAnswers[0].text, 'clean answer');
		t.is(toolResults.length, 1);
		t.is(toolResults[0].text, 'wrapper text from runtime');
	} finally {
		await fixture.dispose();
	}
});
