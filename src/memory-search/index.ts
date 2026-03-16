import process from 'node:process';
import { Command } from 'commander';
import { getAccountPaths } from '../account.js';
import { getMergedConfig } from '../config/index.js';
import type { SearchTarget, SearchOptions, SessionFile } from './types.js';
import { discoverSessions, getWorktreePaths } from './sessions.js';
import { searchSessions } from './search.js';
import {
	formatMatch, formatSummary, resetTruncationState, getDidTruncate,
} from './output.js';

function resolveSessionOffset(sessionValue: string | undefined, sessions: SessionFile[]): SessionFile[] {
	if (sessionValue === undefined || sessionValue === 'all') {
		return sessions;
	}

	if (/^-?\d+$/.test(sessionValue)) {
		const offset = Number.parseInt(sessionValue, 10);

		// Get unique parent session IDs preserving discovery order (newest-first)
		const parentSessions: SessionFile[] = [];
		const seenIds = new Set<string>();
		for (const s of sessions) {
			if (!s.isSubagent && !seenIds.has(s.sessionId)) {
				seenIds.add(s.sessionId);
				parentSessions.push(s);
			}
		}

		// Reverse to chronological order (oldest-first) for indexing
		const chronological = [ ...parentSessions ].reverse();

		const targetIndex = offset <= 0
			// -0 = latest (last in chronological), -1 = previous, etc.
			? chronological.length - 1 + offset
			// 1 = first (oldest), 1-based
			: offset - 1;

		if (targetIndex < 0 || targetIndex >= chronological.length) {
			const total = chronological.length;
			throw new Error(`Session offset ${sessionValue} is out of range (${total} session${total === 1 ? '' : 's'} available)`);
		}

		const targetSessionId = chronological[targetIndex].sessionId;

		// Return the target session and its subagents
		return sessions.filter(s => s.sessionId === targetSessionId);
	}

	// UUID prefix match
	return sessions.filter(s => s.sessionId.startsWith(sessionValue));
}

const allTargets: SearchTarget[] = [ 'user', 'assistant', 'bash-command', 'bash-output', 'tool-use', 'tool-result', 'subagent-prompt', 'compact-summary' ];

