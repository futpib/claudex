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

async function createTemporaryConfigDir() {
	const configDir = await mkdtemp(path.join(tmpdir(), 'claudex-config-test-'));
	return {
		configDir,
		async [Symbol.asyncDispose]() {
			await rm(configDir, { recursive: true });
		},
	};
}

async function createTemporaryDir(prefix: string) {
	const dir = await mkdtemp(path.join(tmpdir(), prefix));
	return {
		dir,
		async [Symbol.asyncDispose]() {
			await rm(dir, { recursive: true });
		},
	};
}

async function createTemporaryHomeDir(prefix: string) {
	const dir = await mkdtemp(path.join(homedir(), prefix));
	return {
		dir,
		async [Symbol.asyncDispose]() {
			await rm(dir, { recursive: true });
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
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'vim' ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'vim' ]);

	// Add another
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'curl' ]);
	const config2 = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config2 as { packages: string[] }).packages, [ 'vim', 'curl' ]);
});

test('add appends multiple values at once', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'cmake', 'ninja', 'vim' ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'cmake', 'ninja', 'vim' ]);
});

test('add multiple values skips duplicates', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'vim' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'curl', 'vim', 'git' ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'vim', 'curl', 'git' ]);
});

test('add does not duplicate existing package', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'zig' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'zig' ]);

	// Add the same package again
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'zig' ]);
	const config2 = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config2 as { packages: string[] }).packages, [ 'zig' ]);
});

test('add appends to volumes array', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'volumes', '/tmp/vol1' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { volumes: string[] }).volumes, [ '/tmp/vol1' ]);
});

test('add appends to hostPorts with number coercion', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'hostPorts', '8443' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { hostPorts: number[] }).hostPorts, [ 8443 ]);

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'hostPorts', '2222' ]);
	const config2 = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config2 as { hostPorts: number[] }).hostPorts, [ 8443, 2222 ]);
});

test('add appends to ssh.keys', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'ssh.keys', '~/.ssh/id_ed25519' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { ssh: { keys: string[] } }).ssh.keys, [ '~/.ssh/id_ed25519' ]);
});

test('add appends to ssh.hosts', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'ssh.hosts', 'github.com' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { ssh: { hosts: string[] } }).ssh.hosts, [ 'github.com' ]);
});

test('set scalar field (settingSources)', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'settingSources', 'user' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { settingSources: string }).settingSources, 'user');
});

test('set boolean field (shareVolumes)', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'shareVolumes', 'false' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { shareVolumes: boolean }).shareVolumes, false);
});

test('set boolean field (dockerDangerouslySkipPermissions)', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'dockerDangerouslySkipPermissions', 'true' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { dockerDangerouslySkipPermissions: boolean }).dockerDangerouslySkipPermissions, true);
});

test('set boolean field (dockerAllowDangerouslySkipPermissions)', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'dockerAllowDangerouslySkipPermissions', 'true' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { dockerAllowDangerouslySkipPermissions: boolean }).dockerAllowDangerouslySkipPermissions, true);
});

test('set record field (env.KEY)', async t => {
	await using handle = await createTemporaryConfigDir();

	// eslint-disable-next-line no-template-curly-in-string
	const templateString = '${API_KEY}';
	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.API_KEY', templateString ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { env: Record<string, string> }).env.API_KEY, templateString);
});

test('set record field (extraHosts.HOST)', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'extraHosts.gitlab.example.com', '127.0.0.1' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { extraHosts: Record<string, string> }).extraHosts['gitlab.example.com'], '127.0.0.1');
});

test('unset removes scalar field', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'settingSources', 'user' ]);
	await runConfigWithDir(handle.configDir, [ 'unset', '--global', 'settingSources' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { settingSources?: string }).settingSources, undefined);
});

test('unset removes specific value from array', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'vim' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'curl' ]);
	await runConfigWithDir(handle.configDir, [ 'unset', '--global', 'packages', 'vim' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'curl' ]);
});

test('unset removes specific number from hostPorts', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'hostPorts', '8443' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'hostPorts', '2222' ]);
	await runConfigWithDir(handle.configDir, [ 'unset', '--global', 'hostPorts', '8443' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { hostPorts: number[] }).hostPorts, [ 2222 ]);
});

test('unset removes record sub-key', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.FOO', 'bar' ]);
	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.BAZ', 'qux' ]);
	await runConfigWithDir(handle.configDir, [ 'unset', '--global', 'env.FOO' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	// eslint-disable-next-line @typescript-eslint/naming-convention
	t.deepEqual((config as { env: Record<string, string> }).env, { BAZ: 'qux' });
});

test('unset removes last array value and cleans up field', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'vim' ]);
	await runConfigWithDir(handle.configDir, [ 'unset', '--global', 'packages', 'vim' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { packages?: string[] }).packages, undefined);
});

