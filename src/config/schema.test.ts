import test from 'ava';
import { rootConfigSchema } from './schema.js';

test('volume string with colon is rejected with a meaningful message', t => {
	const result = rootConfigSchema.safeParse({
		projects: {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			'~/code/foo': {
				volumes: [ '~/.cache/foo:/nix' ],
			},
		},
	});

	t.false(result.success);
	if (result.success) {
		return;
	}

	const { message } = result.error;
	t.true(message.includes('~/.cache/foo:/nix'), `expected message to mention the offending volume, got: ${message}`);
	t.true(message.includes('host:container'), `expected message to mention "host:container", got: ${message}`);
	t.true(message.includes('CLI'), `expected message to point at the CLI, got: ${message}`);
});

test('volume string without colon is accepted', t => {
	const result = rootConfigSchema.safeParse({
		projects: {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			'~/code/foo': {
				volumes: [ '~/.cache/foo' ],
			},
		},
	});

	t.true(result.success);
});

test('volume object form is accepted', t => {
	const result = rootConfigSchema.safeParse({
		projects: {
			// eslint-disable-next-line @typescript-eslint/naming-convention
			'~/code/foo': {
				volumes: [ { host: '~/.cache/foo', container: '/nix' } ],
			},
		},
	});

	t.true(result.success);
});
