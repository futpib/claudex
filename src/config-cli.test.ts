import {
	mkdtemp, rm, readFile, writeFile, mkdir, realpath,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'ava';
import { execa } from 'execa';

const cliPath = path.join(import.meta.dirname, '../build/cli.js');

type CliResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

async function runConfig(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<CliResult> {
	const result = await execa('node', [ cliPath, 'config', ...args ], {
		cwd: options.cwd ?? process.cwd(),
		reject: false,
		env: {
			...process.env,
			...options.env,
		},
	});
	return {
		exitCode: result.exitCode ?? 0,
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}

async function createTemporaryConfigDir(): Promise<{ configDir: string; cleanup: () => Promise<void> }> {
	const configDir = await mkdtemp(path.join(tmpdir(), 'claudex-config-test-'));
	return {
		configDir,
		async cleanup() {
			await rm(configDir, { recursive: true });
		},
	};
}

async function readJsonFile(filePath: string): Promise<unknown> {
	const content = await readFile(filePath, 'utf8');
	return JSON.parse(content);
}

// Helper to run config commands with a custom config dir
async function runConfigWithDir(configDir: string, args: string[], cwd?: string): Promise<CliResult> {
	return runConfig(args, {
		cwd,
		env: {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			XDG_CONFIG_HOME: configDir,
		},
	});
}

test('add appends to packages array', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'vim' ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { packages: string[] }).packages, [ 'vim' ]);

		// Add another
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'curl' ]);
		const config2 = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config2 as { packages: string[] }).packages, [ 'vim', 'curl' ]);
	} finally {
		await cleanup();
	}
});

test('add appends to volumes array', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'volumes', '/tmp/vol1' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { volumes: string[] }).volumes, [ '/tmp/vol1' ]);
	} finally {
		await cleanup();
	}
});

test('add appends to hostPorts with number coercion', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'hostPorts', '8443' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { hostPorts: number[] }).hostPorts, [ 8443 ]);

		await runConfigWithDir(configDir, [ 'add', '--global', 'hostPorts', '2222' ]);
		const config2 = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config2 as { hostPorts: number[] }).hostPorts, [ 8443, 2222 ]);
	} finally {
		await cleanup();
	}
});

test('add appends to ssh.keys', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'ssh.keys', '~/.ssh/id_ed25519' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { ssh: { keys: string[] } }).ssh.keys, [ '~/.ssh/id_ed25519' ]);
	} finally {
		await cleanup();
	}
});

test('add appends to ssh.hosts', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'ssh.hosts', 'github.com' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { ssh: { hosts: string[] } }).ssh.hosts, [ 'github.com' ]);
	} finally {
		await cleanup();
	}
});

test('set scalar field (settingSources)', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'settingSources', 'user' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { settingSources: string }).settingSources, 'user');
	} finally {
		await cleanup();
	}
});

test('set boolean field (shareVolumes)', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'shareVolumes', 'false' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { shareVolumes: boolean }).shareVolumes, false);
	} finally {
		await cleanup();
	}
});

test('set record field (env.KEY)', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		// eslint-disable-next-line no-template-curly-in-string
		const templateString = '${API_KEY}';
		await runConfigWithDir(configDir, [ 'set', '--global', 'env.API_KEY', templateString ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { env: Record<string, string> }).env.API_KEY, templateString);
	} finally {
		await cleanup();
	}
});

test('set record field (extraHosts.HOST)', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'extraHosts.gitlab.example.com', '127.0.0.1' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { extraHosts: Record<string, string> }).extraHosts['gitlab.example.com'], '127.0.0.1');
	} finally {
		await cleanup();
	}
});

test('unset removes scalar field', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'settingSources', 'user' ]);
		await runConfigWithDir(configDir, [ 'unset', '--global', 'settingSources' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { settingSources?: string }).settingSources, undefined);
	} finally {
		await cleanup();
	}
});

test('unset removes specific value from array', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'vim' ]);
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'curl' ]);
		await runConfigWithDir(configDir, [ 'unset', '--global', 'packages', 'vim' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { packages: string[] }).packages, [ 'curl' ]);
	} finally {
		await cleanup();
	}
});

test('unset removes specific number from hostPorts', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'hostPorts', '8443' ]);
		await runConfigWithDir(configDir, [ 'add', '--global', 'hostPorts', '2222' ]);
		await runConfigWithDir(configDir, [ 'unset', '--global', 'hostPorts', '8443' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { hostPorts: number[] }).hostPorts, [ 2222 ]);
	} finally {
		await cleanup();
	}
});