test('project scope writes to correct file', async t => {
	await using handle = await createTemporaryConfigDir();

	const projectPath = '/home/user/code/myproject';

	// First write creates in config.json
	await runConfigWithDir(handle.configDir, [ 'add', '--project', projectPath, 'packages', 'vim' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual(
		(config as { projects: Record<string, { packages: string[] }> }).projects[projectPath].packages,
		[ 'vim' ],
	);

	// Second write finds the same file
	await runConfigWithDir(handle.configDir, [ 'add', '--project', projectPath, 'packages', 'curl' ]);
	const config2 = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual(
		(config2 as { projects: Record<string, { packages: string[] }> }).projects[projectPath].packages,
		[ 'vim', 'curl' ],
	);
});

test('group scope writes to correct file', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--group', 'mygroup', 'settingSources', 'user' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is(
		(config as { groupDefinitions: Record<string, { settingSources: string }> }).groupDefinitions.mygroup.settingSources,
		'user',
	);
});

test('--file writes to specific file in config.json.d', async t => {
	await using handle = await createTemporaryConfigDir();

	const configJsonDirectory = path.join(handle.configDir, 'claudex', 'config.json.d');
	await mkdir(configJsonDirectory, { recursive: true });

	await runConfigWithDir(handle.configDir, [ 'add', '--global', '--file', 'config.json.d/99-private.json', 'packages', 'vim' ]);
	const config = await readJsonFile(path.join(configJsonDirectory, '99-private.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'vim' ]);
});

test('ambiguous project file errors', async t => {
	await using handle = await createTemporaryConfigDir();

	const claudexDir = path.join(handle.configDir, 'claudex');
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

	const result = await runConfigWithDir(handle.configDir, [ 'add', '--project', projectPath, 'packages', 'git' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('multiple config files'));
});

test('get reads value', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'settingSources', 'user,local' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'get', '--global', 'settingSources' ]);
	t.is(result.exitCode, 0);
	t.is(result.stdout.trim(), 'user,local');
});

test('get reads array value as JSON', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'hostPorts', '2222' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'hostPorts', '8443' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'get', '--global', 'hostPorts' ]);
	t.is(result.exitCode, 0);
	t.deepEqual(JSON.parse(result.stdout), [ 2222, 8443 ]);
});

test('get reads record sub-key', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.MY_VAR', 'hello' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'get', '--global', 'env.MY_VAR' ]);
	t.is(result.exitCode, 0);
	t.is(result.stdout.trim(), 'hello');
});

test('list outputs config as JSON', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'settingSources', 'user' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'vim' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'list', '--global' ]);
	t.is(result.exitCode, 0);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const parsed = JSON.parse(result.stdout);
	t.is(parsed.settingSources, 'user');
	t.deepEqual(parsed.packages, [ 'vim' ]);
});

test('list for project includes group name', async t => {
	await using handle = await createTemporaryConfigDir();
	await using proj = await createTemporaryDir('claudex-list-group-');

	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', proj.dir ]);
	const result = await runConfigWithDir(handle.configDir, [ 'list', '--project', proj.dir ]);
	t.is(result.exitCode, 0);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const parsed = JSON.parse(result.stdout);
	t.is(parsed.group, 'mygroup');
});

test('get group for project returns group name', async t => {
	await using handle = await createTemporaryConfigDir();
	await using proj = await createTemporaryDir('claudex-get-group-');

	await runConfigWithDir(handle.configDir, [ 'group', 'devgroup', proj.dir ]);
	const result = await runConfigWithDir(handle.configDir, [ 'get', '--project', proj.dir, 'group' ]);
	t.is(result.exitCode, 0);
	t.is(result.stdout.trim(), 'devgroup');
});

test('set group field with --group', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--group', 'dev', 'extraHosts.myhost', '10.0.0.1' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is(
		(config as { groupDefinitions: Record<string, { extraHosts: Record<string, string> }> }).groupDefinitions.dev.extraHosts.myhost,
		'10.0.0.1',
	);
});

test('set project group field', async t => {
	await using handle = await createTemporaryConfigDir();

	const projectPath = '/home/user/code/myproject';
	await runConfigWithDir(handle.configDir, [ 'set', '--project', projectPath, 'group', 'dev' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is(
		(config as { projects: Record<string, { group: string }> }).projects[projectPath].group,
		'dev',
	);
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
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'settingSources' ]);
	t.not(result.exitCode, 0);
});

test('error on invalid hostPort', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'add', '--global', 'hostPorts', 'notanumber' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('Invalid port number'));
});

test('error on invalid shareVolumes value', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'shareVolumes', 'maybe' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('Invalid boolean'));
});

test('add volumes collapses shell-expanded home path to tilde', async t => {
	await using handle = await createTemporaryConfigDir();

	const expandedPath = homedir() + '/Downloads/foo';
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'volumes', expandedPath ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { volumes: string[] }).volumes, [ '~/Downloads/foo' ]);
});

test('remove volumes matches shell-expanded path against tilde-stored value', async t => {
	await using handle = await createTemporaryConfigDir();

	// Add with tilde notation
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'volumes', '~/Downloads/foo' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { volumes: string[] }).volumes, [ '~/Downloads/foo' ]);

	// Remove with shell-expanded path (simulating what the shell does to ~/Downloads/foo)
	const expandedPath = homedir() + '/Downloads/foo';
	await runConfigWithDir(handle.configDir, [ 'remove', '--global', 'volumes', expandedPath ]);
	const config2 = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config2 as { volumes?: string[] }).volumes, undefined);
});

