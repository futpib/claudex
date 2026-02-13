import process from 'node:process';
import test from 'ava';
import sinon from 'sinon';
import { handleNotify, notifyAndFocus, type ExecaFn } from './dispatch.js';

function createExecaStub(stdout = '') {
	return sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>()
		.resolves({ stdout });
}

function withWindowId<T>(windowId: string | undefined, fn: () => T): T {
	const saved = process.env.WINDOWID;
	if (windowId === undefined) {
		delete process.env.WINDOWID;
	} else {
		process.env.WINDOWID = windowId;
	}

	try {
		return fn();
	} finally {
		if (saved === undefined) {
			delete process.env.WINDOWID;
		} else {
			process.env.WINDOWID = saved;
		}
	}
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

test('handleNotify adds --action when WINDOWID is set', async t => {
	const execa = createExecaStub();

	await withWindowId('12345', async () => handleNotify({ type: 'notify', summary: 'Hello' }, execa));
	// Let the fire-and-forget notifyAndFocus settle
	await new Promise(resolve => {
		setTimeout(resolve, 0);
	});

	t.is(execa.callCount, 1);
	t.is(execa.firstCall.args[0], 'notify-send');
	t.deepEqual(execa.firstCall.args[1], [ '--app-name', 'claudex', '--action', 'default=Focus', 'Hello' ]);
	t.truthy(execa.firstCall.args[2]?.cancelSignal);
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

test.serial('notifyAndFocus warns on non-canceled errors', async t => {
	const execa = sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>()
		.rejects(new Error('command not found'));
	const warn = sinon.stub(console, 'warn');

	try {
		await notifyAndFocus([ 'test' ], '12345', execa);
		t.true(warn.calledOnce);
		t.true((warn.firstCall.args[0] as string).includes('[claudex]'));
	} finally {
		warn.restore();
	}
});
