import net from 'node:net';
import process from 'node:process';
import { type HostMessage } from './protocol.js';
import { dispatchHostMessage } from './dispatch.js';

async function sendViaSocket(socketPath: string, message: HostMessage): Promise<void> {
	return new Promise((resolve, reject) => {
		const client = net.createConnection(socketPath, () => {
			client.end(JSON.stringify(message) + '\n');
		});

		client.on('error', reject);
		client.on('close', () => {
			resolve();
		});
	});
}

export async function sendHostMessage(message: HostMessage): Promise<void> {
	const socketPath = process.env.CLAUDEX_HOST_SOCKET;

	if (socketPath) {
		try {
			await sendViaSocket(socketPath, message);
			return;
		} catch {
			// Socket error, fall back to direct execution
		}
	}

	await dispatchHostMessage(message);
}
