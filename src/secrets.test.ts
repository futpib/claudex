import test from 'ava';
import { isSecret, shieldEnvVars } from './secrets.js';

test('isSecret detects a GitHub personal access token', async t => {
	const result = await isSecret('GITHUB_TOKEN', 'ghp_abc123def456ghi789jkl012mno345pqr678');
	t.true(result);
});

test('isSecret detects a Slack token with key context', async t => {
	const result = await isSecret('SLACK_TOKEN', 'xoxb-abc123def456ghi789jkl012mno345pqr678');
	t.true(result);
});

test('isSecret does not flag a plain non-secret value', async t => {
	const result = await isSecret('EDITOR', 'vim');
	t.false(result);
});

test('isSecret does not flag a PATH value', async t => {
	const result = await isSecret('PATH', '/usr/local/bin:/usr/bin:/bin');
	t.false(result);
});

test('shieldEnvVars masks secret values', async t => {
	const result = await shieldEnvVars({
		GITHUB_TOKEN: 'ghp_abc123def456ghi789jkl012mno345pqr678', // eslint-disable-line @typescript-eslint/naming-convention
		EDITOR: 'vim', // eslint-disable-line @typescript-eslint/naming-convention
	});

	const tokenEntry = result.find(entry => entry.startsWith('GITHUB_TOKEN='));
	const editorEntry = result.find(entry => entry.startsWith('EDITOR='));

	t.is(tokenEntry, 'GITHUB_TOKEN=****');
	t.is(editorEntry, 'EDITOR=vim');
});

test('shieldEnvVars masks Slack token that requires key context', async t => {
	const result = await shieldEnvVars({
		SLACK_TOKEN: 'xoxb-abc123def456ghi789jkl012mno345pqr678', // eslint-disable-line @typescript-eslint/naming-convention
		HOME: '/home/user', // eslint-disable-line @typescript-eslint/naming-convention
	});

	const slackEntry = result.find(entry => entry.startsWith('SLACK_TOKEN='));
	const homeEntry = result.find(entry => entry.startsWith('HOME='));

	t.is(slackEntry, 'SLACK_TOKEN=****');
	t.is(homeEntry, 'HOME=/home/user');
});
