import {
	mkdtemp, rm, readFile, writeFile, mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
