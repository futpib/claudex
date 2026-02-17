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

test('add appends multiple values at once', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'cmake', 'ninja', 'vim' ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { packages: string[] }).packages, [ 'cmake', 'ninja', 'vim' ]);
	} finally {
		await cleanup();
	}
});

test('add multiple values skips duplicates', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'vim' ]);
		const result = await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'curl', 'vim', 'git' ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { packages: string[] }).packages, [ 'vim', 'curl', 'git' ]);
	} finally {
		await cleanup();
	}
});

test('add does not duplicate existing package', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'zig' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { packages: string[] }).packages, [ 'zig' ]);

		// Add the same package again
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'zig' ]);
		const config2 = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config2 as { packages: string[] }).packages, [ 'zig' ]);
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
	// Commander shows help on missing subcommand (exit 0)
	// or configMain throws (exit 1). Either way, output should mention actions.
	const output = result.stdout + result.stderr;
	t.true(output.includes('list'), 'should mention available actions');
});

test('error on unknown action', async t => {
	const result = await runConfig([ 'badaction' ]);
	t.not(result.exitCode, 0);
});

test('error on set without value', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'settingSources' ]);
		t.not(result.exitCode, 0);
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

test('add volumes collapses shell-expanded home path to tilde', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const expandedPath = homedir() + '/Downloads/foo';
		await runConfigWithDir(configDir, [ 'add', '--global', 'volumes', expandedPath ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { volumes: string[] }).volumes, [ '~/Downloads/foo' ]);
	} finally {
		await cleanup();
	}
});

test('remove volumes matches shell-expanded path against tilde-stored value', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		// Add with tilde notation
		await runConfigWithDir(configDir, [ 'add', '--global', 'volumes', '~/Downloads/foo' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { volumes: string[] }).volumes, [ '~/Downloads/foo' ]);

		// Remove with shell-expanded path (simulating what the shell does to ~/Downloads/foo)
		const expandedPath = homedir() + '/Downloads/foo';
		await runConfigWithDir(configDir, [ 'remove', '--global', 'volumes', expandedPath ]);
		const config2 = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config2 as { volumes?: string[] }).volumes, undefined);
	} finally {
		await cleanup();
	}
});

test('remove volumes matches expanded path against expanded-stored value', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		// Manually write a config with an expanded path (simulating legacy or hand-edited config)
		const claudexDir = path.join(configDir, 'claudex');
		await mkdir(claudexDir, { recursive: true });
		const expandedPath = homedir() + '/Downloads/foo';
		await writeFile(
			path.join(claudexDir, 'config.json'),
			JSON.stringify({ volumes: [ expandedPath ] }),
		);

		// Remove with the same expanded path
		const result = await runConfigWithDir(configDir, [ 'remove', '--global', 'volumes', expandedPath ]);
		t.is(result.exitCode, 0);
		const config = await readJsonFile(path.join(claudexDir, 'config.json'));
		t.is((config as { volumes?: string[] }).volumes, undefined);
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
	const configFragmentsDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configFragmentsDir, { recursive: true });

	// Create a temporary project directory to use as cwd
	const projectDir = await mkdtemp(path.join(tmpdir(), 'claudex-project-'));

	// Pre-create a config file with a project using the absolute path
	await writeFile(
		path.join(configFragmentsDir, '99-private.json'),
		JSON.stringify({ projects: { [projectDir]: { packages: [ 'git' ] } } }),
	);

	try {
		// Run from the project directory without --project flag
		const result = await runConfigWithDir(configDir, [ 'add', 'volumes', '~/code/parser' ], projectDir);
		t.is(result.exitCode, 0);

		// Should write to the file where the project is defined (99-private.json),
		// not to config.json
		const config = await readJsonFile(path.join(configFragmentsDir, '99-private.json'));
		const { projects } = (config as { projects: Record<string, { volumes?: string[] }> });
		t.deepEqual(projects[projectDir].volumes, [ '~/code/parser' ]);
	} finally {
		await rm(projectDir, { recursive: true });
		await cleanup();
	}
});

