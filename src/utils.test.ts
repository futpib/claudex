import test from 'ava';
import { findSubsumingPaths } from './utils.js';

test('findSubsumingPaths returns no entries when paths are independent', t => {
	const result = findSubsumingPaths([ '/home/u/a', '/home/u/b', '/etc/hosts' ]);
	t.deepEqual(result, []);
});

test('findSubsumingPaths flags ancestor that contains a descendant', t => {
	const result = findSubsumingPaths([ '/home/u/code', '/home/u/code/archive' ]);
	t.deepEqual(result, [ { ancestor: '/home/u/code', descendants: [ '/home/u/code/archive' ] } ]);
});

test('findSubsumingPaths groups multiple descendants under one ancestor', t => {
	const result = findSubsumingPaths([ '/home/u/code', '/home/u/code/a', '/home/u/code/b', '/home/u/other' ]);
	t.deepEqual(result, [ { ancestor: '/home/u/code', descendants: [ '/home/u/code/a', '/home/u/code/b' ] } ]);
});

test('findSubsumingPaths normalizes trailing slashes before comparing', t => {
	const result = findSubsumingPaths([ '/home/u/code/', '/home/u/code/archive' ]);
	t.deepEqual(result, [ { ancestor: '/home/u/code', descendants: [ '/home/u/code/archive' ] } ]);
});

test('findSubsumingPaths does not treat a sibling prefix as ancestor', t => {
	const result = findSubsumingPaths([ '/home/u/code', '/home/u/codex' ]);
	t.deepEqual(result, []);
});

test('findSubsumingPaths handles root', t => {
	const result = findSubsumingPaths([ '/', '/home/u' ]);
	t.deepEqual(result, [ { ancestor: '/', descendants: [ '/home/u' ] } ]);
});

test('findSubsumingPaths dedupes input before comparing', t => {
	const result = findSubsumingPaths([ '/a', '/a', '/a/b' ]);
	t.deepEqual(result, [ { ancestor: '/a', descendants: [ '/a/b' ] } ]);
});
