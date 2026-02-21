import net from 'node:net';
import { execa, type ResultPromise } from 'execa';

async function getDockerBridgeGateway(): Promise<string | undefined> {
	try {
		const { stdout } = await execa('docker', [ 'network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}' ]);
		const gateway = stdout.trim();
		return gateway || undefined;
	} catch {
		// Docker not available or bridge network not found
		return undefined;
	}
}

export async function waitForPort(port: number, host: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			// eslint-disable-next-line no-await-in-loop
			await new Promise<void>((resolve, reject) => {
				const socket = net.createConnection({ port, host }, () => {
					socket.destroy();
					resolve();
				});
				socket.on('error', reject);
			});
			return;
		} catch {
			// Port not ready yet, retry after short delay
			// eslint-disable-next-line no-await-in-loop
			await new Promise(resolve => {
				setTimeout(resolve, 50);
			});
		}
	}

	throw new Error(`Port ${port} on ${host} not ready after ${timeoutMs}ms`);
}

export async function startHostPortProxies(ports: number[]): Promise<(() => void) | undefined> {
	if (ports.length === 0) {
		return undefined;
	}

	const gateway = await getDockerBridgeGateway();
	if (!gateway) {
		console.error('Warning: could not determine Docker bridge gateway IP, host port proxies not started');
		return undefined;
	}

	const children: ResultPromise[] = [];
	let stopped = false;

	for (const port of ports) {
		// Listen on the Docker bridge gateway IP and forward to localhost
		// This allows containers to reach host-only services via host.docker.internal
		const child = execa('socat', [
			`TCP4-LISTEN:${port},fork,reuseaddr,bind=${gateway}`,
			`TCP4:127.0.0.1:${port}`,
		]);
		// Handle errors asynchronously without blocking
		// eslint-disable-next-line @typescript-eslint/no-loop-func
		void (async () => {
			try {
				await child;
			} catch (error: unknown) {
				if (stopped) {
					return;
				}

				console.error(`Host socat proxy port ${port} error:`, error instanceof Error ? error.message : error);
			}
		})();

		children.push(child);
	}

	// Wait for proxies to be ready
	await Promise.all(ports.map(async port => {
		try {
			await waitForPort(port, gateway);
			console.error(`Host proxy: ${gateway}:${port} → 127.0.0.1:${port}`);
		} catch {
			console.error(`Warning: host proxy for port ${port} may not be ready`);
		}
	}));

	return () => {
		stopped = true;
		for (const child of children) {
			child.kill();
		}
	};
}