test('remove volumes matches expanded path against expanded-stored value', async t => {
	await using handle = await createTemporaryConfigDir();

	// Manually write a config with an expanded path (simulating legacy or hand-edited config)
	const claudexDir = path.join(handle.configDir, 'claudex');
	await mkdir(claudexDir, { recursive: true });
	const expandedPath = homedir() + '/Downloads/foo';
	await writeFile(
		path.join(claudexDir, 'config.json'),
		JSON.stringify({ volumes: [ expandedPath ] }),
	);

	// Remove with the same expanded path
	const result = await runConfigWithDir(handle.configDir, [ 'remove', '--global', 'volumes', expandedPath ]);
	t.is(result.exitCode, 0);
	const config = await readJsonFile(path.join(claudexDir, 'config.json'));
	t.is((config as { volumes?: string[] }).volumes, undefined);
});

test('add volumes stores tilde path without expanding', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'volumes', '~/code/parser' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { volumes: string[] }).volumes, [ '~/code/parser' ]);
});

test('implicit project scope uses tilde path as project key', async t => {
	await using handle = await createTemporaryConfigDir();
	const claudexDir = path.join(handle.configDir, 'claudex');
	const configFragmentsDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configFragmentsDir, { recursive: true });

	// Create a temporary project directory to use as cwd
	await using project = await createTemporaryDir('claudex-project-');

	// Pre-create a config file with a project using the absolute path
	await writeFile(
		path.join(configFragmentsDir, '99-private.json'),
		JSON.stringify({ projects: { [project.dir]: { packages: [ 'git' ] } } }),
	);

	// Run from the project directory without --project flag
	const result = await runConfigWithDir(handle.configDir, [ 'add', 'volumes', '~/code/parser' ], project.dir);
	t.is(result.exitCode, 0);

	// Should write to the file where the project is defined (99-private.json),
	// not to config.json
	const config = await readJsonFile(path.join(configFragmentsDir, '99-private.json'));
	const { projects } = (config as { projects: Record<string, { volumes?: string[] }> });
	t.deepEqual(projects[project.dir].volumes, [ '~/code/parser' ]);
});

test('implicit scope from git worktree resolves to parent repo project', async t => {
	await using handle = await createTemporaryConfigDir();
	const claudexDir = path.join(handle.configDir, 'claudex');
	const configFragmentsDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configFragmentsDir, { recursive: true });

	// Create a git repo and a worktree
	await using repo = await createTemporaryDir('claudex-repo-');
	await execa('git', [ 'init' ], { cwd: repo.dir });
	await execa('git', [ 'config', 'user.email', 'test@test.com' ], { cwd: repo.dir });
	await execa('git', [ 'config', 'user.name', 'Test' ], { cwd: repo.dir });
	await writeFile(path.join(repo.dir, 'README.md'), '# Test');
	await execa('git', [ 'add', '.' ], { cwd: repo.dir });
	await execa('git', [ 'commit', '-m', 'Initial commit' ], { cwd: repo.dir });

	const worktreeDir = repo.dir + '.worktree';
	await execa('git', [ 'worktree', 'add', worktreeDir, '-b', 'worktree-branch' ], { cwd: repo.dir });

	// Pre-create a config file with the main repo as a project
	await writeFile(
		path.join(configFragmentsDir, '99-private.json'),
		JSON.stringify({ projects: { [repo.dir]: { packages: [ 'git' ] } } }),
	);

	try {
		// Run from the worktree directory without --project flag
		const result = await runConfigWithDir(handle.configDir, [ 'add', 'packages', 'zig' ], worktreeDir);
		t.is(result.exitCode, 0);

		// Should write to the parent repo's project entry, not create a new one
		const config = await readJsonFile(path.join(configFragmentsDir, '99-private.json'));
		const { projects } = (config as { projects: Record<string, { packages?: string[] }> });
		t.deepEqual(projects[repo.dir].packages, [ 'git', 'zig' ]);

		// Config.json should not exist (nothing should have been written there)
		try {
			await readJsonFile(path.join(claudexDir, 'config.json'));
			t.fail('config.json should not have been created');
		} catch {
			t.pass('config.json correctly does not exist');
		}
	} finally {
		await rm(worktreeDir, { recursive: true });
	}
});

test('implicit scope from cwd under home directory uses tilde in project key', async t => {
	await using handle = await createTemporaryConfigDir();
	const claudexDir = path.join(handle.configDir, 'claudex');

	const home = homedir();
	const realHome = await realpath(home);
	// Use a real subdirectory under $HOME as cwd
	await using project = await createTemporaryHomeDir('.claudex-test-project-');
	const realProjectDir = await realpath(project.dir);
	const expectedTildePath = '~' + realProjectDir.slice(realHome.length);

	const result = await runConfigWithDir(handle.configDir, [ 'add', 'packages', 'vim' ], project.dir);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(claudexDir, 'config.json'));
	const projects = (config as { projects?: Record<string, unknown> }).projects ?? {};

	// Should use tilde path as key, not absolute path
	t.truthy(projects[expectedTildePath], `expected project key ${expectedTildePath}`);
	t.is(projects[project.dir], undefined, `should not have absolute path key ${project.dir}`);
});

