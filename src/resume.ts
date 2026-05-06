import path from 'node:path';
import fs from 'node:fs/promises';
import { collapseHomedir } from './utils.js';
import {
	launcherRegistry,
	getAccountPrimaryDir, getAccountsRoot, walkSpecWraps,
	type LauncherSpec,
} from './launchers/registry.js';

export const sessionIdPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function encodeProjectPath(projectPath: string): string {
	return projectPath.replaceAll(/[/.]/g, '-');
}

export function extractResumeSessionId(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '--resume' || arg === '-r') {
			const next = args[i + 1];
			if (next && sessionIdPattern.test(next)) {
				return next;
			}
		} else if (arg.startsWith('--resume=')) {
			const value = arg.slice('--resume='.length);
			if (sessionIdPattern.test(value)) {
				return value;
			}
		}
	}

	return undefined;
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

export async function copyResumeSessionIfElsewhere(
	claudeArgs: string[],
	cwd: string,
	spec: LauncherSpec,
	account: string | undefined,
): Promise<void> {
	if (!walkSpecWraps(spec).some(s => s.name === 'claude')) {
		return;
	}

	const sessionId = extractResumeSessionId(claudeArgs);
	if (!sessionId) {
		return;
	}

	const claudeConfigDir = getAccountPrimaryDir(launcherRegistry.claude, account);
	if (!claudeConfigDir) {
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

	const projectsDirs = await collectClaudeProjectsDirs();
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
