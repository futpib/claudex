import {
	mkdtemp, rm, writeFile, mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'ava';
import { extractResumeSessionId, findSessionFilesInDirs } from './resume.js';

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