test('implicit scope from git worktree creates project under parent repo path', async t => {
	await using handle = await createTemporaryConfigDir();
	const claudexDir = path.join(handle.configDir, 'claudex');

	// Create a git repo and a worktree
	await using repo = await createTemporaryDir('claudex-repo-');
	await execa('git', [ 'init' ], { cwd: repo.dir });
	await execa('git', [ 'config', 'user.email', 'test@test.com' ], { cwd: repo.dir });
	await execa('git', [ 'config', 'user.name', 'Test' ], { cwd: repo.dir });
	await writeFile(path.join(repo.dir, 'README.md'), '# Test');
	await execa('git', [ 'add', '.' ], { cwd: repo.dir });
	await execa('git', [ 'commit', '-m', 'Initial commit' ], { cwd: repo.dir });

	const worktreeDir = repo.dir + '.worktree';
	await execa('git', [ 'worktree', 'add', worktreeDir, '-b', 'worktree-branch' ], { cwd: repo.dir });

	try {
		// Run from the worktree directory without --project flag
		// No existing project entry for the parent repo
		const result = await runConfigWithDir(handle.configDir, [ 'add', 'packages', 'zig' ], worktreeDir);
		t.is(result.exitCode, 0);

		// Should create project under the parent repo path, not the worktree path
		const config = await readJsonFile(path.join(claudexDir, 'config.json'));
		const projects = (config as { projects?: Record<string, unknown> }).projects ?? {};
		t.deepEqual((projects[repo.dir] as { packages?: string[] })?.packages, [ 'zig' ]);

		// Should NOT have an entry for the worktree path
		t.is(projects[worktreeDir], undefined);
	} finally {
		await rm(worktreeDir, { recursive: true });
	}
});

test('add outputs diff to stderr, duplicate add produces no diff', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'git' ]);
	t.is(result.exitCode, 0);
	t.true(result.stderr.includes('+'), 'first add should have added lines in stderr');
	t.true(result.stderr.includes('git'), 'first add should mention the added value');
	t.true(result.stderr.includes('@@'), 'first add should have unified diff hunk header');

	// Adding the same value again should produce no diff but show a message
	const result2 = await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'git' ]);
	t.is(result2.exitCode, 0);
	t.false(result2.stderr.includes('@@'), 'duplicate add should not have unified diff hunk header');
	t.true(result2.stderr.includes('already contains git'), 'duplicate add should mention that the value already exists');
});

test('remove removes value from array', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'vim' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'curl' ]);
	await runConfigWithDir(handle.configDir, [ 'remove', '--global', 'packages', 'vim' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'curl' ]);
});

test('remove with dot notation removes value from array', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'vim' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'curl' ]);
	await runConfigWithDir(handle.configDir, [ 'remove', '--global', 'packages.vim' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { packages: string[] }).packages, [ 'curl' ]);
});

test('remove from nested array (ssh.keys)', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'ssh.keys', '~/.ssh/id_ed25519' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'ssh.keys', '~/.ssh/id_rsa' ]);
	await runConfigWithDir(handle.configDir, [ 'remove', '--global', 'ssh.keys', '~/.ssh/id_ed25519' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual((config as { ssh: { keys: string[] } }).ssh.keys, [ '~/.ssh/id_rsa' ]);
});

test('remove sub-key from record with field+value syntax (env FOO)', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.FOO', 'bar' ]);
	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.BAZ', 'qux' ]);
	await runConfigWithDir(handle.configDir, [ 'remove', '--global', 'env', 'FOO' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	// eslint-disable-next-line @typescript-eslint/naming-convention
	t.deepEqual((config as { env: Record<string, string> }).env, { BAZ: 'qux' });
});

test('remove sub-key from record with dot notation (env.FOO)', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.FOO', 'bar' ]);
	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.BAZ', 'qux' ]);
	await runConfigWithDir(handle.configDir, [ 'remove', '--global', 'env.FOO' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	// eslint-disable-next-line @typescript-eslint/naming-convention
	t.deepEqual((config as { env: Record<string, string> }).env, { BAZ: 'qux' });
});

test('remove cleans up empty parent fields', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--global', 'packages', 'vim' ]);
	await runConfigWithDir(handle.configDir, [ 'remove', '--global', 'packages', 'vim' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { packages?: string[] }).packages, undefined);
});

test('error on remove without key', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'remove', '--global' ]);
	t.not(result.exitCode, 0);
});