export function buildMemorySearchCommand(): Command {
	const command = new Command('search');

	command
		.description('Search Claude Code conversation transcripts')
		.showHelpAfterError()
		.argument('<pattern>', 'Pattern to search for (literal string and regex)')
		.option('-u, --user', 'Search user messages')
		.option('-a, --assistant', 'Search assistant text responses')
		.option('-c, --bash-command', 'Search bash commands')
		.option('-o, --bash-output', 'Search bash output/results')
		.option('-t, --tool-use', 'Search tool use (any tool name + input)')
		.option('-r, --tool-result', 'Search tool results (non-Bash)')
		.option('-s, --subagent-prompt', 'Search subagent prompts')
		.option('--compact-summary', 'Search compact/continuation summaries')
		.option('--account <name>', 'Use a specific claudex account')
		.option('--project <path>', 'Project path', process.cwd())
		.option('--session <id>', 'Search only a specific session')
		.option('-C, --context <n>', 'Context lines around matches')
		.option('-B, --before-context <n>', 'Context lines before matches')
		.option('-A, --after-context <n>', 'Context lines after matches')
		.option('--max-results <n>', 'Max results', '50')
		.option('--max-line-width <n>', 'Max output line width (0 for unlimited)', '200')
		.option('--json', 'JSON output')
		.option('-l, --sessions-with-matches', 'Only print session IDs with matches')
		.option('-i, --ignore-case', 'Case-insensitive search')
		.action(async (pattern: string, options: Record<string, unknown>) => {
			const targets = new Set<SearchTarget>();
			if (options.user) {
				targets.add('user');
			}

			if (options.assistant) {
				targets.add('assistant');
			}

			if (options.bashCommand) {
				targets.add('bash-command');
			}

			if (options.bashOutput) {
				targets.add('bash-output');
			}

			if (options.toolUse) {
				targets.add('tool-use');
			}

			if (options.toolResult) {
				targets.add('tool-result');
			}

			if (options.subagentPrompt) {
				targets.add('subagent-prompt');
			}

			if (options.compactSummary) {
				targets.add('compact-summary');
			}

			if (targets.size === 0) {
				for (const t of allTargets) {
					targets.add(t);
				}
			}

			const flags = options.ignoreCase ? 'gi' : 'g';
			const literalPattern = new RegExp(pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`), flags);
			const patterns: RegExp[] = [ literalPattern ];

			try {
				const regexPattern = new RegExp(pattern, flags);
				if (regexPattern.source !== literalPattern.source) {
					patterns.push(regexPattern);
				}
			} catch {
				// Pattern is not valid regex — use literal match only
			}

			const contextSymmetric = options.context ? Number.parseInt(options.context as string, 10) : 0;
			const contextBefore = options.beforeContext ? Number.parseInt(options.beforeContext as string, 10) : contextSymmetric;
			const contextAfter = options.afterContext ? Number.parseInt(options.afterContext as string, 10) : contextSymmetric;

			const searchOptions: SearchOptions = {
				patterns,
				targets,
				projectPath: options.project as string,
				sessionId: options.session as string | undefined,
				contextBefore,
				contextAfter,
				maxResults: Number.parseInt(options.maxResults as string, 10),
				maxLineWidth: Number.parseInt(options.maxLineWidth as string, 10),
				jsonOutput: Boolean(options.json),
				sessionsWithMatches: Boolean(options.sessionsWithMatches),
			};

			let account = options.account as string | undefined;
			if (!account) {
				const merged = await getMergedConfig(searchOptions.projectPath);
				account = merged.account;
			}

			const accountPaths = getAccountPaths(account);

			const worktreePaths = await getWorktreePaths(searchOptions.projectPath);
			const uniquePaths = new Set(worktreePaths);
			if (!uniquePaths.has(searchOptions.projectPath)) {
				uniquePaths.add(searchOptions.projectPath);
			}

			const allSessions = await Promise.all([ ...uniquePaths ].map(async p => discoverSessions(p, undefined, accountPaths.claudeConfigDir)));

			const seen = new Set<string>();
			const deduplicated: SessionFile[] = [];
			for (const batch of allSessions) {
				for (const session of batch) {
					if (!seen.has(session.filePath)) {
						seen.add(session.filePath);
						deduplicated.push(session);
					}
				}
			}

			let sessions: SessionFile[];
			try {
				sessions = resolveSessionOffset(searchOptions.sessionId, deduplicated);
			} catch (error) {
				console.error((error as Error).message);
				process.exitCode = 1;
				return;
			}

			if (sessions.length === 0) {
				console.error(`No session files found for project ${searchOptions.projectPath}`);
				process.exitCode = 1;
				return;
			}

			if (searchOptions.sessionsWithMatches) {
				const sessionFilePaths = new Map<string, string>();
				for (const session of sessions) {
					sessionFilePaths.set(session.sessionId, session.filePath);
				}

				const seenPaths = new Set<string>();
				for await (const match of searchSessions(sessions, searchOptions)) {
					const filePath = sessionFilePaths.get(match.sessionId) ?? match.sessionId;
					if (!seenPaths.has(filePath)) {
						seenPaths.add(filePath);
						console.log(filePath);
					}
				}

				if (seenPaths.size === 0) {
					process.exitCode = 1;
				}
			} else if (searchOptions.jsonOutput) {
				const results = [];
				for await (const match of searchSessions(sessions, searchOptions)) {
					results.push({
						matchNumber: match.matchNumber,
						sessionId: match.sessionId,
						timestamp: match.timestamp,
						target: match.target,
						toolName: match.toolName,
						matchedLines: match.matchedLines,
					});
				}

				console.log(JSON.stringify(results, null, 2));
			} else {
				resetTruncationState();
				let count = 0;
				for await (const match of searchSessions(sessions, searchOptions)) {
					if (count > 0) {
						console.log();
					}

					console.log(formatMatch(match, patterns, searchOptions.maxLineWidth));
					count++;
				}

				console.log(formatSummary(count, searchOptions.projectPath, sessions.length));

				if (getDidTruncate()) {
					console.error('Hint: Some lines were truncated. Use --max-line-width 0 for full output, or --max-line-width <n> to adjust.');
				}
			}
		});

	return command;
}
