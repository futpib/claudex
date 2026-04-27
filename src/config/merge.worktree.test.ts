import {
	mkdtemp, rm, writeFile, mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import test from 'ava';
import { execa } from 'execa';

// Resolves to build/config/index.js after ava-typescript rewrites src/ → build/.
// We import getMergedConfig from a child process so we can override paths.config
// by setting XDG_CONFIG_HOME in the child's environment. paths.config is
// captured at module load time, so it cannot be overridden in-process.
const builtConfigIndexUrl = pathToFileURL(path.join(import.meta.dirname, 'index.js')).href;

async function createTemporaryDir(prefix: string) {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	return {
		dir,
		async [Symbol.asyncDispose]() {
			await rm(dir, { recursive: true, force: true });
		},
	};
}

async function probeMergedVolumeHostPaths(configDir: string, cwd: string): Promise<string[]> {
	const probe = `
		import { getMergedConfig } from ${JSON.stringify(builtConfigIndexUrl)};
		const { config } = await getMergedConfig(${JSON.stringify(cwd)});
		const hostPaths = (config.volumes ?? []).map(v => typeof v === 'string' ? v : v.host);
		process.stdout.write(JSON.stringify(hostPaths));
	`;
	const result = await execa('node', [ '--input-type=module', '-e', probe ], {
		env: {
			...process.env,
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: configDir,
		},
	});
	return JSON.parse(String(result.stdout)) as string[];
}

async function initGitRepo(dir: string): Promise<void> {
	await execa('git', [ 'init' ], { cwd: dir });
	await execa('git', [ 'config', 'user.email', 'test@test.com' ], { cwd: dir });
	await execa('git', [ 'config', 'user.name', 'Test' ], { cwd: dir });
	await writeFile(path.join(dir, 'README.md'), '# Test');
	await execa('git', [ 'add', '.' ], { cwd: dir });
	await execa('git', [ 'commit', '-m', 'Initial commit' ], { cwd: dir });
}

test('getMergedConfig from a git worktree auto-shares group sibling volumes', async t => {
	await using configHandle = await createTemporaryDir('claudex-mergewt-cfg-');
	await using repo = await createTemporaryDir('claudex-mergewt-repo-');
	await using sibling = await createTemporaryDir('claudex-mergewt-sib-');

	const claudexConfigDir = path.join(configHandle.dir, 'claudex');
	await mkdir(claudexConfigDir, { recursive: true });

	await initGitRepo(repo.dir);

	const worktreeDir = repo.dir + '.worktree';
	await execa('git', [ 'worktree', 'add', worktreeDir, '-b', 'wt' ], { cwd: repo.dir });

	// Two projects in the same group. With shareVolumes defaulting to true,
	// resolving from either project should auto-share the other as a volume.
	await writeFile(
		path.join(claudexConfigDir, 'config.json'),
		JSON.stringify({
			groupDefinitions: { archive: {} },
			projects: {
				[repo.dir]: { group: 'archive' },
				[sibling.dir]: { group: 'archive' },
			},
		}),
	);

	try {
		// Sanity check: from the parent repo itself the sibling IS auto-shared.
		const fromParent = await probeMergedVolumeHostPaths(configHandle.dir, repo.dir);
		t.true(
			fromParent.includes(sibling.dir),
			`baseline: expected sibling ${sibling.dir} when resolving from parent repo; got ${JSON.stringify(fromParent)}`,
		);

		// Reproduces the bug: resolving from a worktree of the parent should
		// produce the same auto-shared sibling, but currently it does not.
		const fromWorktree = await probeMergedVolumeHostPaths(configHandle.dir, worktreeDir);
		t.true(
			fromWorktree.includes(sibling.dir),
			`expected sibling ${sibling.dir} to be auto-shared from worktree resolution; got ${JSON.stringify(fromWorktree)}`,
		);
	} finally {
		await rm(worktreeDir, { recursive: true, force: true });
	}
});
