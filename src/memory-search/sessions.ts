import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { SessionFile } from './types.js';

function encodeProjectPath(projectPath: string): string {
	return projectPath.replaceAll('/', '-');
}

async function readLine2(filePath: string): Promise<string | undefined> {
	const handle = await fs.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buffer, 0, 8192, 0);
		const text = buffer.toString('utf8', 0, bytesRead);
		const lines = text.split('\n');
		return lines[1];
	} finally {
		await handle.close();
	}
}

type ChainLink = {
	sessionId: string;
	previousSessionId?: string;
};

async function detectChainLink(filePath: string, fileSessionId: string): Promise<ChainLink> {
	const line2 = await readLine2(filePath);
	if (!line2) {
		return { sessionId: fileSessionId };
	}

	try {
		const entry = JSON.parse(line2) as Record<string, unknown>;
		if (entry.type !== 'user') {
			return { sessionId: fileSessionId };
		}

		const message = entry.message as Record<string, unknown> | undefined;
		if (!message) {
			return { sessionId: fileSessionId };
		}

		const { content } = message;
		let hasInterruptText = false;

		if (typeof content === 'string') {
			hasInterruptText = content.includes('[Request interrupted by user for tool use]');
		} else if (Array.isArray(content)) {
			for (const block of content as Array<Record<string, unknown>>) {
				if (block.type === 'text' && typeof block.text === 'string' && block.text.includes('[Request interrupted by user for tool use]')) {
					hasInterruptText = true;
					break;
				}
			}
		}

		if (hasInterruptText) {
			const linkedSessionId = entry.sessionId as string | undefined;
			if (linkedSessionId && linkedSessionId !== fileSessionId) {
				return { sessionId: fileSessionId, previousSessionId: linkedSessionId };
			}
		}
	} catch {}

	return { sessionId: fileSessionId };
}

async function findSubagentFiles(projectDir: string, sessionId: string): Promise<SessionFile[]> {
	const subagentDir = path.join(projectDir, sessionId, 'subagents');
	try {
		const entries = await fs.readdir(subagentDir);
		const agentFiles = entries.filter(entry => entry.startsWith('agent-') && entry.endsWith('.jsonl'));
		const files = await Promise.all(agentFiles.map(async entry => {
			const filePath = path.join(subagentDir, entry);
			const stat = await fs.stat(filePath);
			return { sessionId, filePath, mtime: stat.mtime };
		}));
		return files;
	} catch {
		return [];
	}
}

export async function discoverSessions(projectPath: string, specificSessionId?: string): Promise<SessionFile[]> {
	const encoded = encodeProjectPath(projectPath);
	const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);

	try {
		await fs.access(projectDir);
	} catch {
		return [];
	}

	const allEntries = await fs.readdir(projectDir);
	const jsonlFiles = allEntries.filter(entry => entry.endsWith('.jsonl'));

	if (specificSessionId) {
		const matching = jsonlFiles.filter(f => f.startsWith(specificSessionId));
		const nested = await Promise.all(matching.map(async f => {
			const filePath = path.join(projectDir, f);
			const stat = await fs.stat(filePath);
			const sid = f.replace('.jsonl', '');
			const subagents = await findSubagentFiles(projectDir, sid);
			return [ { sessionId: sid, filePath, mtime: stat.mtime }, ...subagents ];
		}));
		return nested.flat();
	}

	const sessionFiles = await Promise.all(jsonlFiles.map(async f => {
		const filePath = path.join(projectDir, f);
		const stat = await fs.stat(filePath);
		return {
			sessionId: f.replace('.jsonl', ''),
			filePath,
			mtime: stat.mtime,
		};
	}));

	const chainLinks = await Promise.all(sessionFiles.map(async sf => detectChainLink(sf.filePath, sf.sessionId)));

	const previousToNext = new Map<string, string>();
	for (const link of chainLinks) {
		if (link.previousSessionId) {
			previousToNext.set(link.previousSessionId, link.sessionId);
		}
	}

	const chainHeads = chainLinks
		.filter(link => !previousToNext.has(link.sessionId))
		.map(link => link.sessionId);

	const previousMap = new Map<string, string>();
	for (const link of chainLinks) {
		if (link.previousSessionId) {
			previousMap.set(link.sessionId, link.previousSessionId);
		}
	}

	const ordered: string[] = [];
	const visited = new Set<string>();

	const sessionMtimeMap = new Map<string, Date>();
	for (const sf of sessionFiles) {
		sessionMtimeMap.set(sf.sessionId, sf.mtime);
	}

	chainHeads.sort((a, b) => {
		const mtimeA = sessionMtimeMap.get(a) ?? new Date(0);
		const mtimeB = sessionMtimeMap.get(b) ?? new Date(0);
		return mtimeB.getTime() - mtimeA.getTime();
	});

	for (const head of chainHeads) {
		let current: string | undefined = head;
		const chain: string[] = [];
		while (current && !visited.has(current)) {
			chain.push(current);
			visited.add(current);
			current = previousMap.get(current);
		}

		ordered.push(...chain);
	}

	const remaining = sessionFiles
		.filter(sf => !visited.has(sf.sessionId))
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
		.map(sf => sf.sessionId);

	ordered.push(...remaining);

	const sessionFileMap = new Map<string, { filePath: string; mtime: Date }>();
	for (const sf of sessionFiles) {
		sessionFileMap.set(sf.sessionId, { filePath: sf.filePath, mtime: sf.mtime });
	}

	const orderedWithSubagents = await Promise.all(ordered.map(async sid => {
		const sf = sessionFileMap.get(sid);
		if (!sf) {
			return [];
		}

		const subagents = await findSubagentFiles(projectDir, sid);
		return [ { sessionId: sid, filePath: sf.filePath, mtime: sf.mtime }, ...subagents ];
	}));

	return orderedWithSubagents.flat();
}
