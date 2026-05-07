import process from 'node:process';
import test from 'ava';
import sinon from 'sinon';
import {
	handleNotify,
	notifyAndFocus,
	type ExecaFn,
	type ReadPpidFn,
} from './dispatch.js';

function createExecaStub(stdout = '') {
	return sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>()
		.resolves({ stdout });
}

function withEnv<T>(windowId: string | undefined, tmux: string | undefined, fn: () => T): T {
	const savedWindowId = process.env.WINDOWID;
	const savedTmux = process.env.TMUX;

	if (windowId === undefined) {
		delete process.env.WINDOWID;
	} else {
		process.env.WINDOWID = windowId;
	}

	if (tmux === undefined) {
		delete process.env.TMUX;
	} else {
		process.env.TMUX = tmux;
	}

	try {
		return fn();
	} finally {
		if (savedWindowId === undefined) {
			delete process.env.WINDOWID;
		} else {
			process.env.WINDOWID = savedWindowId;
		}

		if (savedTmux === undefined) {
			delete process.env.TMUX;
		} else {
			process.env.TMUX = savedTmux;
		}
	}
}

function withWindowId<T>(windowId: string | undefined, fn: () => T): T {
	return withEnv(windowId, undefined, fn);
}

function withTmux<T>(windowId: string | undefined, fn: () => T): T {
	return withEnv(windowId, '/tmp/tmux-1000/default,1234,0', fn);
}

test('handleNotify calls notify-send with summary', async t => {
	const execa = createExecaStub();

	await withWindowId(undefined, async () => handleNotify({ type: 'notify', summary: 'Hello' }, execa));

	t.is(execa.callCount, 1);
	t.is(execa.firstCall.args[0], 'notify-send');
	t.deepEqual(execa.firstCall.args[1], [ '--app-name', 'claudex', 'Hello' ]);
});

test('handleNotify includes body when provided', async t => {
	const execa = createExecaStub();

	await withWindowId(undefined, async () => handleNotify({ type: 'notify', summary: 'Title', body: 'Details' }, execa));

	t.is(execa.callCount, 1);
	t.deepEqual(execa.firstCall.args[1], [ '--app-name', 'claudex', 'Title', 'Details' ]);
});

test('handleNotify includes urgency when provided', async t => {
	const execa = createExecaStub();

	await withWindowId(undefined, async () => handleNotify({ type: 'notify', summary: 'Urgent', urgency: 'critical' }, execa));

	t.is(execa.callCount, 1);
	t.deepEqual(execa.firstCall.args[1], [ '--app-name', 'claudex', '-u', 'critical', 'Urgent' ]);
});

test('handleNotify adds --action when WINDOWID is set and window is not focused', async t => {
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>();
	// Xdotool getactivewindow returns a different window
	execa.withArgs('xdotool', [ 'getactivewindow' ]).resolves({ stdout: '99999' });
	execa.resolves({ stdout: '' });

	await withWindowId('12345', async () => handleNotify({ type: 'notify', summary: 'Hello' }, execa));
	// Let the fire-and-forget notifyAndFocus settle
	await new Promise(resolve => {
		setTimeout(resolve, 0);
	});

	t.is(execa.callCount, 2);
	t.is(execa.firstCall.args[0], 'xdotool');
	t.is(execa.secondCall.args[0], 'notify-send');
	t.deepEqual(execa.secondCall.args[1], [ '--app-name', 'claudex', '--action', 'default=Focus', 'Hello' ]);
	t.truthy(execa.secondCall.args[2]?.cancelSignal);
});

test('handleNotify skips notification when window is already focused', async t => {
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>();
	execa.withArgs('xdotool', [ 'getactivewindow' ]).resolves({ stdout: '12345' });
	execa.resolves({ stdout: '' });

	await withWindowId('12345', async () => handleNotify({ type: 'notify', summary: 'Hello' }, execa));

	t.is(execa.callCount, 1);
	t.is(execa.firstCall.args[0], 'xdotool');
});

test.serial('handleNotify warns on notify-send failure without WINDOWID', async t => {
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>()
		.rejects(new Error('command not found'));
	const warn = sinon.stub(console, 'warn');

	try {
		await withWindowId(undefined, async () => handleNotify({ type: 'notify', summary: 'Hello' }, execa));
		t.true(warn.calledOnce);
		t.true((warn.firstCall.args[0] as string).includes('[claudex]'));
	} finally {
		warn.restore();
	}
});

test('notifyAndFocus calls xdotool when notify-send returns default', async t => {
	const execa = createExecaStub('default');

	await notifyAndFocus([ '--app-name', 'claudex', '--action', 'default=Focus', 'Hello' ], '12345', execa);

	t.is(execa.callCount, 2);
	t.is(execa.firstCall.args[0], 'notify-send');
	t.truthy(execa.firstCall.args[2]?.cancelSignal);
	t.is(execa.secondCall.args[0], 'xdotool');
	t.deepEqual(execa.secondCall.args[1], [ 'windowactivate', '12345' ]);
});

