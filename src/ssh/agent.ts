import process from 'node:process';
import { execa } from 'execa';

export type SshAgentInfo = {
	socketPath: string;
	pid: string;
	cleanup: () => Promise<void>;
};

export async function startSshAgent(keys: string[]): Promise<SshAgentInfo | undefined> {
	if (keys.length === 0) {
		return undefined;
	}

	// Start ssh-agent and parse its output
	const agentResult = await execa('ssh-agent', [ '-s' ]);
	const output = agentResult.stdout;

	const socketMatch = /SSH_AUTH_SOCK=([^;]+)/.exec(output);
	const pidMatch = /SSH_AGENT_PID=(\d+)/.exec(output);

	if (!socketMatch || !pidMatch) {
		console.error('Failed to parse ssh-agent output');
		return undefined;
	}

	const socketPath = socketMatch[1];
	const pid = pidMatch[1];

	// Add keys to the agent
	for (const key of keys) {
		try {
			// eslint-disable-next-line no-await-in-loop
			await execa('ssh-add', [ key ], {
				// eslint-disable-next-line @typescript-eslint/naming-convention
				env: { ...process.env, SSH_AUTH_SOCK: socketPath },
			});
		} catch (error) {
			console.error(`Failed to add SSH key ${key}:`, error instanceof Error ? error.message : error);
		}
	}

	const cleanup = async () => {
		try {
			await execa('kill', [ pid ]);
		} catch {
			// Agent may already be dead
		}
	};

	return { socketPath, pid, cleanup };
}
