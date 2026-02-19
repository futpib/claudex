import type { SearchMatch } from './types.js';

let didTruncate = false;

export function resetTruncationState(): void {
	didTruncate = false;
}

export function getDidTruncate(): boolean {
	return didTruncate;
}

const ansi = {
	reset: '\u001B[0m',
	bold: '\u001B[1m',
	dim: '\u001B[2m',
	cyan: '\u001B[36m',
	yellow: '\u001B[33m',
	boldYellow: '\u001B[1;33m',
};

function firstMatchPosition(line: string, patterns: RegExp[]): { index: number; length: number } | undefined {
	let best: { index: number; length: number } | undefined;
	for (const p of patterns) {
		p.lastIndex = 0;
		const m = p.exec(line);
		if (m && (!best || m.index < best.index)) {
			best = { index: m.index, length: m[0].length };
		}
	}

	return best;
}

function truncateLine(line: string, patterns: RegExp[], maxLineWidth: number): string {
	if (maxLineWidth === 0 || line.length <= maxLineWidth) {
		return line;
	}

	const match = firstMatchPosition(line, patterns);
	didTruncate = true;

	if (!match) {
		return line.slice(0, maxLineWidth) + '...';
	}

	const contextBudget = maxLineWidth - match.length;
	const before = Math.floor(contextBudget / 2);
	const after = contextBudget - before;

	const start = Math.max(0, match.index - before);
	const end = Math.min(line.length, match.index + match.length + after);

	const prefix = start > 0 ? '...' : '';
	const suffix = end < line.length ? '...' : '';
	return prefix + line.slice(start, end) + suffix;
}

function highlightMatches(line: string, patterns: RegExp[], maxLineWidth: number): string {
	const truncated = truncateLine(line, patterns, maxLineWidth);
	let result = truncated;
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		result = result.replaceAll(pattern, match => `${ansi.boldYellow}${match}${ansi.reset}`);
	}

	return result;
}

function formatTimestamp(timestamp: string): string {
	if (!timestamp) {
		return 'unknown';
	}

	try {
		const date = new Date(timestamp);
		return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
	} catch {
		return timestamp;
	}
}

export function formatMatch(match: SearchMatch, patterns: RegExp[], maxLineWidth: number): string {
	const shortSession = match.sessionId.slice(0, 8);
	const time = formatTimestamp(match.timestamp);

	const header = `${ansi.cyan}--- Match #${match.matchNumber} | session=${shortSession} | ${time} | ${match.target} ---${ansi.reset}`;

	const lines: string[] = [ header ];

	if (match.toolName) {
		lines.push(`${ansi.dim}tool: ${match.toolName}${ansi.reset}`);
	}

	for (const ml of match.matchedLines) {
		const prefix = ml.isMatch ? '> ' : '  ';
		const content = ml.isMatch ? highlightMatches(ml.line, patterns, maxLineWidth) : truncateLine(ml.line, patterns, maxLineWidth);
		lines.push(`${prefix}${content}`);
	}

	return lines.join('\n');
}

export function formatSummary(count: number, projectPath: string, sessionCount: number): string {
	const projectInfo = `${ansi.dim}Searched ${sessionCount} session${sessionCount === 1 ? '' : 's'} for project ${projectPath}${ansi.reset}`;

	if (count === 0) {
		return `${projectInfo}\nNo matches found.`;
	}

	return `\n${projectInfo}\n${ansi.dim}${count} match${count === 1 ? '' : 'es'} found.${ansi.reset}`;
}
