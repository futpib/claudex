import test from 'ava';
import sinon from 'sinon';
import { getContainerPrefix } from './docker/run.js';
import {
	findRunningContainer, filterContainerLines, containerNamePattern, type ExecaFn,
} from './index.js';

function createExecaStub(stdout = '') {
	return sinon.stub<Parameters<ExecaFn>, ReturnType<ExecaFn>>()
		.resolves({ stdout });
}

// --- getContainerPrefix ---

test('getContainerPrefix returns claudex-{basename}- for a simple path', t => {
	t.is(getContainerPrefix('/home/user/code/myproject'), 'claudex-myproject-');
});

test('getContainerPrefix uses only the last path component', t => {
	t.is(getContainerPrefix('/a/b/c/deep-project'), 'claudex-deep-project-');
});

// --- findRunningContainer with specificName ---

test('findRunningContainer returns the container when specificName matches', async t => {
	const execaStub = createExecaStub('claudex-iroh-abc123');
	const result = await findRunningContainer('/home/user/code/iroh', 'claudex-iroh-abc123', execaStub);
	t.is(result, 'claudex-iroh-abc123');
	t.deepEqual(execaStub.firstCall.args, [
		'docker',
		[ 'ps', '--filter', 'name=^claudex-iroh-abc123$', '--format', '{{.Names}}' ],
	]);
});

test('findRunningContainer throws when specificName is not running', async t => {
	const execaStub = createExecaStub('');
	const error = await t.throwsAsync(async () => findRunningContainer('/home/user/code/iroh', 'claudex-iroh-abc123', execaStub));
	t.is(error?.message, 'Container \'claudex-iroh-abc123\' is not running.');
});

// --- findRunningContainer auto-discovery ---

test('findRunningContainer returns the single matching container', async t => {
	const execaStub = createExecaStub('claudex-iroh-abc123\t2026-03-02 17:00:00 +0000 +00');
	const result = await findRunningContainer('/home/user/code/iroh', undefined, execaStub);
	t.is(result, 'claudex-iroh-abc123');
});

test('findRunningContainer uses prefix anchor in docker filter', async t => {
	const execaStub = createExecaStub('claudex-iroh-abc123\t2026-03-02 17:00:00 +0000 +00');
	await findRunningContainer('/home/user/code/iroh', undefined, execaStub);
	t.deepEqual(execaStub.firstCall.args, [
		'docker',
		[ 'ps', '--filter', 'name=^claudex-iroh-', '--format', '{{.Names}}\t{{.CreatedAt}}\t{{.Status}}' ],
	]);
});

test('findRunningContainer throws when no containers found', async t => {
	const execaStub = createExecaStub('');
	const error = await t.throwsAsync(async () => findRunningContainer('/home/user/code/iroh', undefined, execaStub));
	t.is(error?.message, 'No running claudex containers found for /home/user/code/iroh. Start one with: claudex');
});

test('findRunningContainer throws when multiple containers found', async t => {
	const execaStub = createExecaStub('claudex-iroh-abc123\t2026-03-02 17:00:00 +0000 +00\nclaudex-iroh-def456\t2026-03-02 16:00:00 +0000 +00');
	const error = await t.throwsAsync(async () => findRunningContainer('/home/user/code/iroh', undefined, execaStub));
	t.truthy(error?.message.includes('Multiple running claudex containers found for iroh'));
	t.truthy(error?.message.includes('claudex-iroh-abc123'));
	t.truthy(error?.message.includes('claudex-iroh-def456'));
	t.truthy(error?.message.includes('--container'));
	t.truthy(error?.message.includes('created '));
});

test('findRunningContainer does not match containers from similarly-named projects', async t => {
	// This is the key regression test: if cwd is "iroh", the prefix filter
	// should use ^claudex-iroh- so it won't match "claudex-iroh-ssh-android-..."
	// which belongs to a different project directory "iroh-ssh-android".
	// The docker filter itself enforces this via the ^ anchor; here we verify
	// the correct filter string is passed.
	const execaStub = createExecaStub('claudex-iroh-abc123\t2026-03-02 17:00:00 +0000 +00');
	await findRunningContainer('/home/user/code/iroh', undefined, execaStub);

	const filterArg = execaStub.firstCall.args[1][2];
	// Must start with ^ to anchor the match at the beginning of the name
	t.is(filterArg, 'name=^claudex-iroh-');
});

test('findRunningContainer excludes containers from project whose name starts with same prefix', async t => {
	// Docker returns both claudex-iroh-abc123 (project "iroh") and
	// claudex-iroh-ssh-abc123 (project "iroh-ssh") because docker's
	// name filter is a substring/prefix match. filterContainerLines
	// must reject the latter when cwd is "iroh".
	const execaStub = createExecaStub('claudex-iroh-abc123\t2026-03-02 17:00:00 +0000 +00\t Up 5 minutes\nclaudex-iroh-ssh-abc123\t2026-03-02 16:00:00 +0000 +00\tUp 10 minutes');
	const result = await findRunningContainer('/home/user/code/iroh', undefined, execaStub);
	t.is(result, 'claudex-iroh-abc123');
});

// --- filterContainerLines ---

test('filterContainerLines rejects names where remainder after prefix is not a 6-char suffix', t => {
	const lines = [
		'claudex-iroh-abc123\t2026-03-02 17:00:00 +0000 +00\tUp 5 minutes',
		'claudex-iroh-ssh-abc123\t2026-03-02 16:00:00 +0000 +00\tUp 10 minutes',
	];
	const result = filterContainerLines(lines, 'claudex-iroh-');
	t.is(result.length, 1);
	t.truthy(result[0].startsWith('claudex-iroh-abc123'));
});

// --- containerNamePattern ---

test('containerNamePattern matches containers from all projects', t => {
	const names = [
		'claudex-iroh-abc123',
		'claudex-iroh-ssh-def456',
		'claudex-myproject-ghi789',
	];
	for (const name of names) {
		t.true(containerNamePattern.test(name), `expected ${name} to match`);
	}
});

test('containerNamePattern rejects invalid container names', t => {
	t.false(containerNamePattern.test('claudex-abc123'));
	t.false(containerNamePattern.test('notclaudex-iroh-abc123'));
	t.false(containerNamePattern.test('claudex--abc123'));
});