test('implicit scope from git worktree resolves to parent repo project', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const claudexDir = path.join(configDir, 'claudex');
	const configFragmentsDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configFragmentsDir, { recursive: true });

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
		path.join(configFragmentsDir, '99-private.json'),
		JSON.stringify({ projects: { [repoDir]: { packages: [ 'git' ] } } }),
	);

	try {
		// Run from the worktree directory without --project flag
		const result = await runConfigWithDir(configDir, [ 'add', 'packages', 'zig' ], worktreeDir);
		t.is(result.exitCode, 0);

		// Should write to the parent repo's project entry, not create a new one
		const config = await readJsonFile(path.join(configFragmentsDir, '99-private.json'));
		const { projects } = (config as { projects: Record<string, { packages?: string[] }> });
		t.deepEqual(projects[repoDir].packages, [ 'git', 'zig' ]);

		// Config.json should not exist (nothing should have been written there)
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

test('add outputs diff to stderr, duplicate add produces no diff', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'git' ]);
		t.is(result.exitCode, 0);
		t.true(result.stderr.includes('+'), 'first add should have added lines in stderr');
		t.true(result.stderr.includes('git'), 'first add should mention the added value');
		t.true(result.stderr.includes('@@'), 'first add should have unified diff hunk header');

		// Adding the same value again should produce no diff but show a message
		const result2 = await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'git' ]);
		t.is(result2.exitCode, 0);
		t.false(result2.stderr.includes('@@'), 'duplicate add should not have unified diff hunk header');
		t.true(result2.stderr.includes('already contains git'), 'duplicate add should mention that the value already exists');
	} finally {
		await cleanup();
	}
});

test('remove removes value from array', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'vim' ]);
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'curl' ]);
		await runConfigWithDir(configDir, [ 'remove', '--global', 'packages', 'vim' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { packages: string[] }).packages, [ 'curl' ]);
	} finally {
		await cleanup();
	}
});

test('remove with dot notation removes value from array', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'vim' ]);
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'curl' ]);
		await runConfigWithDir(configDir, [ 'remove', '--global', 'packages.vim' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { packages: string[] }).packages, [ 'curl' ]);
	} finally {
		await cleanup();
	}
});

test('remove from nested array (ssh.keys)', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'ssh.keys', '~/.ssh/id_ed25519' ]);
		await runConfigWithDir(configDir, [ 'add', '--global', 'ssh.keys', '~/.ssh/id_rsa' ]);
		await runConfigWithDir(configDir, [ 'remove', '--global', 'ssh.keys', '~/.ssh/id_ed25519' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual((config as { ssh: { keys: string[] } }).ssh.keys, [ '~/.ssh/id_rsa' ]);
	} finally {
		await cleanup();
	}
});

test('remove sub-key from record with field+value syntax (env FOO)', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'env.FOO', 'bar' ]);
		await runConfigWithDir(configDir, [ 'set', '--global', 'env.BAZ', 'qux' ]);
		await runConfigWithDir(configDir, [ 'remove', '--global', 'env', 'FOO' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		// eslint-disable-next-line @typescript-eslint/naming-convention
		t.deepEqual((config as { env: Record<string, string> }).env, { BAZ: 'qux' });
	} finally {
		await cleanup();
	}
});

test('remove sub-key from record with dot notation (env.FOO)', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'env.FOO', 'bar' ]);
		await runConfigWithDir(configDir, [ 'set', '--global', 'env.BAZ', 'qux' ]);
		await runConfigWithDir(configDir, [ 'remove', '--global', 'env.FOO' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		// eslint-disable-next-line @typescript-eslint/naming-convention
		t.deepEqual((config as { env: Record<string, string> }).env, { BAZ: 'qux' });
	} finally {
		await cleanup();
	}
});

test('remove cleans up empty parent fields', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--global', 'packages', 'vim' ]);
		await runConfigWithDir(configDir, [ 'remove', '--global', 'packages', 'vim' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { packages?: string[] }).packages, undefined);
	} finally {
		await cleanup();
	}
});

