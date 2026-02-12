import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs/promises';
import { hostMessageSchema } from './protocol.js';
import { dispatchHostMessage } from './dispatch.js';

type HostSocketServer = {
	socketPath: string;
	cleanup: () => Promise<void>;
};

export async function startHostSocketServer(): Promise<HostSocketServer> {
	const randomSuffix = Math.random().toString(36).slice(2, 8);
	const socketPath = `${os.tmpdir()}/claudex-host-${randomSuffix}.sock`;

	const server = net.createServer(connection => {
		let buffer = '';

		connection.on('data', chunk => {
			buffer += String(chunk);

			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);

				if (!line.trim()) {
					continue;
				}

				try {
					const parsed: unknown = JSON.parse(line);
					const message = hostMessageSchema.parse(parsed);
					void dispatchHostMessage(message);
				} catch (error) {
					console.error('[claudex-host-socket] Failed to parse message:', error instanceof Error ? error.message : error);
				}
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.on('error', reject);
		server.listen(socketPath, () => {
			resolve();
		});
	});

	const cleanup = async () => {
		await new Promise<void>(resolve => {
			server.close(() => {
				resolve();
			});
		});

		try {
			await fs.unlink(socketPath);
		} catch {
			// Socket file may already be removed
		}
	};

	return { socketPath, cleanup };
}
