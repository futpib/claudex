import net from 'node:net';
import { execa, type ResultPromise } from 'execa';

const pollIntervalMs = 1000;
const reachabilityTimeoutMs = 200;

export type SocatHandle = {
	kill: () => void;
	done: Promise<unknown>;
};

export type GetGatewayFn = () => Promise<string | undefined>;
export type IsReachableFn = (port: number, host: string, timeoutMs?: number) => Promise<boolean>;
export type StartSocatFn = (port: number, gateway: string) => SocatHandle;

export type HostPortProxyDeps = {
	getGateway?: GetGatewayFn;
	isReachable?: IsReachableFn;
	startSocat?: StartSocatFn;
	pollIntervalMs?: number;
};

async function defaultGetGateway(): Promise<string | undefined> {
	try {
		const { stdout } = await execa('docker', [ 'network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}' ]);
		const gateway = stdout.trim();
		return gateway || undefined;
	} catch {
		// Docker not available or bridge network not found
		return undefined;
	}
}

export async function isReachable(port: number, host: string, timeoutMs = reachabilityTimeoutMs): Promise<boolean> {
	return new Promise<boolean>(resolve => {
		const socket = net.createConnection({ port, host });
		const finish = (result: boolean) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};

		socket.once('connect', () => {
			finish(true);
		});
		socket.once('error', () => {
			finish(false);
		});
		socket.setTimeout(timeoutMs, () => {
			finish(false);
		});
	});
}

export async function waitForPort(port: number, host: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		// eslint-disable-next-line no-await-in-loop
		if (await isReachable(port, host, 50)) {
			return;
		}

		// eslint-disable-next-line no-await-in-loop
		await new Promise(resolve => {
			setTimeout(resolve, 50);
		});
	}

	throw new Error(`Port ${port} on ${host} not ready after ${timeoutMs}ms`);
}

function defaultStartSocat(port: number, gateway: string): SocatHandle {
	// Listen on the Docker bridge gateway IP and forward to localhost
	// This allows containers to reach host-only services via host.docker.internal
	const child: ResultPromise = execa('socat', [
		`TCP4-LISTEN:${port},fork,reuseaddr,bind=${gateway}`,
		`TCP4:127.0.0.1:${port}`,
	]);
	return {
		kill() {
			child.kill();
		},
		done: child,
	};
}

type ProxyContext = {
	gateway: string;
	proxies: Map<number, SocatHandle>;
	isStopped: () => boolean;
	isReachable: IsReachableFn;
	startSocat: StartSocatFn;
};

async function reconcileProxy(port: number, ctx: ProxyContext): Promise<void> {
	const [ localUp, gatewayUp ] = await Promise.all([
		ctx.isReachable(port, '127.0.0.1'),
		ctx.isReachable(port, ctx.gateway),
	]);

	if (ctx.isStopped()) {
		return;
	}

	const running = ctx.proxies.get(port);

	if (localUp && !gatewayUp && !running) {
		// Service is bound to 127.0.0.1 only — start a proxy so containers
		// can reach it via the Docker bridge gateway.
		const handle = ctx.startSocat(port, ctx.gateway);
		ctx.proxies.set(port, handle);
		console.error(`Host proxy: ${ctx.gateway}:${port} → 127.0.0.1:${port}`);
		void (async () => {
			try {
				await handle.done;
			} catch (error: unknown) {
				if (!ctx.isStopped()) {
					console.error(`Host socat proxy port ${port} error:`, error instanceof Error ? error.message : error);
				}
			}

			if (ctx.proxies.get(port) === handle) {
				ctx.proxies.delete(port);
			}
		})();
	} else if (!localUp && running) {
		// Local service is gone — drop the proxy so the user can rebind
		// (e.g. start a service on 0.0.0.0) without an EADDRINUSE.
		running.kill();
		ctx.proxies.delete(port);
		console.error(`Host proxy: stopped for port ${port}`);
	}
}

export async function startHostPortProxies(
	ports: number[],
	deps: HostPortProxyDeps = {},
): Promise<(() => void) | undefined> {
	if (ports.length === 0) {
		return undefined;
	}

	const getGateway = deps.getGateway ?? defaultGetGateway;
	const interval = deps.pollIntervalMs ?? pollIntervalMs;

	const gateway = await getGateway();
	if (!gateway) {
		console.error('Warning: could not determine Docker bridge gateway IP, host port proxies not started');
		return undefined;
	}

	const state = { stopped: false };
	const proxies = new Map<number, SocatHandle>();
	const ctx: ProxyContext = {
		gateway,
		proxies,
		isStopped: () => state.stopped,
		isReachable: deps.isReachable ?? isReachable,
		startSocat: deps.startSocat ?? defaultStartSocat,
	};

	// Run one reconciliation now so services already up at startup get a proxy
	// without waiting for the first poll tick.
	await Promise.all(ports.map(async port => reconcileProxy(port, ctx)));

	for (const port of ports) {
		void watchPort(port, ctx, interval);
	}

	return () => {
		state.stopped = true;
		for (const handle of proxies.values()) {
			handle.kill();
		}

		proxies.clear();
	};
}

async function watchPort(port: number, ctx: ProxyContext, interval: number): Promise<void> {
	while (!ctx.isStopped()) {
		// eslint-disable-next-line no-await-in-loop
		await new Promise<void>(resolve => {
			setTimeout(resolve, interval);
		});
		if (ctx.isStopped()) {
			break;
		}

		// eslint-disable-next-line no-await-in-loop
		await reconcileProxy(port, ctx);
	}
}
