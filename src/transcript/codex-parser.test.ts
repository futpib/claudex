/* eslint-disable @typescript-eslint/naming-convention */

import path from 'node:path';
import {
	mkdtemp, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'ava';
import { extractCodexContent } from './codex-parser.js';
import type { ExtractedContent, SearchTarget } from './types.js';

async function writeTranscript(lines: Array<Record<string, unknown>>): Promise<{ filePath: string; dispose: () => Promise<void> }> {
	const dir = await mkdtemp(path.join(tmpdir(), 'claudex-codex-parser-test-'));
	const filePath = path.join(dir, 'rollout.jsonl');
	await writeFile(filePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
	return {
		filePath,
		async dispose() {
			await rm(dir, { recursive: true });
		},
	};
}

async function collectContent(filePath: string, targets: SearchTarget[], sessionId: string): Promise<ExtractedContent[]> {
	const out: ExtractedContent[] = [];
	for await (const content of extractCodexContent(filePath, {
		targets: new Set(targets),
		sessionId,
	})) {
		out.push(content);
	}

	return out;
}

function sessionMeta(sessionId: string): Record<string, unknown> {
	return {
		timestamp: '2026-05-25T10:00:00Z',
		type: 'session_meta',
		payload: {
			id: sessionId,
			timestamp: '2026-05-25T10:00:00Z',
			cwd: '/tmp/project',
			cli_version: '0.131.0',
			model_provider: 'openai',
		},
	};
}

function userMessageEvent(message: string): Record<string, unknown> {
	return {
		timestamp: '2026-05-25T10:00:01Z',
		type: 'event_msg',
		payload: {
			type: 'user_message',
			message,
		},
	};
}

function userResponseItem(text: string): Record<string, unknown> {
	return {
		timestamp: '2026-05-25T10:00:01Z',
		type: 'response_item',
		payload: {
			type: 'message',
			role: 'user',
			content: [ { type: 'input_text', text } ],
		},
	};
}

test('extracts user_message event as user target', async t => {
	const sessionId = 'codex-session-1';
	const entries = [
		sessionMeta(sessionId),
		userMessageEvent('please push the branch'),
	];

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'user' ], sessionId);
		t.is(items.length, 1);
		t.is(items[0].target, 'user');
		t.is(items[0].text, 'please push the branch');
		t.is(items[0].sessionId, sessionId);
	} finally {
		await fixture.dispose();
	}
});

test('extracts user response_item input_text blocks', async t => {
	const sessionId = 'codex-session-2';
	const entries = [
		sessionMeta(sessionId),
		userResponseItem('<environment_context>\n  <cwd>/tmp</cwd>\n</environment_context>'),
		userResponseItem('do the thing'),
	];

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'user' ], sessionId);
		t.is(items.length, 2);
		t.true(items.some(c => c.text.includes('environment_context')));
		t.true(items.some(c => c.text === 'do the thing'));
	} finally {
		await fixture.dispose();
	}
});

test('uses session_meta id when sessionId option differs', async t => {
	const metaSessionId = 'codex-session-from-meta';
	const optionSessionId = 'codex-session-from-option';
	const entries = [
		sessionMeta(metaSessionId),
		userMessageEvent('hello'),
	];

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'user' ], optionSessionId);
		t.is(items.length, 1);
		t.is(items[0].sessionId, metaSessionId);
	} finally {
		await fixture.dispose();
	}
});

test('falls back to option sessionId when session_meta missing', async t => {
	const optionSessionId = 'codex-session-fallback';
	const entries = [
		userMessageEvent('hello'),
	];

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'user' ], optionSessionId);
		t.is(items.length, 1);
		t.is(items[0].sessionId, optionSessionId);
	} finally {
		await fixture.dispose();
	}
});

test('skips assistant response_items', async t => {
	const sessionId = 'codex-session-3';
	const entries = [
		sessionMeta(sessionId),
		userMessageEvent('user said this'),
		{
			timestamp: '2026-05-25T10:00:02Z',
			type: 'response_item',
			payload: {
				type: 'message',
				role: 'assistant',
				content: [ { type: 'output_text', text: 'assistant said this' } ],
			},
		},
	];

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'user' ], sessionId);
		t.is(items.length, 1);
		t.is(items[0].text, 'user said this');
	} finally {
		await fixture.dispose();
	}
});

test('yields nothing when user target not requested', async t => {
	const sessionId = 'codex-session-4';
	const entries = [
		sessionMeta(sessionId),
		userMessageEvent('still here'),
	];

	const fixture = await writeTranscript(entries);
	try {
		const items = await collectContent(fixture.filePath, [ 'assistant' ], sessionId);
		t.is(items.length, 0);
	} finally {
		await fixture.dispose();
	}
});

test('skips malformed JSON lines', async t => {
	const sessionId = 'codex-session-5';
	const dir = await mkdtemp(path.join(tmpdir(), 'claudex-codex-parser-test-'));
	const filePath = path.join(dir, 'rollout.jsonl');
	const content = [
		JSON.stringify(sessionMeta(sessionId)),
		'not valid json {',
		JSON.stringify(userMessageEvent('after the bad line')),
	].join('\n') + '\n';
	await writeFile(filePath, content);

	try {
		const items = await collectContent(filePath, [ 'user' ], sessionId);
		t.is(items.length, 1);
		t.is(items[0].text, 'after the bad line');
	} finally {
		await rm(dir, { recursive: true });
	}
});