test('error on remove without key', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'remove', '--global' ]);
		t.not(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('add to project defined with tilde path writes to correct config file', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const claudexDir = path.join(configDir, 'claudex');
	const configFragmentsDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configFragmentsDir, { recursive: true });

	// Pre-create a config file with a project using tilde path
	const tildePath = '~/code/lix';
	await writeFile(
		path.join(configFragmentsDir, '99-private.json'),
		JSON.stringify({ projects: { [tildePath]: { packages: [ 'git' ] } } }),
	);

	try {
		// Use --project with tilde path
		const result = await runConfigWithDir(configDir, [ 'add', '--project', '~/code/lix', 'volumes', '~/code/parser' ]);
		t.is(result.exitCode, 0);

		// Should write to 99-private.json where the project is defined
		const config = await readJsonFile(path.join(configFragmentsDir, '99-private.json'));
		const { projects } = (config as { projects: Record<string, { volumes?: string[] }> });
		t.deepEqual(projects['~/code/lix'].volumes, [ '~/code/parser' ]);

		// Config.json should not exist (nothing should have been written there)
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

// --- Key validation tests ---

test('set rejects unknown top-level key', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'typoField', 'value' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('Unknown configuration key'));
	} finally {
		await cleanup();
	}
});

test('set rejects unknown hooks subkey', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.typoKey', 'true' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('Unknown subkey'));
	} finally {
		await cleanup();
	}
});

test('set rejects unknown mcpServers subkey', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'mcpServers.nonexistent', 'true' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('Unknown subkey'));
	} finally {
		await cleanup();
	}
});

test('set allows valid hooks subkey', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
		t.is(result.exitCode, 0);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { hooks: { logPrompts: boolean } }).hooks.logPrompts, true);
	} finally {
		await cleanup();
	}
});

test('set allows arbitrary env subkey', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'env.MY_CUSTOM_VAR', 'hello' ]);
		t.is(result.exitCode, 0);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { env: Record<string, string> }).env.MY_CUSTOM_VAR, 'hello');
	} finally {
		await cleanup();
	}
});

test('add rejects unknown top-level key', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'add', '--global', 'unknownField', 'value' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('Unknown configuration key'));
	} finally {
		await cleanup();
	}
});

test('set rejects group in global scope, allows in project scope', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const globalResult = await runConfigWithDir(configDir, [ 'set', '--global', 'group', 'dev' ]);
		t.not(globalResult.exitCode, 0);
		t.true(globalResult.stderr.includes('project scope'));

		const projectPath = '/home/user/code/myproject';
		const projectResult = await runConfigWithDir(configDir, [ 'set', '--project', projectPath, 'group', 'dev' ]);
		t.is(projectResult.exitCode, 0);
	} finally {
		await cleanup();
	}
});

// --- Smart boolean-to-detail resolution tests ---

test('set hooks true then set hooks.logPrompts false preserves recommended keys', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks', 'true' ]);
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.logPrompts', 'false' ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const { hooks } = config as { hooks: Record<string, boolean> };
		t.is(typeof hooks, 'object');
		t.is(hooks.logPrompts, false);
		// Other recommended keys should be preserved from resolveHooks(true)
		t.is(typeof hooks.banGitC, 'boolean');
	} finally {
		await cleanup();
	}
});

test('set mcpServers true then set mcpServers.claudex false preserves detail object', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'mcpServers', 'true' ]);
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'mcpServers.claudex', 'false' ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const { mcpServers } = config as { mcpServers: Record<string, boolean> };
		t.is(typeof mcpServers, 'object');
		t.is(mcpServers.claudex, false);
	} finally {
		await cleanup();
	}
});

test('set hooks.banGitC true then set hooks.logPrompts false keeps both keys', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.banGitC', 'true' ]);
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.logPrompts', 'false' ]);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const { hooks } = config as { hooks: Record<string, boolean> };
		t.is(hooks.banGitC, true);
		t.is(hooks.logPrompts, false);
	} finally {
		await cleanup();
	}
});

test('set hooks.logPrompts true when hooks undefined creates detail object', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const { hooks } = config as { hooks: Record<string, boolean> };
		t.is(typeof hooks, 'object');
		t.is(hooks.logPrompts, true);
	} finally {
		await cleanup();
	}
});

// --- Config keys command tests ---

