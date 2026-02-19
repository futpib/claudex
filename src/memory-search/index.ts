import process from 'node:process';
import { Command } from 'commander';
import type { SearchTarget, SearchOptions } from './types.js';
import { discoverSessions, getWorktreePaths } from './sessions.js';
import { searchSessions } from './search.js';
import { formatMatch, formatSummary, resetTruncationState, getDidTruncate } from './output.js';

const allTargets: SearchTarget[] = [ 'user', 'assistant', 'bash-command', 'bash-output', 'tool-use', 'tool-result' ];

export async function main(): Promise<void> {
	const program = new Command();

	program
		.name('claudex-memory-search')
		.description('Search Claude Code conversation transcripts')
		.showHelpAfterError()
		.argument('<pattern>', 'Pattern to search for (literal string and regex)')
		.option('-u, --user', 'Search user messages')
		.option('-a, --assistant', 'Search assistant text responses')
		.option('-c, --bash-command', 'Search bash commands')
		.option('-o, --bash-output', 'Search bash output/results')
		.option('-t, --tool-use', 'Search tool use (any tool name + input)')
		.option('-r, --tool-result', 'Search tool results (non-Bash)')
		.option('--project <path>', 'Project path', process.cwd())
		.option('--session <id>', 'Search only a specific session')
		.option('--context <n>', 'Context lines around matches', '0')
		.option('--max-results <n>', 'Max results', '50')
		.option('--max-line-width <n>', 'Max output line width (0 for unlimited)', '200')
		.option('--json', 'JSON output')
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
			} catch {}

			const searchOptions: SearchOptions = {
				patterns,
				targets,
				projectPath: options.project as string,
				sessionId: options.session as string | undefined,
				contextLines: Number.parseInt(options.context as string, 10),
				maxResults: Number.parseInt(options.maxResults as string, 10),
				maxLineWidth: Number.parseInt(options.maxLineWidth as string, 10),
				jsonOutput: Boolean(options.json),
			};

			const worktreePaths = await getWorktreePaths(searchOptions.projectPath);
			const uniquePaths = new Set(worktreePaths);
			if (!uniquePaths.has(searchOptions.projectPath)) {
				uniquePaths.add(searchOptions.projectPath);
			}

			const allSessions = await Promise.all(
				[...uniquePaths].map(p => discoverSessions(p, searchOptions.sessionId)),
			);

			const seen = new Set<string>();
			const sessions: typeof allSessions[0] = [];
			for (const batch of allSessions) {
				for (const session of batch) {
					if (!seen.has(session.filePath)) {
						seen.add(session.filePath);
						sessions.push(session);
					}
				}
			}

			if (sessions.length === 0) {
				console.error(`No session files found for project ${searchOptions.projectPath}`);
				process.exitCode = 1;
				return;
			}

			if (searchOptions.jsonOutput) {
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

	await program.parseAsync();
}
