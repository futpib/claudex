import { execa } from 'execa';
import { type HostMessage, type NotifyMessage, type JournalMessage } from './protocol.js';

async function handleNotify(message: NotifyMessage): Promise<void> {
	const args: string[] = [ '--app-name', 'claudex' ];
	if (message.urgency) {
		args.push('-u', message.urgency);
	}

	args.push(message.summary);
	if (message.body) {
		args.push(message.body);
	}

	try {
		await execa('notify-send', args);
	} catch {
		// Notify-send unavailable, silently ignore
	}
}

async function handleJournal(message: JournalMessage): Promise<void> {
	try {
		await execa('systemd-cat', [ '-t', message.tag, '-p', message.priority ?? 'info' ], {
			input: message.message,
		});
	} catch {
		// Systemd-cat unavailable, silently ignore
	}
}

export async function dispatchHostMessage(message: HostMessage): Promise<void> {
	if (message.type === 'notify') {
		await handleNotify(message as NotifyMessage);
	} else if (message.type === 'journal') {
		await handleJournal(message as JournalMessage);
	} else {
		console.error(`[claudex-host-socket] Unknown message type: ${message.type}`);
	}
}