test('config keys exits 0 and lists expected keys', async t => {
	const result = await runConfig([ 'keys' ]);
	t.is(result.exitCode, 0);
	t.true(result.stdout.includes('packages'));
	t.true(result.stdout.includes('hooks'));
	t.true(result.stdout.includes('hooks.logPrompts'));
	t.true(result.stdout.includes('mcpServers.claudex'));
	t.true(result.stdout.includes('group'));
});

test('config keys output includes type annotations', async t => {
	const result = await runConfig([ 'keys' ]);
	t.is(result.exitCode, 0);
	t.true(result.stdout.includes('string[]'));
	t.true(result.stdout.includes('boolean'));
	t.true(result.stdout.includes('number[]'));
});

// --- Existing hooks get/set gap tests ---

test('get hooks returns true when set to boolean', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks', 'true' ]);
		const result = await runConfigWithDir(configDir, [ 'get', '--global', 'hooks' ]);
		t.is(result.exitCode, 0);
		t.is(result.stdout.trim(), 'true');
	} finally {
		await cleanup();
	}
});

test('get hooks returns object JSON when set to detail form', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.banGitC', 'false' ]);
		const result = await runConfigWithDir(configDir, [ 'get', '--global', 'hooks' ]);
		t.is(result.exitCode, 0);
		const parsed = JSON.parse(result.stdout) as Record<string, boolean>;
		t.is(parsed.logPrompts, true);
		t.is(parsed.banGitC, false);
	} finally {
		await cleanup();
	}
});

test('get hooks.logPrompts returns value from detail form', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
		const result = await runConfigWithDir(configDir, [ 'get', '--global', 'hooks.logPrompts' ]);
		t.is(result.exitCode, 0);
		t.is(result.stdout.trim(), 'true');
	} finally {
		await cleanup();
	}
});

test('unset hooks.banGitC removes one key, preserves others', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.banGitC', 'true' ]);
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.logPrompts', 'false' ]);
		await runConfigWithDir(configDir, [ 'unset', '--global', 'hooks.banGitC' ]);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const { hooks } = config as { hooks: Record<string, boolean | undefined> };
		t.is(hooks.banGitC, undefined);
		t.is(hooks.logPrompts, false);
	} finally {
		await cleanup();
	}
});

test('set hooks true after detail form replaces detail with boolean', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
		await runConfigWithDir(configDir, [ 'set', '--global', 'hooks', 'true' ]);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is((config as { hooks: boolean | Record<string, unknown> }).hooks, true);
	} finally {
		await cleanup();
	}
});

// --- Config group command tests ---

