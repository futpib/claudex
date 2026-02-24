import {
	type SearchMatch, type MatchedLine, type SearchOptions, type SessionFile,
} from './types.js';
import { buildToolUseMap, extractContent } from './parser.js';

function testAny(patterns: RegExp[], text: string): boolean {
	for (const p of patterns) {
		p.lastIndex = 0;
		if (p.test(text)) {
			return true;
		}
	}

	return false;
}

function findMatches(text: string, patterns: RegExp[], contextBefore: number, contextAfter: number): MatchedLine[] | undefined {
	const lines = text.split('\n');
	const matchingLineNumbers = new Set<number>();

	for (const [ i, line ] of lines.entries()) {
		if (testAny(patterns, line)) {
			matchingLineNumbers.add(i);
		}
	}

	if (matchingLineNumbers.size === 0) {
		return undefined;
	}

	if (contextBefore === 0 && contextAfter === 0) {
		return [ ...matchingLineNumbers ].map(n => ({
			lineNumber: n,
			line: lines[n],
			isMatch: true,
		}));
	}

	const visibleLines = new Set<number>();
	for (const n of matchingLineNumbers) {
		for (let i = Math.max(0, n - contextBefore); i <= Math.min(lines.length - 1, n + contextAfter); i++) {
			visibleLines.add(i);
		}
	}

	const sorted = [ ...visibleLines ].sort((a, b) => a - b);
	return sorted.map(n => ({
		lineNumber: n,
		line: lines[n],
		isMatch: matchingLineNumbers.has(n),
	}));
}

export async function * searchSessions(
	sessions: SessionFile[],
	options: SearchOptions,
): AsyncGenerator<SearchMatch> {
	let matchNumber = 0;

	for (const session of sessions) {
		if (matchNumber >= options.maxResults) {
			break;
		}

		const toolUseMap = await buildToolUseMap(session.filePath); // eslint-disable-line no-await-in-loop

		for await (const content of extractContent(session.filePath, toolUseMap, { targets: options.targets, sessionId: session.sessionId, isSubagent: session.isSubagent })) { // eslint-disable-line no-await-in-loop
			if (matchNumber >= options.maxResults) {
				break;
			}

			const matched = findMatches(content.text, options.patterns, options.contextBefore, options.contextAfter);
			if (matched) {
				matchNumber++;
				yield {
					matchNumber,
					sessionId: content.sessionId,
					timestamp: content.timestamp,
					target: content.target,
					toolName: content.toolName,
					text: content.text,
					matchedLines: matched,
				};
			}
		}
	}
}
