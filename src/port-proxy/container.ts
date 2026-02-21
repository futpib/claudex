import process from 'node:process';
import { execa, type ResultPromise } from 'execa';
import { waitForPort } from './host.js';

export async function setupHostPortForwarding(): Promise<(() => void) | undefined> {
	const hostPorts = process.env.CLAUDEX_HOST_PORTS;
	if (!hostPorts) {
		return undefined;
	}

	const ports = hostPorts.split(',').map(Number).filter(p => p > 0);
	if (ports.length === 0) {
		return undefined;
	}

	const children: ResultPromise[] = [];

	let stopped = false;

	for (const port of ports) {
		// Listen on both IPv4 and IPv6 loopback so that
		// connections to localhost work regardless of resolution
		const child4 = execa('socat', [
			`TCP4-LISTEN:${port},fork,reuseaddr,bind=127.0.0.1`,
			`TCP:host.docker.internal:${port}`,
		]);
		const child6 = execa('socat', [
			`TCP6-LISTEN:${port},fork,reuseaddr,bind=::1`,
			`TCP:host.docker.internal:${port}`,
		]);
		for (const child of [ child4, child6 ]) {
			// Handle errors asynchronously without blocking
			// eslint-disable-next-line @typescript-eslint/no-loop-func
			void (async () => {
				try {
					await child;
				} catch (error: unknown) {
					if (stopped) {
						return;
					}

					console.error(`socat port ${port} error:`, error instanceof Error ? error.message : error);
				}
			})();
		}

		children.push(child4, child6);
	}

	// Wait for socat to start listening before continuing
	await Promise.all(ports.map(async port => {
		try {
			await waitForPort(port, '127.0.0.1');
			console.log(`Forwarding localhost:${port} → host:${port}`);
		} catch {
			console.error(`Warning: port ${port} forwarding may not be ready`);
		}
	}));

	return () => {
		stopped = true;
		for (const child of children) {
			child.kill();
		}
	};
}