test('config group assigns multiple projects to a group', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const projA = await mkdtemp(path.join(tmpdir(), 'claudex-group-a-'));
	const projB = await mkdtemp(path.join(tmpdir(), 'claudex-group-b-'));
	try {
		const result = await runConfigWithDir(configDir, [ 'group', 'mygroup', projA, projB ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const typed = config as {
			groups: Record<string, Record<string, unknown>>;
			projects: Record<string, { group: string }>;
		};
		t.deepEqual(typed.groups.mygroup, {});
		t.is(typed.projects[projA].group, 'mygroup');
		t.is(typed.projects[projB].group, 'mygroup');
	} finally {
		await rm(projA, { recursive: true });
		await rm(projB, { recursive: true });
		await cleanup();
	}
});

test('config group auto-creates group entry', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const projC = await mkdtemp(path.join(tmpdir(), 'claudex-group-c-'));
	try {
		const result = await runConfigWithDir(configDir, [ 'group', 'newgroup', projC ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const typed = config as {
			groups: Record<string, Record<string, unknown>>;
			projects: Record<string, { group: string }>;
		};
		t.deepEqual(typed.groups.newgroup, {});
		t.is(typed.projects[projC].group, 'newgroup');
	} finally {
		await rm(projC, { recursive: true });
		await cleanup();
	}
});

test('config group preserves existing group settings', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const projD = await mkdtemp(path.join(tmpdir(), 'claudex-group-d-'));
	try {
		// Pre-create a group with some settings
		await runConfigWithDir(configDir, [ 'set', '--group', 'dev', 'settingSources', 'user' ]);

		// Assign a project to the existing group
		const result = await runConfigWithDir(configDir, [ 'group', 'dev', projD ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const typed = config as {
			groups: Record<string, { settingSources?: string }>;
			projects: Record<string, { group: string }>;
		};
		t.is(typed.groups.dev.settingSources, 'user');
		t.is(typed.projects[projD].group, 'dev');
	} finally {
		await rm(projD, { recursive: true });
		await cleanup();
	}
});

test('config group tilde-collapses paths under home directory', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const home = homedir();
	const projectDir = await mkdtemp(path.join(home, '.claudex-test-group-'));

	try {
		const result = await runConfigWithDir(configDir, [ 'group', 'mygroup', projectDir ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const { projects } = config as { projects: Record<string, unknown> };

		const realHome = await realpath(home);
		const realProjectDir = await realpath(projectDir);
		const expectedTildePath = '~' + realProjectDir.slice(realHome.length);

		t.truthy(projects[expectedTildePath], `expected project key ${expectedTildePath}`);
		t.is((projects[expectedTildePath] as { group: string }).group, 'mygroup');
		t.is(projects[projectDir], undefined, 'should not have absolute path key');
	} finally {
		await rm(projectDir, { recursive: true });
		await cleanup();
	}
});

test('config group outputs diff to stderr', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const projE = await mkdtemp(path.join(tmpdir(), 'claudex-group-e-'));
		const result = await runConfigWithDir(configDir, [ 'group', 'mygroup', projE ]);
		await rm(projE, { recursive: true });
		t.is(result.exitCode, 0);
		t.true(result.stderr.includes('@@'), 'should have unified diff hunk header');
		t.true(result.stderr.includes('mygroup'), 'diff should mention the group name');
	} finally {
		await cleanup();
	}
});

test('config group is idempotent for already-assigned projects', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const projF = await mkdtemp(path.join(tmpdir(), 'claudex-group-f-'));
	try {
		await runConfigWithDir(configDir, [ 'group', 'mygroup', projF ]);
		const config1 = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));

		// Run again with same path
		const result = await runConfigWithDir(configDir, [ 'group', 'mygroup', projF ]);
		t.is(result.exitCode, 0);
		const config2 = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));

		t.deepEqual(config1, config2);
	} finally {
		await rm(projF, { recursive: true });
		await cleanup();
	}
});

test('config group errors without paths', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'group', 'mygroup' ]);
		t.not(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

// --- Config ungroup command tests ---

test('config ungroup removes group from multiple projects', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const projA = await mkdtemp(path.join(tmpdir(), 'claudex-ungroup-a-'));
	const projB = await mkdtemp(path.join(tmpdir(), 'claudex-ungroup-b-'));
	try {
		// Assign both to a group
		await runConfigWithDir(configDir, [ 'group', 'mygroup', projA, projB ]);

		// Ungroup both
		const result = await runConfigWithDir(configDir, [ 'ungroup', projA, projB ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const typed = config as {
			groups?: Record<string, Record<string, unknown>>;
			projects?: Record<string, { group?: string }>;
		};
		// Group entry should remain
		t.deepEqual(typed.groups?.mygroup, {});
		// Projects should be cleaned up (empty after removing group)
		t.is(typed.projects, undefined);
	} finally {
		await rm(projA, { recursive: true });
		await rm(projB, { recursive: true });
		await cleanup();
	}
});

test('config ungroup cleans up empty project entries', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const projA = await mkdtemp(path.join(tmpdir(), 'claudex-ungroup-cleanup-'));
	try {
		// Create a project with group and another field
		await runConfigWithDir(configDir, [ 'group', 'mygroup', projA ]);
		await runConfigWithDir(configDir, [ 'add', '--project', projA, 'packages', 'vim' ]);

		// Ungroup
		const result = await runConfigWithDir(configDir, [ 'ungroup', projA ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const typed = config as {
			projects?: Record<string, { group?: string; packages?: string[] }>;
		};
		// Project should still exist (has packages), but no group
		t.truthy(typed.projects?.[projA]);
		t.is(typed.projects?.[projA].group, undefined);
		t.deepEqual(typed.projects?.[projA].packages, [ 'vim' ]);
	} finally {
		await rm(projA, { recursive: true });
		await cleanup();
	}
});

test('config ungroup is idempotent for projects without group', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const projA = await mkdtemp(path.join(tmpdir(), 'claudex-ungroup-idempotent-'));
	try {
		// Ungrouping a project that was never grouped is a no-op
		const result = await runConfigWithDir(configDir, [ 'ungroup', projA ]);
		t.is(result.exitCode, 0);
	} finally {
		await rm(projA, { recursive: true });
		await cleanup();
	}
});

test('config ungroup errors without paths', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'ungroup' ]);
		t.not(result.exitCode, 0);
	} finally {
		await cleanup();
	}
});

