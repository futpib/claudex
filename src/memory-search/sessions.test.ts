import test from 'ava';
import { getWorktreePaths } from './sessions.js';

test('getWorktreePaths - returns paths from git worktree list', async t => {
	const paths = await getWorktreePaths(process.cwd());
	t.true(Array.isArray(paths));
	t.true(paths.length >= 1);
	for (const p of paths) {
		t.true(p.startsWith('/'), `Expected absolute path, got: ${p}`);
	}
});

test('getWorktreePaths - falls back to cwd when not in a git repo', async t => {
	const paths = await getWorktreePaths('/tmp');
	t.deepEqual(paths, ['/tmp']);
});
