import process from 'node:process';
import { execa as defaultExeca } from 'execa';
import { type HostMessage, type NotifyMessage, type JournalMessage } from './protocol.js';

const notifyWaitTimeoutMs = 60_000;

export type ExecaFn = (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout?: string }>;

async function resolveWindowId(execa: ExecaFn): Promise<string | undefined> {
	if (process.env.TMUX) {
		try {
			const result = await execa('tmux', [ 'show-environment', 'WINDOWID' ]);
			const match = /^WINDOWID=(.+)$/.exec(result.stdout?.trim() ?? '');
			if (match) {
				return match[1];
			}
		} catch {
			// Tmux not available or no WINDOWID in session environment
		}
	}

	return process.env.WINDOWID;
}

export async function handleNotify(message: NotifyMessage, execa: ExecaFn = defaultExeca): Promise<void> {
	const args: string[] = [ '--app-name', 'claudex' ];
	if (message.urgency) {
		args.push('-u', message.urgency);
	}

	const windowId = await resolveWindowId(execa);
	if (windowId) {
		args.push('--action', 'default=Focus');
	}

	args.push(message.summary);
	if (message.body) {
		args.push(message.body);
	}

	if (windowId) {
		void notifyAndFocus(args, windowId, execa);
	} else {
		try {
			await execa('notify-send', args);
		} catch (error) {
			console.warn('[claudex] Failed to send notification:', error instanceof Error ? error.message : error);
		}
	}
}

export async function notifyAndFocus(args: string[], windowId: string, execa: ExecaFn = defaultExeca): Promise<void> {
	try {
		const result = await execa('notify-send', args, {
			cancelSignal: AbortSignal.timeout(notifyWaitTimeoutMs),
		});
		if (result.stdout?.trim() === 'default') {
			await execa('xdotool', [ 'windowactivate', windowId ]);
		}
	} catch (error) {
		if (error instanceof Error && 'isCanceled' in error && error.isCanceled) {
			return;
		}

		console.debug('[claudex] Failed to send notification or focus window:', error instanceof Error ? error.message : error);
	}
}

async function handleJournal(message: JournalMessage): Promise<void> {
	try {
		await defaultExeca('systemd-cat', [ '-t', message.tag, '-p', message.priority ?? 'info' ], {
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