test('config ungroup tilde-collapses paths under home directory', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const home = homedir();
	const projectDir = await mkdtemp(path.join(home, '.claudex-test-ungroup-'));

	try {
		// Assign to group (will tilde-collapse)
		await runConfigWithDir(configDir, [ 'group', 'mygroup', projectDir ]);

		// Ungroup using the absolute path (should match tilde-collapsed key)
		const result = await runConfigWithDir(configDir, [ 'ungroup', projectDir ]);
		t.is(result.exitCode, 0);

		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		const typed = config as {
			projects?: Record<string, unknown>;
		};
		// Project should be cleaned up entirely (only had group field)
		t.is(typed.projects, undefined);
	} finally {
		await rm(projectDir, { recursive: true });
		await cleanup();
	}
});

// --- Config list --members tests ---

test('config list --members shows member projects', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	const projA = await mkdtemp(path.join(tmpdir(), 'claudex-members-a-'));
	const projB = await mkdtemp(path.join(tmpdir(), 'claudex-members-b-'));
	try {
		await runConfigWithDir(configDir, [ 'group', 'mygroup', projA, projB ]);

		const result = await runConfigWithDir(configDir, [ 'list', '--group', 'mygroup', '--members' ]);
		t.is(result.exitCode, 0);
		const lines = result.stdout.trim().split('\n');
		t.is(lines.length, 2);
		t.true(lines.includes(projA));
		t.true(lines.includes(projB));
	} finally {
		await rm(projA, { recursive: true });
		await rm(projB, { recursive: true });
		await cleanup();
	}
});

test('config list --members shows empty output for unknown group', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'list', '--group', 'nonexistent', '--members' ]);
		t.is(result.exitCode, 0);
		t.is(result.stdout.trim(), '');
	} finally {
		await cleanup();
	}
});

test('config list --members errors without --group', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'list', '--members' ]);
		t.not(result.exitCode, 0);
		t.true(result.stderr.includes('--members requires --group'));
	} finally {
		await cleanup();
	}
});

// --- Profile scope tests ---

test('profile scope writes to correct file', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--profile', 'jira', 'packages', 'jira-cli' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual(
			(config as { profiles: Record<string, { packages: string[] }> }).profiles.jira.packages,
			[ 'jira-cli' ],
		);
	} finally {
		await cleanup();
	}
});

test('set field on profile scope', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--profile', 'jira', 'settingSources', 'user' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is(
			(config as { profiles: Record<string, { settingSources: string }> }).profiles.jira.settingSources,
			'user',
		);
	} finally {
		await cleanup();
	}
});

test('set record field on profile scope (env.KEY)', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		// eslint-disable-next-line no-template-curly-in-string
		const templateString = '${JIRA_API_TOKEN}';
		await runConfigWithDir(configDir, [ 'set', '--profile', 'jira', 'env.JIRA_API_TOKEN', templateString ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is(
			(config as { profiles: Record<string, { env: Record<string, string> }> }).profiles.jira.env.JIRA_API_TOKEN,
			templateString,
		);
	} finally {
		await cleanup();
	}
});

test('add volumes to profile scope', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--profile', 'jira', 'volumes', '~/.config/.jira/' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual(
			(config as { profiles: Record<string, { volumes: string[] }> }).profiles.jira.volumes,
			[ '~/.config/.jira/' ],
		);
	} finally {
		await cleanup();
	}
});