test('notifyAndFocus does not call xdotool when notification is dismissed', async t => {
	const execa = createExecaStub('');

	await notifyAndFocus([ '--app-name', 'claudex', '--action', 'default=Focus', 'Hello' ], '12345', execa);

	t.is(execa.callCount, 1);
	t.is(execa.firstCall.args[0], 'notify-send');
});

test.serial('notifyAndFocus silently handles canceled errors', async t => {
	const error = new Error('canceled');
	(error as unknown as Record<string, unknown>).isCanceled = true;
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>().rejects(error);
	const warn = sinon.stub(console, 'warn');

	try {
		await t.notThrowsAsync(async () => notifyAndFocus([ 'test' ], '12345', execa));
		t.true(warn.notCalled);
	} finally {
		warn.restore();
	}
});

test.serial('handleNotify resolves window via tmux client and walks parents', async t => {
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>();
	execa.withArgs('tmux', [ 'display', '-p', '#{client_pid}' ]).resolves({ stdout: '5000' });
	execa.withArgs('xdotool', [ 'search', '--pid', '5000' ]).resolves({ stdout: '' });
	execa.withArgs('xdotool', [ 'search', '--pid', '4000' ]).resolves({ stdout: '67890' });
	execa.withArgs('xdotool', [ 'getactivewindow' ]).resolves({ stdout: '99999' });
	execa.resolves({ stdout: '' });

	const readPpid = sinon.stub<Parameters<ReadPpidFn>, ReturnType<ReadPpidFn>>();
	readPpid.withArgs('5000').resolves('4000');

	await withTmux('11111', async () => handleNotify({ type: 'notify', summary: 'Hello' }, execa, readPpid));
	await new Promise(resolve => {
		setTimeout(resolve, 0);
	});

	const notifyCall = execa.getCalls().find(c => c.args[0] === 'notify-send');
	t.truthy(notifyCall);
	t.deepEqual(notifyCall?.args[1], [ '--app-name', 'claudex', '--action', 'default=Focus', 'Hello' ]);
	t.true(execa.calledWith('xdotool', [ 'search', '--pid', '5000' ]));
	t.true(execa.calledWith('xdotool', [ 'search', '--pid', '4000' ]));
	t.true(readPpid.calledOnceWith('5000'));
});

test.serial('handleNotify uses tmux client window directly when found on first try', async t => {
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>();
	execa.withArgs('tmux', [ 'display', '-p', '#{client_pid}' ]).resolves({ stdout: '5000' });
	execa.withArgs('xdotool', [ 'search', '--pid', '5000' ]).resolves({ stdout: '67890' });
	execa.withArgs('xdotool', [ 'getactivewindow' ]).resolves({ stdout: '67890' });
	execa.resolves({ stdout: '' });

	const readPpid = sinon.stub<Parameters<ReadPpidFn>, ReturnType<ReadPpidFn>>();

	await withTmux(undefined, async () => handleNotify({ type: 'notify', summary: 'Hello' }, execa, readPpid));

	const notifyCall = execa.getCalls().find(c => c.args[0] === 'notify-send');
	t.falsy(notifyCall);
	t.is(readPpid.callCount, 0);
});

test.serial('handleNotify falls back to env WINDOWID when tmux walk yields no window', async t => {
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>();
	execa.withArgs('tmux', [ 'display', '-p', '#{client_pid}' ]).resolves({ stdout: '5000' });
	execa.withArgs('xdotool', [ 'search', '--pid', sinon.match.any ]).resolves({ stdout: '' });
	execa.withArgs('xdotool', [ 'getactivewindow' ]).resolves({ stdout: '99999' });
	execa.resolves({ stdout: '' });

	const readPpid = sinon.stub<Parameters<ReadPpidFn>, ReturnType<ReadPpidFn>>().resolves(undefined);

	await withTmux('11111', async () => handleNotify({ type: 'notify', summary: 'Hello' }, execa, readPpid));
	await new Promise(resolve => {
		setTimeout(resolve, 0);
	});

	const notifyCall = execa.getCalls().find(c => c.args[0] === 'notify-send');
	t.truthy(notifyCall);
	t.deepEqual(notifyCall?.args[1], [ '--app-name', 'claudex', '--action', 'default=Focus', 'Hello' ]);
});

test.serial('notifyAndFocus logs debug on non-canceled errors', async t => {
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>()
		.rejects(new Error('command not found'));
	const debug = sinon.stub(console, 'debug');

	try {
		await notifyAndFocus([ 'test' ], '12345', execa);
		t.true(debug.calledOnce);
		t.true((debug.firstCall.args[0] as string).includes('[claudex]'));
	} finally {
		debug.restore();
	}
});