test('add to project defined with tilde path writes to correct config file', async t => {
	await using handle = await createTemporaryConfigDir();
	const claudexDir = path.join(handle.configDir, 'claudex');
	const configFragmentsDir = path.join(claudexDir, 'config.json.d');
	await mkdir(configFragmentsDir, { recursive: true });

	// Pre-create a config file with a project using tilde path
	const tildePath = '~/code/lix';
	await writeFile(
		path.join(configFragmentsDir, '99-private.json'),
		JSON.stringify({ projects: { [tildePath]: { packages: [ 'git' ] } } }),
	);

	// Use --project with tilde path
	const result = await runConfigWithDir(handle.configDir, [ 'add', '--project', '~/code/lix', 'volumes', '~/code/parser' ]);
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
});

// --- Key validation tests ---

test('set rejects unknown top-level key', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'typoField', 'value' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('Unknown configuration key'));
});

test('set rejects unknown hooks subkey', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.typoKey', 'true' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('Unknown subkey'));
});

test('set rejects unknown mcpServers subkey', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'mcpServers.nonexistent', 'true' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('Unknown subkey'));
});

test('set allows valid hooks subkey', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
	t.is(result.exitCode, 0);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { hooks: { logPrompts: boolean } }).hooks.logPrompts, true);
});

test('set allows arbitrary env subkey', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'env.MY_CUSTOM_VAR', 'hello' ]);
	t.is(result.exitCode, 0);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { env: Record<string, string> }).env.MY_CUSTOM_VAR, 'hello');
});

test('add rejects unknown top-level key', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'add', '--global', 'unknownField', 'value' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('Unknown configuration key'));
});

test('set rejects group in global scope, allows in project scope', async t => {
	await using handle = await createTemporaryConfigDir();

	const globalResult = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'group', 'dev' ]);
	t.not(globalResult.exitCode, 0);
	t.true(globalResult.stderr.includes('project scope'));

	const projectPath = '/home/user/code/myproject';
	const projectResult = await runConfigWithDir(handle.configDir, [ 'set', '--project', projectPath, 'group', 'dev' ]);
	t.is(projectResult.exitCode, 0);
});

// --- Smart boolean-to-detail resolution tests ---

test('set hooks true then set hooks.logPrompts false preserves recommended keys', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks', 'true' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.logPrompts', 'false' ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const { hooks } = config as { hooks: Record<string, boolean> };
	t.is(typeof hooks, 'object');
	t.is(hooks.logPrompts, false);
	// Other recommended keys should be preserved from resolveHooks(true)
	t.is(typeof hooks.banGitC, 'boolean');
});

test('set mcpServers true then set mcpServers.claudex false preserves detail object', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'mcpServers', 'true' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'mcpServers.claudex', 'false' ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const { mcpServers } = config as { mcpServers: Record<string, boolean> };
	t.is(typeof mcpServers, 'object');
	t.is(mcpServers.claudex, false);
});

test('set hooks.banGitC true then set hooks.logPrompts false keeps both keys', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.banGitC', 'true' ]);
	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.logPrompts', 'false' ]);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const { hooks } = config as { hooks: Record<string, boolean> };
	t.is(hooks.banGitC, true);
	t.is(hooks.logPrompts, false);
});

test('set hooks.logPrompts true when hooks undefined creates detail object', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const { hooks } = config as { hooks: Record<string, boolean> };
	t.is(typeof hooks, 'object');
	t.is(hooks.logPrompts, true);
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
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks', 'true' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'get', '--global', 'hooks' ]);
	t.is(result.exitCode, 0);
	t.is(result.stdout.trim(), 'true');
});

test('get hooks returns object JSON when set to detail form', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.banGitC', 'false' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'get', '--global', 'hooks' ]);
	t.is(result.exitCode, 0);
	const parsed = JSON.parse(result.stdout) as Record<string, boolean>;
	t.is(parsed.logPrompts, true);
	t.is(parsed.banGitC, false);
});

test('get hooks.logPrompts returns value from detail form', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'get', '--global', 'hooks.logPrompts' ]);
	t.is(result.exitCode, 0);
	t.is(result.stdout.trim(), 'true');
});

test('unset hooks.banGitC removes one key, preserves others', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.banGitC', 'true' ]);
	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.logPrompts', 'false' ]);
	await runConfigWithDir(handle.configDir, [ 'unset', '--global', 'hooks.banGitC' ]);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const { hooks } = config as { hooks: Record<string, boolean | undefined> };
	t.is(hooks.banGitC, undefined);
	t.is(hooks.logPrompts, false);
});

test('set hooks true after detail form replaces detail with boolean', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks.logPrompts', 'true' ]);
	await runConfigWithDir(handle.configDir, [ 'set', '--global', 'hooks', 'true' ]);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is((config as { hooks: boolean | Record<string, unknown> }).hooks, true);
});

// --- Config group command tests ---

test('config group assigns multiple projects to a group', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projA = await createTemporaryDir('claudex-group-a-');
	await using projB = await createTemporaryDir('claudex-group-b-');

	const result = await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', projA.dir, projB.dir ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		groupDefinitions: Record<string, Record<string, unknown>>;
		projects: Record<string, { group: string }>;
	};
	t.deepEqual(typed.groupDefinitions.mygroup, {});
	t.is(typed.projects[projA.dir].group, 'mygroup');
	t.is(typed.projects[projB.dir].group, 'mygroup');
});