test('get reads value from profile scope', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--profile', 'gh', 'packages', 'github-cli' ]);
		const result = await runConfigWithDir(configDir, [ 'get', '--profile', 'gh', 'packages' ]);
		t.is(result.exitCode, 0);
		t.deepEqual(JSON.parse(result.stdout), [ 'github-cli' ]);
	} finally {
		await cleanup();
	}
});

test('list outputs profile config as JSON', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--profile', 'glab', 'packages', 'glab' ]);
		await runConfigWithDir(configDir, [ 'add', '--profile', 'glab', 'volumes', '~/.config/glab-cli/' ]);
		const result = await runConfigWithDir(configDir, [ 'list', '--profile', 'glab' ]);
		t.is(result.exitCode, 0);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const parsed = JSON.parse(result.stdout);
		t.deepEqual(parsed.packages, [ 'glab' ]);
		t.deepEqual(parsed.volumes, [ '~/.config/glab-cli/' ]);
	} finally {
		await cleanup();
	}
});

test('list outputs empty object for unknown profile', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const result = await runConfigWithDir(configDir, [ 'list', '--profile', 'nonexistent' ]);
		t.is(result.exitCode, 0);
		t.is(result.stdout.trim(), '{}');
	} finally {
		await cleanup();
	}
});

test('remove value from profile array field', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'add', '--profile', 'dev', 'packages', 'vim' ]);
		await runConfigWithDir(configDir, [ 'add', '--profile', 'dev', 'packages', 'curl' ]);
		await runConfigWithDir(configDir, [ 'remove', '--profile', 'dev', 'packages', 'vim' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual(
			(config as { profiles: Record<string, { packages: string[] }> }).profiles.dev.packages,
			[ 'curl' ],
		);
	} finally {
		await cleanup();
	}
});

test('unset removes field from profile', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		await runConfigWithDir(configDir, [ 'set', '--profile', 'dev', 'settingSources', 'user' ]);
		await runConfigWithDir(configDir, [ 'unset', '--profile', 'dev', 'settingSources' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.is(
			(config as { profiles: Record<string, { settingSources?: string }> }).profiles.dev.settingSources,
			undefined,
		);
	} finally {
		await cleanup();
	}
});

test('add profiles reference to group', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		// Create a profile definition
		await runConfigWithDir(configDir, [ 'add', '--profile', 'jira', 'packages', 'jira-cli' ]);

		// Reference the profile from a group
		await runConfigWithDir(configDir, [ 'add', '--group', 'mygroup', 'profiles', 'jira' ]);
		const config = await readJsonFile(path.join(configDir, 'claudex', 'config.json'));
		t.deepEqual(
			(config as { groups: Record<string, { profiles: string[] }> }).groups.mygroup.profiles,
			[ 'jira' ],
		);
	} finally {
		await cleanup();
	}
});

test('config keys includes profiles', async t => {
	const result = await runConfig([ 'keys' ]);
	t.is(result.exitCode, 0);
	t.true(result.stdout.includes('profiles'));
});

test('profile scope resolves file when profile exists in specific config file', async t => {
	const { configDir, cleanup } = await createTemporaryConfigDir();
	try {
		const claudexDir = path.join(configDir, 'claudex');
		const configJsonDirectory = path.join(claudexDir, 'config.json.d');
		await mkdir(configJsonDirectory, { recursive: true });

		// Pre-create a config file with a profile
		await writeFile(
			path.join(configJsonDirectory, '99-private.json'),
			JSON.stringify({ profiles: { jira: { packages: [ 'jira-cli' ] } } }),
		);

		// Add a volume to the profile - should write to the same file
		await runConfigWithDir(configDir, [ 'add', '--profile', 'jira', 'volumes', '~/.config/.jira/' ]);

		const config = await readJsonFile(path.join(configJsonDirectory, '99-private.json'));
		const typed = config as { profiles: Record<string, { packages?: string[]; volumes?: string[] }> };
		t.deepEqual(typed.profiles.jira.packages, [ 'jira-cli' ]);
		t.deepEqual(typed.profiles.jira.volumes, [ '~/.config/.jira/' ]);

		// Config.json should not exist
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
