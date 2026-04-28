import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as jose from 'jose';
import { paths } from './paths.js';

function getHostOnlyDir(): string {
	return path.join(paths.data, 'host-only');
}

function getSecretPath(): string {
	return path.join(getHostOnlyDir(), 'confirm-secret');
}

function getConfirmationsDir(): string {
	return path.join(paths.data, 'confirmations');
}

function getPendingDir(): string {
	return path.join(paths.data, 'pending-confirmations');
}

export async function getOrCreateSecret(): Promise<Uint8Array> {
	try {
		const hex = await fs.readFile(getSecretPath(), 'utf8');
		return Buffer.from(hex.trim(), 'hex');
	} catch {
		const secret = crypto.randomBytes(32);
		await fs.mkdir(getHostOnlyDir(), { recursive: true });
		await fs.writeFile(getSecretPath(), secret.toString('hex'), { mode: 0o600 });
		return secret;
	}
}

export function hashAction(command: string): string {
	return crypto.createHash('sha256').update(command).digest('hex');
}

function confirmationKey(actionHash: string, sessionId: string): string {
	return crypto.createHash('sha256').update(`${actionHash}:${sessionId}`).digest('hex');
}

export type ConfirmationTokenPayload = {
	actionHash: string;
	reason: string;
	transcriptPath: string;
	sessionId: string;
};

export async function createConfirmationToken(
	actionHash: string,
	reason: string,
	transcriptPath: string,
	sessionId: string,
): Promise<string> {
	const secret = await getOrCreateSecret();
	return new jose.SignJWT({
		actionHash,
		reason,
		transcriptPath,
		sessionId,
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setIssuedAt()
		.setExpirationTime('1d')
		.sign(secret);
}

export async function verifyConfirmationToken(token: string): Promise<ConfirmationTokenPayload> {
	const secret = await getOrCreateSecret();
	const { payload } = await jose.jwtVerify(token, secret);
	return {
		actionHash: payload.actionHash as string,
		reason: payload.reason as string,
		transcriptPath: payload.transcriptPath as string,
		sessionId: payload.sessionId as string,
	};
}

export function generateShortId(): string {
	return crypto.randomBytes(6).toString('hex');
}

type PendingConfirmation = {
	token: string;
	command?: string;
};

export async function storePendingConfirmation(shortId: string, token: string, command?: string): Promise<void> {
	const pendingDir = getPendingDir();
	await fs.mkdir(pendingDir, { recursive: true });
	const data: PendingConfirmation = { token, command };
	await fs.writeFile(path.join(pendingDir, `${shortId}.json`), JSON.stringify(data));
}

export async function loadPendingConfirmation(shortId: string): Promise<PendingConfirmation> {
	const pendingDir = getPendingDir();
	const filePath = path.join(pendingDir, `${shortId}.json`);
	try {
		const content = await fs.readFile(filePath, 'utf8');
		return JSON.parse(content) as PendingConfirmation;
	} catch {
		// Fallback for old .jwt files
		const jwt = await fs.readFile(path.join(pendingDir, `${shortId}.jwt`), 'utf8');
		return { token: jwt };
	}
}

type StoredConfirmation = {
	actionHash: string;
	sessionId: string;
	token: string;
	proof: string;
	timestamp: string;
};

export async function storeConfirmation(actionHash: string, sessionId: string, token: string, proof: string): Promise<void> {
	const confirmationsDir = getConfirmationsDir();
	await fs.mkdir(confirmationsDir, { recursive: true });
	const key = confirmationKey(actionHash, sessionId);
	const data: StoredConfirmation = {
		actionHash,
		sessionId,
		token,
		proof,
		timestamp: new Date().toISOString(),
	};
	await fs.writeFile(
		path.join(confirmationsDir, `${key}.json`),
		JSON.stringify(data, null, 2),
	);
}

export async function hasConfirmation(actionHash: string, sessionId: string): Promise<boolean> {
	const confirmationsDir = getConfirmationsDir();
	const key = confirmationKey(actionHash, sessionId);
	const filePath = path.join(confirmationsDir, `${key}.json`);
	try {
		const content = await fs.readFile(filePath, 'utf8');
		const data = JSON.parse(content) as StoredConfirmation;
		const secret = await getOrCreateSecret();
		await jose.jwtVerify(data.token, secret);
		return true;
	} catch {
		return false;
	}
}