test('config group auto-creates group entry', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projC = await createTemporaryDir('claudex-group-c-');

	const result = await runConfigWithDir(handle.configDir, [ 'group', 'newgroup', projC.dir ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		groupDefinitions: Record<string, Record<string, unknown>>;
		projects: Record<string, { group: string }>;
	};
	t.deepEqual(typed.groupDefinitions.newgroup, {});
	t.is(typed.projects[projC.dir].group, 'newgroup');
});

test('config group preserves existing group settings', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projD = await createTemporaryDir('claudex-group-d-');

	// Pre-create a group with some settings
	await runConfigWithDir(handle.configDir, [ 'set', '--group', 'dev', 'settingSources', 'user' ]);

	// Assign a project to the existing group
	const result = await runConfigWithDir(handle.configDir, [ 'group', 'dev', projD.dir ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		groupDefinitions: Record<string, { settingSources?: string }>;
		projects: Record<string, { group: string }>;
	};
	t.is(typed.groupDefinitions.dev.settingSources, 'user');
	t.is(typed.projects[projD.dir].group, 'dev');
});

test('config group tilde-collapses paths under home directory', async t => {
	await using handle = await createTemporaryConfigDir();
	await using project = await createTemporaryHomeDir('.claudex-test-group-');

	const result = await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', project.dir ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const { projects } = config as { projects: Record<string, unknown> };

	const home = homedir();
	const realHome = await realpath(home);
	const realProjectDir = await realpath(project.dir);
	const expectedTildePath = '~' + realProjectDir.slice(realHome.length);

	t.truthy(projects[expectedTildePath], `expected project key ${expectedTildePath}`);
	t.is((projects[expectedTildePath] as { group: string }).group, 'mygroup');
	t.is(projects[project.dir], undefined, 'should not have absolute path key');
});

test('config group outputs diff to stderr', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projE = await createTemporaryDir('claudex-group-e-');

	const result = await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', projE.dir ]);
	t.is(result.exitCode, 0);
	t.true(result.stderr.includes('@@'), 'should have unified diff hunk header');
	t.true(result.stderr.includes('mygroup'), 'diff should mention the group name');
});

test('config group is idempotent for already-assigned projects', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projF = await createTemporaryDir('claudex-group-f-');

	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', projF.dir ]);
	const config1 = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));

	// Run again with same path
	const result = await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', projF.dir ]);
	t.is(result.exitCode, 0);
	const config2 = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));

	t.deepEqual(config1, config2);
});

test('config group errors without paths', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'group', 'mygroup' ]);
	t.not(result.exitCode, 0);
});

test('config group does not create groupDefinitions when group exists in another file', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projG = await createTemporaryDir('claudex-group-g-');

	const claudexDir = path.join(handle.configDir, 'claudex');
	const configJsonDirectory = path.join(claudexDir, 'config.json.d');
	await mkdir(configJsonDirectory, { recursive: true });

	// Define the group in a separate config fragment file
	await writeFile(
		path.join(configJsonDirectory, '01-groups.json'),
		JSON.stringify({ groupDefinitions: { existinggroup: { settingSources: 'user' } } }),
	);

	// Now assign a project to that group via the main config.json
	const result = await runConfigWithDir(handle.configDir, [ 'group', 'existinggroup', projG.dir ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(claudexDir, 'config.json'));
	const typed = config as {
		groupDefinitions?: Record<string, Record<string, unknown>>;
		projects: Record<string, { group: string }>;
	};

	// The project should be assigned to the group
	t.is(typed.projects[projG.dir].group, 'existinggroup');

	// GroupDefinitions should NOT be created in config.json since it already exists elsewhere
	t.is(typed.groupDefinitions, undefined);
});

// --- Config ungroup command tests ---

test('config ungroup removes group from multiple projects', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projA = await createTemporaryDir('claudex-ungroup-a-');
	await using projB = await createTemporaryDir('claudex-ungroup-b-');

	// Assign both to a group
	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', projA.dir, projB.dir ]);

	// Ungroup both
	const result = await runConfigWithDir(handle.configDir, [ 'ungroup', projA.dir, projB.dir ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		groupDefinitions?: Record<string, Record<string, unknown>>;
		projects?: Record<string, { group?: string }>;
	};
	// Group entry should remain
	t.deepEqual(typed.groupDefinitions?.mygroup, {});
	// Projects should be cleaned up (empty after removing group)
	t.is(typed.projects, undefined);
});

test('config ungroup cleans up empty project entries', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projA = await createTemporaryDir('claudex-ungroup-cleanup-');

	// Create a project with group and another field
	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', projA.dir ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--project', projA.dir, 'packages', 'vim' ]);

	// Ungroup
	const result = await runConfigWithDir(handle.configDir, [ 'ungroup', projA.dir ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		projects?: Record<string, { group?: string; packages?: string[] }>;
	};
	// Project should still exist (has packages), but no group
	t.truthy(typed.projects?.[projA.dir]);
	t.is(typed.projects?.[projA.dir].group, undefined);
	t.deepEqual(typed.projects?.[projA.dir].packages, [ 'vim' ]);
});