test('unset removes record sub-key', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'env.FOO', 'bar' ]);
		await runConfigWithDir(configDir, [ 'set', '--global', 'env.BAZ', 'qux' ]);
		await runConfigWithDir(configDir, [ 'unset', '--global', 'env.FOO' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		// eslint-disable-next-line @typescript-eslint/naming-convention
		t.deepEqual((config as { env: Record<string, string> }).env, { BAZ: 'qux' });
	} finally {
		await cleanup();
	}
});

test('unset removes last array value and cleans up field', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'vim' ]);
		await runConfigWithDir(configDir, [ 'unset', '--global', 'packages', 'vim' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { packages?: string[] }).packages, undefined);
	} finally {
		await cleanup();
	}
});

test('project scope writes to correct file', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const projectPath = '/home/user/code/myproject';

		// First write creates in config.json
		await runConfigWithDir(configDir, [ 'add', '--project', projectPath, 'packages', 'vim' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual(
			(config as { projects: Record<string, { packages: string[] }> }).projects[projectPath].packages,
			[ 'vim' ],
		);

		// Second write finds the same file
		await runConfigWithDir(configDir, [ 'add', '--project', projectPath, 'packages', 'curl' ]);
		const config2 = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual(
			(config2 as { projects: Record<string, { packages: string[] }> }).projects[projectPath].packages,
			[ 'vim', 'curl' ],
		);
	} finally {
		await cleanup();
	}
});

test('group scope writes to correct file', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--group', 'mygroup', 'settingSources', 'user' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is(
			(config as { groups: Record<string, { settingSources: string }> }).groups.mygroup.settingSources,
			'user',
		);
	} finally {
		await cleanup();
	}
});

test('--file writes to specific file in config.json.d', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const configJsonDirectory = path.join(configDir, 'claudex', 'config.json.d');
		await mkdir(configJsonDirectory, { recursive: true });

		await runConfigWithDir(configDir, [ 'add', '--global', '--file', 'config.json.d/99-private.json', 'packages', 'vim' ]);
		const config = await readJsonFile(path.join(configJsonDirectory, '99-private.json'));
		t.deepEqual((config as { packages: string[] }).packages, [ 'vim' ]);
	} finally {
		await cleanup();
	}
});

test('ambiguous project file errors', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const claudexDir = path.join(configDir, 'claudex');
		const configJsonDirectory = path.join(claudexDir, 'config.json.d');
		await mkdir(configJsonDirectory, { recursive: true });

		const projectPath = '/home/user/code/myproject';

		// Write project to config.json
		await writeFile(
			path.join(claudexDir, 'config.json'),
			JSON.stringify({ projects: { [projectPath]: { packages: [ 'vim' ] } } }),
		);

		// Write same project to another file
		await writeFile(
			path.join(configJsonDirectory, '01-extra.json'),
			JSON.stringify({ projects: { [projectPath]: { packages: [ 'curl' ] } } }),
		);

		const result = await runConfigWithDir(configDir, [ 'add', '--project', projectPath, 'packages', 'git' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('multiple config files'));
	} finally {
		await cleanup();
	}
});

test('get reads value', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'settingSources', 'user,local' ]);
		const result = await runConfigWithDir(configDir, [ 'get', '--global', 'settingSources' ]);
		t.is(result.exitCode, 0);
		t.is(result.stdout.trim(), 'user,local');
	} finally {
		await cleanup();
	}
});

test('get reads array value as JSON', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'hostPorts', '2222' ]);
		await runConfigWithDir(configDir, [ 'add', '--global', 'hostPorts', '8443' ]);
		const result = await runConfigWithDir(configDir, [ 'get', '--global', 'hostPorts' ]);
		t.is(result.exitCode, 0);
		t.deepEqual(JSON.parse(result.stdout), [ 2222, 8443 ]);
	} finally {
		await cleanup();
	}
});

test('get reads record sub-key', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'env.MY_VAR', 'hello' ]);
		const result = await runConfigWithDir(configDir, [ 'get', '--global', 'env.MY_VAR' ]);
		t.is(result.exitCode, 0);
		t.is(result.stdout.trim(), 'hello');
	} finally {
		await cleanup();
	}
});

test('list outputs config as JSON', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'settingSources', 'user' ]);
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'vim' ]);
		const result = await runConfigWithDir(configDir, [ 'list', '--global' ]);
		t.is(result.exitCode, 0);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const parsed = JSON.parse(result.stdout);
		t.is(parsed.settingSources, 'user');
		t.deepEqual(parsed.packages, [ 'vim' ]);
	} finally {
		await cleanup();
	}
});

