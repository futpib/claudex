import path from 'node:path';
import fs from 'node:fs/promises';
import { collapseHomedir } from './utils.js';
import {
	launcherRegistry,
	getAccountPrimaryDir, getAccountsRoot, walkSpecWraps,
	type LauncherSpec,
} from './launchers/registry.js';

export const sessionIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

// Anything that could be a leading slice of a UUID: hex chars and dashes only,
// no longer than a full UUID, with no consecutive or trailing dashes.
export const sessionIdOrPrefixPattern = /^[\da-f]+(?:-[\da-f]+)*$/i;

export function encodeProjectPath(projectPath: string): string {
	return projectPath.replaceAll(/[/.]/g, '-');
}

export type SessionArgFlag = '--resume' | '-r' | '--session-id';
const sessionArgFlags: readonly SessionArgFlag[] = [ '--resume', '-r', '--session-id' ];

export type SessionArgLocation = {
	value: string;
	argIndex: number;
	inline: boolean;
	flag: SessionArgFlag;
};

export function extractSessionArgLocation(args: string[]): SessionArgLocation | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		const matchedFlag = sessionArgFlags.find(f => arg === f);
		if (matchedFlag) {
			const next = args[i + 1];
			if (next && next.length <= 36 && sessionIdOrPrefixPattern.test(next)) {
				return {
					value: next, argIndex: i + 1, inline: false, flag: matchedFlag,
				};
			}

			continue;
		}

		// Inline `--flag=value` form is only standard for long flags.
		for (const flag of sessionArgFlags) {
			if (!flag.startsWith('--')) {
				continue;
			}

			const prefix = `${flag}=`;
			if (arg.startsWith(prefix)) {
				const value = arg.slice(prefix.length);
				if (value.length <= 36 && sessionIdOrPrefixPattern.test(value)) {
					return {
						value, argIndex: i, inline: true, flag,
					};
				}

				break;
			}
		}
	}

	return undefined;
}

export function extractResumeSessionId(args: string[]): string | undefined {
	const location = extractSessionArgLocation(args);
	if (!location || !sessionIdPattern.test(location.value)) {
		return undefined;
	}

	return location.value;
}

export function replaceSessionArgValue(args: string[], location: SessionArgLocation, fullId: string): void {
	args[location.argIndex] = location.inline ? `${location.flag}=${fullId}` : fullId;
}

export async function collectClaudeProjectsDirs(): Promise<string[]> {
	const dirs: string[] = [];

	const defaultClaudeDir = getAccountPrimaryDir(launcherRegistry.claude, undefined);
	if (defaultClaudeDir) {
		dirs.push(path.join(defaultClaudeDir, 'projects'));
	}

	const accountsRoot = getAccountsRoot();
	let accountEntries: string[];
	try {
		accountEntries = await fs.readdir(accountsRoot);
	} catch {
		accountEntries = [];
	}

	for (const account of accountEntries) {
		const accountClaudeDir = getAccountPrimaryDir(launcherRegistry.claude, account);
		if (accountClaudeDir) {
			dirs.push(path.join(accountClaudeDir, 'projects'));
		}
	}

	return dirs;
}

export async function findSessionFilesInDirs(
	sessionId: string,
	projectsDirs: string[],
): Promise<string[]> {
	const matches: string[] = [];

	for (const projectsDir of projectsDirs) {
		let entries: string[];
		try {
			// eslint-disable-next-line no-await-in-loop
			entries = await fs.readdir(projectsDir);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const candidate = path.join(projectsDir, entry, `${sessionId}.jsonl`);
			try {
				// eslint-disable-next-line no-await-in-loop
				await fs.access(candidate);
				matches.push(candidate);
			} catch {
				// Not present here — keep looking
			}
		}
	}

	return matches;
}

export async function findSessionIdsByPrefix(
	prefix: string,
	projectsDirs: string[],
): Promise<Set<string>> {
	const ids = new Set<string>();
	const lowerPrefix = prefix.toLowerCase();

	for (const projectsDir of projectsDirs) {
		let entries: string[];
		try {
			// eslint-disable-next-line no-await-in-loop
			entries = await fs.readdir(projectsDir);
		} catch {
			continue;
		}

		for (const entry of entries) {
			const projectDir = path.join(projectsDir, entry);
			let files: string[];
			try {
				// eslint-disable-next-line no-await-in-loop
				files = await fs.readdir(projectDir);
			} catch {
				continue;
			}

			for (const file of files) {
				if (!file.endsWith('.jsonl')) {
					continue;
				}

				const id = file.slice(0, -'.jsonl'.length);
				if (sessionIdPattern.test(id) && id.toLowerCase().startsWith(lowerPrefix)) {
					ids.add(id);
				}
			}
		}
	}

	return ids;
}

async function expandSessionPrefix(
	claudeArgs: string[],
	location: SessionArgLocation,
	projectsDirs: string[],
): Promise<string | undefined> {
	if (sessionIdPattern.test(location.value)) {
		return location.value;
	}

	const matchedIds = await findSessionIdsByPrefix(location.value, projectsDirs);
	if (matchedIds.size === 0) {
		return undefined;
	}

	if (matchedIds.size > 1) {
		const formatted = [ ...matchedIds ].sort().map(id => `  ${id}`).join('\n');
		console.error(`Cannot resolve session: prefix ${location.value} matches multiple sessions:\n${formatted}`);
		return undefined;
	}

	const [ fullId ] = matchedIds;
	replaceSessionArgValue(claudeArgs, location, fullId);
	console.error(`Expanded session prefix ${location.value} → ${fullId}`);
	return fullId;
}

export async function copyResumeSessionIfElsewhere(
	claudeArgs: string[],
	cwd: string,
	spec: LauncherSpec,
	account: string | undefined,
): Promise<void> {
	if (!walkSpecWraps(spec).some(s => s.name === 'claude')) {
		return;
	}

	const location = extractSessionArgLocation(claudeArgs);
	if (!location) {
		return;
	}

	const claudeConfigDir = getAccountPrimaryDir(launcherRegistry.claude, account);
	if (!claudeConfigDir) {
		return;
	}

	const projectsDirs = await collectClaudeProjectsDirs();
	const sessionId = await expandSessionPrefix(claudeArgs, location, projectsDirs);
	if (!sessionId) {
		return;
	}

	const currentEncoded = encodeProjectPath(cwd);
	const targetPath = path.join(claudeConfigDir, 'projects', currentEncoded, `${sessionId}.jsonl`);

	try {
		await fs.access(targetPath);
		return;
	} catch {
		// Not in current project dir — search across all accounts
	}

	const matches = await findSessionFilesInDirs(sessionId, projectsDirs);
	if (matches.length === 0) {
		return;
	}

	if (matches.length > 1) {
		const formatted = matches.map(m => `  ${collapseHomedir(m)}`).join('\n');
		console.error(`Cannot resume session ${sessionId}: found multiple matching transcripts:\n${formatted}`);
		return;
	}

	const sourcePath = matches[0];
	await fs.mkdir(path.dirname(targetPath), { recursive: true });
	await fs.copyFile(sourcePath, targetPath);
	console.error(`Copied session ${sessionId}: ${collapseHomedir(sourcePath)} → ${collapseHomedir(targetPath)}`);
}