test('config ungroup is idempotent for projects without group', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projA = await createTemporaryDir('claudex-ungroup-idempotent-');

	// Ungrouping a project that was never grouped is a no-op
	const result = await runConfigWithDir(handle.configDir, [ 'ungroup', projA.dir ]);
	t.is(result.exitCode, 0);
});

test('config ungroup errors without paths', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'ungroup' ]);
	t.not(result.exitCode, 0);
});

test('config ungroup tilde-collapses paths under home directory', async t => {
	await using handle = await createTemporaryConfigDir();
	await using project = await createTemporaryHomeDir('.claudex-test-ungroup-');

	// Assign to group (will tilde-collapse)
	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', project.dir ]);

	// Ungroup using the absolute path (should match tilde-collapsed key)
	const result = await runConfigWithDir(handle.configDir, [ 'ungroup', project.dir ]);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		projects?: Record<string, unknown>;
	};
	// Project should be cleaned up entirely (only had group field)
	t.is(typed.projects, undefined);
});

// --- Config list --members tests ---

test('config list --members shows member projects', async t => {
	await using handle = await createTemporaryConfigDir();
	await using projA = await createTemporaryDir('claudex-members-a-');
	await using projB = await createTemporaryDir('claudex-members-b-');

	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', projA.dir, projB.dir ]);

	const result = await runConfigWithDir(handle.configDir, [ 'list', '--group', 'mygroup', '--members' ]);
	t.is(result.exitCode, 0);
	const lines = result.stdout.trim().split('\n');
	t.is(lines.length, 2);
	t.true(lines.includes(projA.dir));
	t.true(lines.includes(projB.dir));
});

test('config list --members shows empty output for unknown group', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'list', '--group', 'nonexistent', '--members' ]);
	t.is(result.exitCode, 0);
	t.is(result.stdout.trim(), '');
});

test('config list --members errors without --group', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'list', '--members' ]);
	t.not(result.exitCode, 0);
	t.true(result.stderr.includes('--members requires --group'));
});

// --- Profile scope tests ---

test('profile scope writes to correct file', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'jira', 'packages', 'jira-cli' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual(
		(config as { profileDefinitions: Record<string, { packages: string[] }> }).profileDefinitions.jira.packages,
		[ 'jira-cli' ],
	);
});

test('set field on profile scope', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--profile', 'jira', 'settingSources', 'user' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is(
		(config as { profileDefinitions: Record<string, { settingSources: string }> }).profileDefinitions.jira.settingSources,
		'user',
	);
});

test('set record field on profile scope (env.KEY)', async t => {
	await using handle = await createTemporaryConfigDir();

	// eslint-disable-next-line no-template-curly-in-string
	const templateString = '${JIRA_API_TOKEN}';
	await runConfigWithDir(handle.configDir, [ 'set', '--profile', 'jira', 'env.JIRA_API_TOKEN', templateString ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is(
		(config as { profileDefinitions: Record<string, { env: Record<string, string> }> }).profileDefinitions.jira.env.JIRA_API_TOKEN,
		templateString,
	);
});

test('add volumes to profile scope', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'jira', 'volumes', '~/.config/.jira/' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual(
		(config as { profileDefinitions: Record<string, { volumes: string[] }> }).profileDefinitions.jira.volumes,
		[ '~/.config/.jira/' ],
	);
});

test('get reads value from profile scope', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'gh', 'packages', 'github-cli' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'get', '--profile', 'gh', 'packages' ]);
	t.is(result.exitCode, 0);
	t.deepEqual(JSON.parse(result.stdout), [ 'github-cli' ]);
});

test('list outputs profile config as JSON', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'glab', 'packages', 'glab' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'glab', 'volumes', '~/.config/glab-cli/' ]);
	const result = await runConfigWithDir(handle.configDir, [ 'list', '--profile', 'glab' ]);
	t.is(result.exitCode, 0);
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const parsed = JSON.parse(result.stdout);
	t.deepEqual(parsed.packages, [ 'glab' ]);
	t.deepEqual(parsed.volumes, [ '~/.config/glab-cli/' ]);
});

test('list outputs empty object for unknown profile', async t => {
	await using handle = await createTemporaryConfigDir();

	const result = await runConfigWithDir(handle.configDir, [ 'list', '--profile', 'nonexistent' ]);
	t.is(result.exitCode, 0);
	t.is(result.stdout.trim(), '{}');
});

test('remove value from profile array field', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'dev', 'packages', 'vim' ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'dev', 'packages', 'curl' ]);
	await runConfigWithDir(handle.configDir, [ 'remove', '--profile', 'dev', 'packages', 'vim' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual(
		(config as { profileDefinitions: Record<string, { packages: string[] }> }).profileDefinitions.dev.packages,
		[ 'curl' ],
	);
});

