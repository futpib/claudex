import test from 'ava';
import sinon from 'sinon';
import {
	startHostPortProxies,
	type SocatHandle,
	type IsReachableFn,
	type StartSocatFn,
} from './host.js';

const testGateway = '172.17.0.1';

type FakeSocat = SocatHandle & {
	port: number;
	killed: boolean;
	resolve: () => void;
};

function createSocatFactory(): { startSocat: StartSocatFn; handles: FakeSocat[] } {
	const handles: FakeSocat[] = [];
	const startSocat: StartSocatFn = (port: number) => {
		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>(resolve => {
			resolveDone = resolve;
		});
		const handle: FakeSocat = {
			port,
			killed: false,
			done,
			resolve: resolveDone,
			kill() {
				if (handle.killed) {
					return;
				}

				handle.killed = true;
				resolveDone();
			},
		};
		handles.push(handle);
		return handle;
	};

	return { startSocat, handles };
}

function reachabilityFromMap(state: Map<string, boolean>): IsReachableFn {
	return async (port: number, host: string) => state.get(`${host}:${port}`) ?? false;
}

async function nextTick(ms = 0): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

test('returns undefined when given an empty ports list', async t => {
	const cleanup = await startHostPortProxies([], {
		getGateway: async () => testGateway,
	});
	t.is(cleanup, undefined);
});

test('returns undefined when gateway cannot be determined', async t => {
	const startSocat = sinon.stub<Parameters<StartSocatFn>, ReturnType<StartSocatFn>>();
	const cleanup = await startHostPortProxies([ 5432 ], {
		getGateway: async () => undefined,
		startSocat,
	});
	t.is(cleanup, undefined);
	t.is(startSocat.callCount, 0);
});

test('does not start socat when no service is listening locally', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>();

	const cleanup = await startHostPortProxies([ 5432 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	t.not(cleanup, undefined);
	t.is(handles.length, 0);
	cleanup?.();
});

test('starts socat at startup when service is bound to localhost only', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>([
		[ '127.0.0.1:5432', true ],
		[ `${testGateway}:5432`, false ],
	]);

	const cleanup = await startHostPortProxies([ 5432 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	t.is(handles.length, 1);
	t.is(handles[0].port, 5432);
	cleanup?.();
});

test('does not start socat when service is already reachable on the gateway (bound 0.0.0.0)', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>([
		[ '127.0.0.1:5432', true ],
		[ `${testGateway}:5432`, true ],
	]);

	const cleanup = await startHostPortProxies([ 5432 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	t.is(handles.length, 0);
	cleanup?.();
});

test('starts socat after polling when a localhost-only service comes up', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>();

	const cleanup = await startHostPortProxies([ 5432 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	t.is(handles.length, 0);

	// User starts a host service bound to 127.0.0.1 only
	reachable.set('127.0.0.1:5432', true);
	reachable.set(`${testGateway}:5432`, false);

	// Wait long enough for at least one poll cycle
	await nextTick(50);

	t.is(handles.length, 1);
	t.is(handles[0].port, 5432);
	t.false(handles[0].killed);
	cleanup?.();
});

test('does not start socat when a 0.0.0.0-bound service comes up after startup', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>();

	const cleanup = await startHostPortProxies([ 5432 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	// User starts a host service bound to 0.0.0.0
	reachable.set('127.0.0.1:5432', true);
	reachable.set(`${testGateway}:5432`, true);

	await nextTick(50);

	t.is(handles.length, 0);
	cleanup?.();
});

test('stops socat when the local service goes away', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>([
		[ '127.0.0.1:5432', true ],
		[ `${testGateway}:5432`, false ],
	]);

	const cleanup = await startHostPortProxies([ 5432 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	t.is(handles.length, 1);
	t.false(handles[0].killed);

	// Local service goes down
	reachable.set('127.0.0.1:5432', false);

	await nextTick(50);

	t.true(handles[0].killed);
	cleanup?.();
});

test('restarts socat after a service flap (down then up again)', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>([
		[ '127.0.0.1:5432', true ],
		[ `${testGateway}:5432`, false ],
	]);

	const cleanup = await startHostPortProxies([ 5432 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	t.is(handles.length, 1);

	// Service goes down
	reachable.set('127.0.0.1:5432', false);
	await nextTick(50);
	t.true(handles[0].killed);

	// Service comes back, still 127.0.0.1 only
	reachable.set('127.0.0.1:5432', true);
	await nextTick(50);

	t.is(handles.length, 2);
	t.false(handles[1].killed);
	cleanup?.();
});

test('cleanup kills running socat proxies and stops the poll loop', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>([
		[ '127.0.0.1:5432', true ],
		[ `${testGateway}:5432`, false ],
		[ '127.0.0.1:6543', true ],
		[ `${testGateway}:6543`, false ],
	]);

	const cleanup = await startHostPortProxies([ 5432, 6543 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	t.is(handles.length, 2);
	t.false(handles[0].killed);
	t.false(handles[1].killed);

	cleanup?.();

	t.true(handles[0].killed);
	t.true(handles[1].killed);

	// Verify the poll loop no longer reacts to state changes
	const handlesAfterCleanup = handles.length;
	reachable.set('127.0.0.1:5432', false);
	reachable.set('127.0.0.1:5432', true);
	await nextTick(50);
	t.is(handles.length, handlesAfterCleanup);
});

test('handles multiple ports independently', async t => {
	const { startSocat, handles } = createSocatFactory();
	const reachable = new Map<string, boolean>([
		[ '127.0.0.1:5432', true ],
		[ `${testGateway}:5432`, false ],
		[ '127.0.0.1:6543', true ],
		[ `${testGateway}:6543`, true ], // Already on 0.0.0.0
	]);

	const cleanup = await startHostPortProxies([ 5432, 6543 ], {
		getGateway: async () => testGateway,
		isReachable: reachabilityFromMap(reachable),
		startSocat,
		pollIntervalMs: 10,
	});

	t.is(handles.length, 1);
	t.is(handles[0].port, 5432);
	cleanup?.();
});
