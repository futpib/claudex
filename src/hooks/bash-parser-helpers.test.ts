import test from 'ava';
import { extractCommandNames, hasChainOperators, hasGitCFlag } from './bash-parser-helpers.js';

test('extractCommandNames - detects actual cat command', async t => {
	const commands = await extractCommandNames('cat file.txt');
	t.deepEqual(commands, new Set([ 'cat' ]));
});

test('extractCommandNames - does not detect cat in string argument', async t => {
	const commands = await extractCommandNames('echo "cat file.txt"');
	t.deepEqual(commands, new Set([ 'echo' ]));
});

test('extractCommandNames - does not detect cat in longer string argument', async t => {
	const commands = await extractCommandNames('claudex-submit-co-authorship-proof "Modified code to allow cat with heredoc"');
	t.deepEqual(commands, new Set([ 'claudex-submit-co-authorship-proof' ]));
});

test('extractCommandNames - detects cat inside command substitution', async t => {
	// We now recursively parse $(...) to detect commands inside
	const command = 'git commit -m "$(cat <<\'EOF\'\nTest commit message\nEOF\n)"';
	const commands = await extractCommandNames(command);
	t.true(commands.has('git'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects multiple commands in pipeline', async t => {
	const commands = await extractCommandNames('cat file.txt | grep pattern | head -n 10');
	t.deepEqual(commands, new Set([ 'cat', 'grep', 'head' ]));
});

test('extractCommandNames - detects commands in compound statements', async t => {
	const commands = await extractCommandNames('cat file1.txt && sed "s/foo/bar/" file2.txt');
	t.deepEqual(commands, new Set([ 'cat', 'sed' ]));
});

test('extractCommandNames - detects sed but not in string', async t => {
	const commands = await extractCommandNames('sed "s/cat/dog/" file.txt');
	t.deepEqual(commands, new Set([ 'sed' ]));
});

test('extractCommandNames - handles command with flags', async t => {
	const commands = await extractCommandNames('head -n 20 file.txt');
	t.deepEqual(commands, new Set([ 'head' ]));
});

test('extractCommandNames - handles awk command', async t => {
	const commands = await extractCommandNames('awk \'{print $1}\' file.txt');
	t.deepEqual(commands, new Set([ 'awk' ]));
});

test('extractCommandNames - handles tail command', async t => {
	const commands = await extractCommandNames('tail -f /var/log/system.log');
	t.deepEqual(commands, new Set([ 'tail' ]));
});

test('extractCommandNames - does not detect commands in variable names', async t => {
	const commands = await extractCommandNames('echo $cat_file');
	t.deepEqual(commands, new Set([ 'echo' ]));
});

test('extractCommandNames - handles compound statement with heredoc', async t => {
	const command = 'git commit -m "$(cat <<\'EOF\'\n'
		+ 'Allow cat with heredoc in pre-tool-use hook\n'
		+ 'EOF\n)" && git status';
	const commands = await extractCommandNames(command);
	t.true(commands.has('git'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects commands in backtick substitution', async t => {
	const input = 'echo `cat file.txt`';
	const commands = await extractCommandNames(input);
	t.deepEqual(commands, new Set([ 'echo', 'cat' ]));
});

test('extractCommandNames - detects nested $() inside $()', async t => {
	const input = 'echo "$(head $(cat config.txt))"';
	const commands = await extractCommandNames(input);
	t.true(commands.has('echo'));
	t.true(commands.has('head'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects $() inside backticks', async t => {
	const input = 'echo `head $(cat config.txt)`';
	const commands = await extractCommandNames(input);
	t.true(commands.has('echo'));
	t.true(commands.has('head'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects backticks inside $()', async t => {
	const input = 'echo "$(head `cat config.txt`)"';
	const commands = await extractCommandNames(input);
	t.true(commands.has('echo'));
	t.true(commands.has('head'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects commands in complex pipeline with redirection', async t => {
	const input = 'yarn build && yarn ava src/hooks/bash-parser-helpers.test.ts 2>&1 | grep -A 10 "test"';
	const commands = await extractCommandNames(input);
	t.true(commands.has('yarn'));
	t.true(commands.has('grep'));
});

test('hasChainOperators - detects && operator', async t => {
	t.true(await hasChainOperators('npm install && npm test'));
});

test('hasChainOperators - detects || operator', async t => {
	t.true(await hasChainOperators('npm test || echo "Tests failed"'));
});

test('hasChainOperators - detects ; operator', async t => {
	t.true(await hasChainOperators('cd /tmp; ls'));
});

test('hasChainOperators - detects multiple operators', async t => {
	t.true(await hasChainOperators('cd /tmp && ls || echo "failed"'));
});

test('hasChainOperators - does not detect operators in strings', async t => {
	t.false(await hasChainOperators('echo "use && to chain commands"'));
});

test('hasChainOperators - allows pipe operator', async t => {
	t.false(await hasChainOperators('cat file.txt | grep pattern'));
});

test('hasChainOperators - does not detect & in background operator', async t => {
	// Single & for background is not banned, only && || and ;
	t.false(await hasChainOperators('sleep 10 &'));
});

test('hasChainOperators - does not detect operators in command substitution', async t => {
	// Operators inside $() should not be flagged as top-level operators
	t.false(await hasChainOperators('echo "$(cd /tmp && ls)"'));
});

test('hasChainOperators - handles simple commands', async t => {
	t.false(await hasChainOperators('ls -la'));
	t.false(await hasChainOperators('git status'));
	t.false(await hasChainOperators('npm install'));
});

test('hasGitCFlag - detects git -C', async t => {
	t.true(await hasGitCFlag('git -C /some/path status'));
});

test('hasGitCFlag - detects git -C with flags before', async t => {
	t.true(await hasGitCFlag('git -v -C /some/path status'));
});

test('hasGitCFlag - does not detect -C in strings', async t => {
	t.false(await hasGitCFlag('git commit -m "Block git -C flag"'));
});

test('hasGitCFlag - does not detect -C in heredoc', async t => {
	const command = `git commit -m "$(cat <<'EOF'
Block git -C flag
EOF
)"`;
	t.false(await hasGitCFlag(command));
});

test('hasGitCFlag - does not trigger on regular git commands', async t => {
	t.false(await hasGitCFlag('git status'));
	t.false(await hasGitCFlag('git commit -m "message"'));
	t.false(await hasGitCFlag('git add .'));
});
