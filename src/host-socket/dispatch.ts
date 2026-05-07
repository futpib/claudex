import process from 'node:process';
import fs from 'node:fs/promises';
import { execa as defaultExeca } from 'execa';
import { type HostMessage, type NotifyMessage, type JournalMessage } from './protocol.js';

const notifyWaitTimeoutMs = 60_000;
const maxParentWalkDepth = 16;

export type ExecaFn = (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout?: string }>;
export type ReadPpidFn = (pid: string) => Promise<string | undefined>;

async function defaultReadPpid(pid: string): Promise<string | undefined> {
	try {
		const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
		const match = /^PPid:\s+(\d+)$/m.exec(status);
		const parent = match?.[1];
		return parent && parent !== '0' ? parent : undefined;
	} catch {
		return undefined;
	}
}

async function findWindowForPid(pid: string, execa: ExecaFn): Promise<string | undefined> {
	try {
		const result = await execa('xdotool', [ 'search', '--pid', pid ]);
		const windows = result.stdout?.trim().split('\n').filter(Boolean) ?? [];
		return windows[0];
	} catch {
		return undefined;
	}
}

async function resolveTmuxClientWindowId(execa: ExecaFn, readPpid: ReadPpidFn): Promise<string | undefined> {
	let pid: string | undefined;
	try {
		const clientResult = await execa('tmux', [ 'display', '-p', '#{client_pid}' ]);
		pid = clientResult.stdout?.trim();
	} catch {
		return undefined;
	}

	for (let i = 0; i < maxParentWalkDepth && pid; i++) {
		// eslint-disable-next-line no-await-in-loop
		const window = await findWindowForPid(pid, execa);
		if (window) {
			return window;
		}

		// eslint-disable-next-line no-await-in-loop
		pid = await readPpid(pid);
	}

	return undefined;
}

async function resolveWindowId(execa: ExecaFn, readPpid: ReadPpidFn): Promise<string | undefined> {
	const tmuxSocket = process.env.TMUX;
	const envWindowId = process.env.WINDOWID;

	if (tmuxSocket) {
		const fromTmux = await resolveTmuxClientWindowId(execa, readPpid);
		if (fromTmux) {
			return fromTmux;
		}
	}

	return envWindowId;
}

export async function handleNotify(message: NotifyMessage, execa: ExecaFn = defaultExeca, readPpid: ReadPpidFn = defaultReadPpid): Promise<void> {
	const args: string[] = [ '--app-name', 'claudex' ];
	if (message.urgency) {
		args.push('-u', message.urgency);
	}

	const windowId = await resolveWindowId(execa, readPpid);

	// Skip notification if the window is already focused
	if (windowId) {
		try {
			const active = await execa('xdotool', [ 'getactivewindow' ]);
			if (active.stdout?.trim() === windowId) {
				return;
			}
		} catch {
			// Xdotool not available or no active window — continue with notification
		}

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