test('unset removes field from profile', async t => {
	await using handle = await createTemporaryConfigDir();

	await runConfigWithDir(handle.configDir, [ 'set', '--profile', 'dev', 'settingSources', 'user' ]);
	await runConfigWithDir(handle.configDir, [ 'unset', '--profile', 'dev', 'settingSources' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.is(
		(config as { profileDefinitions: Record<string, { settingSources?: string }> }).profileDefinitions.dev.settingSources,
		undefined,
	);
});

test('add profiles reference to group', async t => {
	await using handle = await createTemporaryConfigDir();

	// Create a profile definition
	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'jira', 'packages', 'jira-cli' ]);

	// Reference the profile from a group
	await runConfigWithDir(handle.configDir, [ 'add', '--group', 'mygroup', 'profiles', 'jira' ]);
	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	t.deepEqual(
		(config as { groupDefinitions: Record<string, { profiles: string[] }> }).groupDefinitions.mygroup.profiles,
		[ 'jira' ],
	);
});

test('config keys includes profiles', async t => {
	const result = await runConfig([ 'keys' ]);
	t.is(result.exitCode, 0);
	t.true(result.stdout.includes('profiles'));
});

test('add redirects to group when group has value and project does not', async t => {
	await using handle = await createTemporaryConfigDir();
	await using project = await createTemporaryDir('claudex-group-redirect-');

	// Set up a group with packages and assign the project to it
	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', project.dir ]);
	await runConfigWithDir(handle.configDir, [ 'add', '--group', 'mygroup', 'packages', 'gcc' ]);

	// Run add from the project cwd without explicit scope
	const result = await runConfigWithDir(handle.configDir, [ 'add', 'packages', 'mold', 'lld' ], project.dir);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		groupDefinitions: Record<string, { packages?: string[] }>;
		projects: Record<string, { group: string; packages?: string[] }>;
	};

	// Packages should be on the group, not the project
	t.deepEqual(typed.groupDefinitions.mygroup.packages, [ 'gcc', 'mold', 'lld' ]);
	t.is(typed.projects[project.dir]?.packages, undefined);
});

test('add stays on project when neither project nor group has value for field', async t => {
	await using handle = await createTemporaryConfigDir();
	await using project = await createTemporaryDir('claudex-group-neither-');

	// Set up a group without packages and assign the project to it
	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', project.dir ]);

	// Run add from the project cwd without explicit scope
	const result = await runConfigWithDir(handle.configDir, [ 'add', 'packages', 'mold', 'lld' ], project.dir);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		groupDefinitions: Record<string, { packages?: string[] }>;
		projects: Record<string, { group: string; packages?: string[] }>;
	};

	// Packages should be on the project since group has no packages either
	t.deepEqual(typed.projects[project.dir]?.packages, [ 'mold', 'lld' ]);
	t.is(typed.groupDefinitions.mygroup.packages, undefined);
});

test('add stays on project when project already has own value for field', async t => {
	await using handle = await createTemporaryConfigDir();
	await using project = await createTemporaryDir('claudex-group-no-redirect-');

	// Set up a group and assign the project to it
	await runConfigWithDir(handle.configDir, [ 'group', 'mygroup', project.dir ]);

	// Give the project its own packages
	await runConfigWithDir(handle.configDir, [ 'add', '--project', project.dir, 'packages', 'vim' ]);

	// Run add from the project cwd without explicit scope
	const result = await runConfigWithDir(handle.configDir, [ 'add', 'packages', 'mold' ], project.dir);
	t.is(result.exitCode, 0);

	const config = await readJsonFile(path.join(handle.configDir, 'claudex', 'config.json'));
	const typed = config as {
		groupDefinitions: Record<string, { packages?: string[] }>;
		projects: Record<string, { group: string; packages?: string[] }>;
	};

	// Packages should stay on the project since it already had its own
	t.deepEqual(typed.projects[project.dir]?.packages, [ 'vim', 'mold' ]);
	t.is(typed.groupDefinitions.mygroup.packages, undefined);
});

test('profile scope resolves file when profile exists in specific config file', async t => {
	await using handle = await createTemporaryConfigDir();

	const claudexDir = path.join(handle.configDir, 'claudex');
	const configJsonDirectory = path.join(claudexDir, 'config.json.d');
	await mkdir(configJsonDirectory, { recursive: true });

	// Pre-create a config file with a profile
	await writeFile(
		path.join(configJsonDirectory, '99-private.json'),
		JSON.stringify({ profileDefinitions: { jira: { packages: [ 'jira-cli' ] } } }),
	);

	// Add a volume to the profile - should write to the same file
	await runConfigWithDir(handle.configDir, [ 'add', '--profile', 'jira', 'volumes', '~/.config/.jira/' ]);

	const config = await readJsonFile(path.join(configJsonDirectory, '99-private.json'));
	const typed = config as { profileDefinitions: Record<string, { packages?: string[]; volumes?: string[] }> };
	t.deepEqual(typed.profileDefinitions.jira.packages, [ 'jira-cli' ]);
	t.deepEqual(typed.profileDefinitions.jira.volumes, [ '~/.config/.jira/' ]);

	// Config.json should not exist
	try {
		await readJsonFile(path.join(claudexDir, 'config.json'));
		t.fail('config.json should not have been created');
	} catch {
		t.pass('config.json correctly does not exist');
	}
});