test('set group field with --group', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--group', 'dev', 'extraHosts.myhost', '10.0.0.1' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is(
			(config as { groups: Record<string, { extraHosts: Record<string, string> }> }).groups.dev.extraHosts.myhost,
			'10.0.0.1',
		);
	} finally {
		await cleanup();
	}
});

test('set project group field', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const projectPath = '/home/user/code/myproject';
		await runConfigWithDir(configDir, [ 'set', '--project', projectPath, 'group', 'dev' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is(
			(config as { projects: Record<string, { group: string }> }).projects[projectPath].group,
			'dev',
		);
	} finally {
		await cleanup();
	}
});

test('error on missing action', async t => {
	const result = await runConfig([]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('Missing action'));
});

test('error on unknown action', async t => {
	const result = await runConfig([ 'badaction' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('Unknown action'));
});

test('error on set without value', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'settingSources' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('requires a value'));
	} finally {
		await cleanup();
	}
});

test('error on invalid hostPort', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'add', '--global', 'hostPorts', 'notanumber' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('Invalid port number'));
	} finally {
		await cleanup();
	}
});

test('error on invalid shareVolumes value', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'shareVolumes', 'maybe' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('Invalid boolean'));
	} finally {
		await cleanup();
	}
});

test('add volumes stores tilde path without expanding', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'volumes', '~/code/parser' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { volumes: string[] }).volumes, [ '~/code/parser' ]);
	} finally {
		await cleanup();
	}
});

test('implicit project scope uses tilde path as project key', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const claudexDir = path.join(configDir, 'claudex');
	const configDDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configDDir, { recursive: true });

	// Create a temporary project directory to use as cwd
	const projectDir = await mkdtemp(path.join(tmpdir(), 'claudex-project-'));

	// Pre-create a config file with a project using the absolute path
	await writeFile(
		path.join(configDDir, '99-private.json'),
		JSON.stringify({ projects: { [projectDir]: { packages: [ 'git' ] } } }),
	);

	try {
		// Run from the project directory without --project flag
		const result = await runConfigWithDir(configDir, [ 'add', 'volumes', '~/code/parser' ], projectDir);
		t.is(result.exitCode, 0);

		// Should write to the file where the project is defined (99-private.json),
		// not to config.json
		const config = await readJsonFile(path.join(configDDir, '99-private.json'));
		const projects = (config as { projects: Record<string, { volumes?: string[] }> }).projects;
		t.deepEqual(projects[projectDir].volumes, [ '~/code/parser' ]);
	} finally {
		await rm(projectDir, { recursive: true });
		await cleanup();
	}
});

test('implicit scope from git worktree resolves to parent repo project', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const claudexDir = path.join(configDir, 'claudex');
	const configDDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configDDir, { recursive: true });

	// Create a git repo and a worktree
	const repoDir = await mkdtemp(path.join(tmpdir(), 'claudex-repo-'));
	await execa('git', [ 'init' ], { cwd: repoDir });
	await execa('git', [ 'config', 'user.email', 'test@test.com' ], { cwd: repoDir });
	await execa('git', [ 'config', 'user.name', 'Test' ], { cwd: repoDir });
	await writeFile(path.join(repoDir, 'README.md'), '# Test');
	await execa('git', [ 'add', '.' ], { cwd: repoDir });
	await execa('git', [ 'commit', '-m', 'Initial commit' ], { cwd: repoDir });

	const worktreeDir = repoDir + '.worktree';
	await execa('git', [ 'worktree', 'add', worktreeDir, '-b', 'worktree-branch' ], { cwd: repoDir });

	// Pre-create a config file with the main repo as a project
	await writeFile(
		path.join(configDDir, '99-private.json'),
		JSON.stringify({ projects: { [repoDir]: { packages: [ 'git' ] } } }),
	);

	try {
		// Run from the worktree directory without --project flag
		const result = await runConfigWithDir(configDir, [ 'add', 'packages', 'zig' ], worktreeDir);
		t.is(result.exitCode, 0);

		// Should write to the parent repo's project entry, not create a new one
		const config = await readJsonFile(path.join(configDDir, '99-private.json'));
		const projects = (config as { projects: Record<string, { packages?: string[] }> }).projects;
		t.deepEqual(projects[repoDir].packages, [ 'git', 'zig' ]);

		// config.json should not exist (nothing should have been written there)
		try {
			await readJsonFile(path.join(claudexDir, 'config.json'));
			t.fail('config.json should not have been created');
		} catch {
			t.pass('config.json correctly does not exist');
		}
	} finally {
		await rm(worktreeDir, { recursive: true });
		await rm(repoDir, { recursive: true });
		await cleanup();
	}
});

