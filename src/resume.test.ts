import {
	mkdtemp, rm, writeFile, mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	extractResumeSessionId,
	extractSessionArgLocation,
	findSessionFilesInDirs,
	findSessionIdsByPrefix,
	replaceSessionArgValue,
} from './resume.js';

const SAMPLE_ID = '0a7589e7-332b-4d15-84fe-1d1e32ddc3f6';
const OTHER_ID = '11111111-2222-3333-4444-555555555555';

async function createTemporaryDir(prefix: string) {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	return {
		dir,
		async [Symbol.asyncDispose]() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

async function createTranscript(projectsDir: string, projectKey: string, sessionId: string): Promise<string> {
	const dir = path.join(projectsDir, projectKey);
	await mkdir(dir, { recursive: true });
	const file = path.join(dir, `${sessionId}.jsonl`);
	await writeFile(file, '{"type":"user","message":{"content":"hi"}}\n');
	return file;
}

// --- extractResumeSessionId ---

test('extractResumeSessionId picks up --resume <id>', t => {
	t.is(extractResumeSessionId([ '--resume', SAMPLE_ID ]), SAMPLE_ID);
});

test('extractResumeSessionId picks up -r <id>', t => {
	t.is(extractResumeSessionId([ '-r', SAMPLE_ID ]), SAMPLE_ID);
});

test('extractResumeSessionId picks up --resume=<id>', t => {
	t.is(extractResumeSessionId([ `--resume=${SAMPLE_ID}` ]), SAMPLE_ID);
});

test('extractResumeSessionId returns undefined when --resume has no UUID-shaped value', t => {
	t.is(extractResumeSessionId([ '--resume' ]), undefined);
	t.is(extractResumeSessionId([ '--resume', 'not-a-uuid' ]), undefined);
});

test('extractResumeSessionId returns undefined when no resume flag is present', t => {
	t.is(extractResumeSessionId([ '-p', 'fix the tests' ]), undefined);
});

test('extractResumeSessionId returns the first valid id when multiple are present', t => {
	t.is(extractResumeSessionId([ '--resume', SAMPLE_ID, '--resume', OTHER_ID ]), SAMPLE_ID);
});

// --- findSessionFilesInDirs ---

test('findSessionFilesInDirs returns empty when given no dirs', async t => {
	t.deepEqual(await findSessionFilesInDirs(SAMPLE_ID, []), []);
});

test('findSessionFilesInDirs silently skips non-existent dirs', async t => {
	const missing = path.join(tmpdir(), 'claudex-resume-missing-' + Date.now());
	t.deepEqual(await findSessionFilesInDirs(SAMPLE_ID, [ missing ]), []);
});

test('findSessionFilesInDirs returns the single match', async t => {
	await using handle = await createTemporaryDir('claudex-resume-single-');
	const projectsDir = path.join(handle.dir, 'projects');
	const file = await createTranscript(projectsDir, '-home-foo', SAMPLE_ID);

	t.deepEqual(await findSessionFilesInDirs(SAMPLE_ID, [ projectsDir ]), [ file ]);
});

test('findSessionFilesInDirs ignores transcripts with a different id', async t => {
	await using handle = await createTemporaryDir('claudex-resume-noise-');
	const projectsDir = path.join(handle.dir, 'projects');
	await createTranscript(projectsDir, '-home-foo', OTHER_ID);

	t.deepEqual(await findSessionFilesInDirs(SAMPLE_ID, [ projectsDir ]), []);
});

test('findSessionFilesInDirs returns multiple matches within one dir', async t => {
	await using handle = await createTemporaryDir('claudex-resume-dup-one-');
	const projectsDir = path.join(handle.dir, 'projects');
	const fileA = await createTranscript(projectsDir, '-home-foo', SAMPLE_ID);
	const fileB = await createTranscript(projectsDir, '-home-bar', SAMPLE_ID);

	const matches = await findSessionFilesInDirs(SAMPLE_ID, [ projectsDir ]);
	t.deepEqual([ ...matches ].sort(), [ fileA, fileB ].sort());
});

test('findSessionFilesInDirs aggregates matches across multiple dirs', async t => {
	await using accountA = await createTemporaryDir('claudex-resume-acctA-');
	await using accountB = await createTemporaryDir('claudex-resume-acctB-');
	const projectsA = path.join(accountA.dir, 'projects');
	const projectsB = path.join(accountB.dir, 'projects');

	const fileA = await createTranscript(projectsA, '-home-archive', SAMPLE_ID);
	const fileB = await createTranscript(projectsB, '-home-archive', SAMPLE_ID);
	await createTranscript(projectsB, '-home-other', OTHER_ID);

	const matches = await findSessionFilesInDirs(SAMPLE_ID, [ projectsA, projectsB ]);
	t.deepEqual([ ...matches ].sort(), [ fileA, fileB ].sort());
});

// --- extractSessionArgLocation ---

test('extractSessionArgLocation picks up a prefix value (separate arg)', t => {
	const args = [ '--resume', '0a7589e7' ];
	t.deepEqual(extractSessionArgLocation(args), {
		value: '0a7589e7', argIndex: 1, inline: false, flag: '--resume',
	});
});

test('extractSessionArgLocation picks up a prefix value (inline)', t => {
	const args = [ '--resume=0a7589e7-332b' ];
	t.deepEqual(extractSessionArgLocation(args), {
		value: '0a7589e7-332b', argIndex: 0, inline: true, flag: '--resume',
	});
});

test('extractSessionArgLocation picks up -r prefix', t => {
	const args = [ '-r', '0a' ];
	t.deepEqual(extractSessionArgLocation(args), {
		value: '0a', argIndex: 1, inline: false, flag: '-r',
	});
});

test('extractSessionArgLocation picks up --session-id <prefix>', t => {
	const args = [ '--session-id', '0a7589e7' ];
	t.deepEqual(extractSessionArgLocation(args), {
		value: '0a7589e7', argIndex: 1, inline: false, flag: '--session-id',
	});
});

test('extractSessionArgLocation picks up --session-id=<prefix>', t => {
	const args = [ '--session-id=0a7589e7' ];
	t.deepEqual(extractSessionArgLocation(args), {
		value: '0a7589e7', argIndex: 0, inline: true, flag: '--session-id',
	});
});

test('extractSessionArgLocation rejects values longer than a UUID', t => {
	const tooLong = SAMPLE_ID + 'extra';
	t.is(extractSessionArgLocation([ '--resume', tooLong ]), undefined);
});

test('extractSessionArgLocation rejects non-hex values', t => {
	t.is(extractSessionArgLocation([ '--resume', 'not-a-uuid' ]), undefined);
});

test('extractSessionArgLocation rejects trailing dashes', t => {
	t.is(extractSessionArgLocation([ '--resume', '0a7589e7-' ]), undefined);
});

test('extractSessionArgLocation returns undefined when --resume has no value', t => {
	t.is(extractSessionArgLocation([ '--resume' ]), undefined);
});

test('extractSessionArgLocation picks the first session-id-shaped flag among many', t => {
	const args = [ '-p', 'fix', '--session-id', '0a7589e7', '--resume', SAMPLE_ID ];
	const location = extractSessionArgLocation(args);
	t.is(location?.flag, '--session-id');
	t.is(location?.value, '0a7589e7');
});

// --- replaceSessionArgValue ---

test('replaceSessionArgValue replaces a separate-arg value', t => {
	const args = [ '--resume', '0a7589e7', '-p', 'fix' ];
	const location = extractSessionArgLocation(args)!;
	replaceSessionArgValue(args, location, SAMPLE_ID);
	t.deepEqual(args, [ '--resume', SAMPLE_ID, '-p', 'fix' ]);
});

test('replaceSessionArgValue replaces an inline value (always normalizes to --resume= form)', t => {
	const args = [ '--resume=0a7589e7' ];
	const location = extractSessionArgLocation(args)!;
	replaceSessionArgValue(args, location, SAMPLE_ID);
	t.deepEqual(args, [ `--resume=${SAMPLE_ID}` ]);
});

test('replaceSessionArgValue replaces -r value', t => {
	const args = [ '-r', '0a7589e7' ];
	const location = extractSessionArgLocation(args)!;
	replaceSessionArgValue(args, location, SAMPLE_ID);
	t.deepEqual(args, [ '-r', SAMPLE_ID ]);
});

test('replaceSessionArgValue replaces --session-id inline value preserving the flag', t => {
	const args = [ '--session-id=0a7589e7' ];
	const location = extractSessionArgLocation(args)!;
	replaceSessionArgValue(args, location, SAMPLE_ID);
	t.deepEqual(args, [ `--session-id=${SAMPLE_ID}` ]);
});

// --- findSessionIdsByPrefix ---

test('findSessionIdsByPrefix returns empty when no matches', async t => {
	await using handle = await createTemporaryDir('claudex-resume-prefix-empty-');
	const projectsDir = path.join(handle.dir, 'projects');
	await createTranscript(projectsDir, '-home-foo', OTHER_ID);

	const ids = await findSessionIdsByPrefix('0a7589e7', [ projectsDir ]);
	t.is(ids.size, 0);
});

test('findSessionIdsByPrefix returns the matching session id', async t => {
	await using handle = await createTemporaryDir('claudex-resume-prefix-one-');
	const projectsDir = path.join(handle.dir, 'projects');
	await createTranscript(projectsDir, '-home-foo', SAMPLE_ID);
	await createTranscript(projectsDir, '-home-bar', OTHER_ID);

	const ids = await findSessionIdsByPrefix('0a7589e7', [ projectsDir ]);
	t.deepEqual([ ...ids ], [ SAMPLE_ID ]);
});

test('findSessionIdsByPrefix is case-insensitive', async t => {
	await using handle = await createTemporaryDir('claudex-resume-prefix-case-');
	const projectsDir = path.join(handle.dir, 'projects');
	await createTranscript(projectsDir, '-home-foo', SAMPLE_ID);

	const ids = await findSessionIdsByPrefix('0A7589E7', [ projectsDir ]);
	t.deepEqual([ ...ids ], [ SAMPLE_ID ]);
});

test('findSessionIdsByPrefix returns all unique matches when prefix is ambiguous', async t => {
	await using handle = await createTemporaryDir('claudex-resume-prefix-many-');
	const projectsDir = path.join(handle.dir, 'projects');
	const idA = '0a000000-0000-0000-0000-000000000001';
	const idB = '0a000000-0000-0000-0000-000000000002';
	await createTranscript(projectsDir, '-home-foo', idA);
	await createTranscript(projectsDir, '-home-bar', idB);

	const ids = await findSessionIdsByPrefix('0a', [ projectsDir ]);
	t.deepEqual([ ...ids ].sort(), [ idA, idB ].sort());
});

test('findSessionIdsByPrefix dedupes when same id lives in multiple project dirs', async t => {
	await using handle = await createTemporaryDir('claudex-resume-prefix-dedupe-');
	const projectsDir = path.join(handle.dir, 'projects');
	await createTranscript(projectsDir, '-home-foo', SAMPLE_ID);
	await createTranscript(projectsDir, '-home-bar', SAMPLE_ID);

	const ids = await findSessionIdsByPrefix('0a7589e7', [ projectsDir ]);
	t.is(ids.size, 1);
});

test('findSessionIdsByPrefix ignores non-jsonl files and non-uuid filenames', async t => {
	await using handle = await createTemporaryDir('claudex-resume-prefix-noise-');
	const projectsDir = path.join(handle.dir, 'projects');
	const projectKey = '-home-foo';
	const dir = path.join(projectsDir, projectKey);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, '0a7589e7-not-a-uuid.jsonl'), '');
	await writeFile(path.join(dir, '0a7589e7.txt'), '');

	const ids = await findSessionIdsByPrefix('0a7589e7', [ projectsDir ]);
	t.is(ids.size, 0);
});