test('implicit scope from cwd under home directory uses tilde in project key', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const claudexDir = path.join(configDir, 'claudex');

	const home = homedir();
	const realHome = await realpath(home);
	// Use a real subdirectory under $HOME as cwd
	const projectDir = await mkdtemp(path.join(home, '.claudex-test-project-'));
	const realProjectDir = await realpath(projectDir);
	const expectedTildePath = '~' + realProjectDir.slice(realHome.length);

	try {
		const result = await runConfigWithDir(configDir, [ 'add', 'packages', 'vim' ], projectDir);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(claudexDir, 'config.json'));
		const projects = (config as { projects?: Record<string, unknown> }).projects ?? {};
		const projectKeys = Object.keys(projects);

		t.log('homedir:', home);
		t.log('realHome:', realHome);
		t.log('projectDir:', projectDir);
		t.log('realProjectDir:', realProjectDir);
		t.log('expectedTildePath:', expectedTildePath);
		t.log('projectKeys:', projectKeys);

		// Should use tilde path as key, not absolute path
		t.truthy(projects[expectedTildePath], `expected project key ${expectedTildePath}`);
		t.is(projects[projectDir], undefined, `should not have absolute path key ${projectDir}`);
	} finally {
		await rm(projectDir, { recursive: true });
		await cleanup();
	}
});

test('implicit scope from git worktree creates project under parent repo path', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const claudexDir = path.join(configDir, 'claudex');

	// Create a git repo and a worktree
	const repoDir = await mkdtemp(path.join(tmpdir(), 'claudex-repo-'));
	await execa('git', [ 'init' ], { cwd: repoDir });
	await execa('git', [ 'config', 'user.email', 'test@test.com' ], { cwd: repoDir });
	await execa('git', [ 'config', 'user.name', 'Test' ], { cwd: repoDir });
	await writeFile(path.join(repoDir, 'README.md'), '# Test');
	await execa('git', [ 'add', '.' ], { cwd: repoDir });
	await execa('git', [ 'commit', '-m', 'Initial commit' ], { cwd: repoDir });

	const worktreeDir = repoDir + '.worktree';
	await execa('git', [ 'worktree', 'add', worktreeDir, '-b', 'worktree-branch' ], { cwd: repoDir });

	try {
		// Run from the worktree directory without --project flag
		// No existing project entry for the parent repo
		const result = await runConfigWithDir(configDir, [ 'add', 'packages', 'zig' ], worktreeDir);
		t.is(result.exitCode, 0);

		// Should create project under the parent repo path, not the worktree path
		const config = await readJsonFile(path.join(claudexDir, 'config.json'));
		const projects = (config as { projects?: Record<string, unknown> }).projects ?? {};
		t.deepEqual((projects[repoDir] as { packages?: string[] })?.packages, [ 'zig' ]);

		// Should NOT have an entry for the worktree path
		t.is(projects[worktreeDir], undefined);
	} finally {
		await rm(worktreeDir, { recursive: true });
		await rm(repoDir, { recursive: true });
		await cleanup();
	}
});

test('add to project defined with tilde path writes to correct config file', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const claudexDir = path.join(configDir, 'claudex');
	const configDDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configDDir, { recursive: true });

	// Pre-create a config file with a project using tilde path
	await writeFile(
		path.join(configDDir, '99-private.json'),
		JSON.stringify({ projects: { '~/code/lix': { packages: [ 'git' ] } } }),
	);

	try {
		// Use --project with tilde path
		const result = await runConfigWithDir(configDir, [ 'add', '--project', '~/code/lix', 'volumes', '~/code/parser' ]);
		t.is(result.exitCode, 0);

		// Should write to 99-private.json where the project is defined
		const config = await readJsonFile(path.join(configDDir, '99-private.json'));
		const projects = (config as { projects: Record<string, { volumes?: string[] }> }).projects;
		t.deepEqual(projects['~/code/lix'].volumes, [ '~/code/parser' ]);

		// config.json should not exist (nothing should have been written there)
		try {
			await readJsonFile(path.join(claudexDir, 'config.json'));
			t.fail('config.json should not have been created');
		} catch {
			t.pass('config.json correctly does not exist');
		}
	} finally {
		await cleanup();
	}
});
