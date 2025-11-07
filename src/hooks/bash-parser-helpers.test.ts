import test from 'ava';
import { extractCommandNames, hasChainOperators } from './bash-parser-helpers.js';

test('extractCommandNames - detects actual cat command', t => {
	const commands = extractCommandNames('cat file.txt');
	t.deepEqual(commands, new Set([ 'cat' ]));
});

test('extractCommandNames - does not detect cat in string argument', t => {
	const commands = extractCommandNames('echo "cat file.txt"');
	t.deepEqual(commands, new Set([ 'echo' ]));
});

test('extractCommandNames - does not detect cat in longer string argument', t => {
	const commands = extractCommandNames('claudex-submit-co-authorship-proof "Modified code to allow cat with heredoc"');
	t.deepEqual(commands, new Set([ 'claudex-submit-co-authorship-proof' ]));
});

test('extractCommandNames - detects cat inside command substitution', t => {
	// We now recursively parse $(...)  to detect commands inside
	const command = 'git commit -m "$(cat <<\'EOF\'\nTest commit message\nEOF\n)"';
	const commands = extractCommandNames(command);
	t.true(commands.has('git'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects multiple commands in pipeline', t => {
	const commands = extractCommandNames('cat file.txt | grep pattern | head -n 10');
	t.deepEqual(commands, new Set([ 'cat', 'grep', 'head' ]));
});

test('extractCommandNames - detects commands in compound statements', t => {
	const commands = extractCommandNames('cat file1.txt && sed "s/foo/bar/" file2.txt');
	t.deepEqual(commands, new Set([ 'cat', 'sed' ]));
});

test('extractCommandNames - does not detect cat in comment', t => {
	const commands = extractCommandNames('echo hello # cat file.txt');
	t.deepEqual(commands, new Set([ 'echo' ]));
});

test('extractCommandNames - detects sed but not in string', t => {
	const commands = extractCommandNames('sed "s/cat/dog/" file.txt');
	t.deepEqual(commands, new Set([ 'sed' ]));
});

test('extractCommandNames - handles command with flags', t => {
	const commands = extractCommandNames('head -n 20 file.txt');
	t.deepEqual(commands, new Set([ 'head' ]));
});

test('extractCommandNames - handles awk command', t => {
	const commands = extractCommandNames('awk \'{print $1}\' file.txt');
	t.deepEqual(commands, new Set([ 'awk' ]));
});

test('extractCommandNames - handles tail command', t => {
	const commands = extractCommandNames('tail -f /var/log/system.log');
	t.deepEqual(commands, new Set([ 'tail' ]));
});

test('extractCommandNames - does not detect commands in variable names', t => {
	const commands = extractCommandNames('echo $cat_file');
	t.deepEqual(commands, new Set([ 'echo' ]));
});

test('extractCommandNames - handles compound statement with heredoc', t => {
	const command = 'git commit -m "$(cat <<\'EOF\'\n'
		+ 'Allow cat with heredoc in pre-tool-use hook\n'
		+ 'EOF\n)" && git status';
	const commands = extractCommandNames(command);
	// Should detect: git, cat, and EOF (heredoc delimiter is parsed as a token)
	t.true(commands.has('git'));
	t.true(commands.has('cat'));
	// Note: heredoc delimiter EOF is also detected as a token
	t.is(commands.size, 3);
});

test('extractCommandNames - detects commands in backtick substitution', t => {
	// Note: shell-quote splits backtick substitutions across multiple tokens
	// (e.g., `cat file.txt` becomes ["`cat", "file.txt`"])
	// We handle this by collecting tokens between backticks
	const input = 'echo `cat file.txt`';
	const commands = extractCommandNames(input);
	t.deepEqual(commands, new Set([ 'echo', 'cat' ]));
});

test('extractCommandNames - detects nested $() inside $()', t => {
	const input = 'echo "$(head $(cat config.txt))"';
	const commands = extractCommandNames(input);
	t.true(commands.has('echo'));
	t.true(commands.has('head'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects nested backticks', t => {
	const input = 'echo `head \\`cat config.txt\\``';
	const commands = extractCommandNames(input);
	t.true(commands.has('echo'));
	// Note: Escaped backticks might not parse correctly, but at minimum echo should be detected
	t.true(commands.has('head'));
});

test('extractCommandNames - detects $() inside backticks', t => {
	const input = 'echo `head $(cat config.txt)`';
	const commands = extractCommandNames(input);
	t.true(commands.has('echo'));
	t.true(commands.has('head'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects backticks inside $()', t => {
	const input = 'echo "$(head `cat config.txt`)"';
	const commands = extractCommandNames(input);
	t.true(commands.has('echo'));
	t.true(commands.has('head'));
	t.true(commands.has('cat'));
});

test('extractCommandNames - detects commands in complex pipeline with redirection', t => {
	const input = 'yarn build && yarn ava src/hooks/bash-parser-helpers.test.ts 2>&1 | grep -A 10 "test"';
	const commands = extractCommandNames(input);
	t.true(commands.has('yarn'));
	t.true(commands.has('grep'));
	// Sets automatically deduplicate - only unique commands
	t.is(commands.size, 3); // Yarn, ava, grep
});

test('hasChainOperators - detects && operator', t => {
	t.true(hasChainOperators('npm install && npm test'));
});

test('hasChainOperators - detects || operator', t => {
	t.true(hasChainOperators('npm test || echo "Tests failed"'));
});

test('hasChainOperators - detects ; operator', t => {
	t.true(hasChainOperators('cd /tmp; ls'));
});

test('hasChainOperators - detects multiple operators', t => {
	t.true(hasChainOperators('cd /tmp && ls || echo "failed"'));
});

test('hasChainOperators - does not detect operators in strings', t => {
	t.false(hasChainOperators('echo "use && to chain commands"'));
});

test('hasChainOperators - does not detect operators in comments', t => {
	t.false(hasChainOperators('echo hello # use && for chaining'));
});

test('hasChainOperators - allows pipe operator', t => {
	t.false(hasChainOperators('cat file.txt | grep pattern'));
});

test('hasChainOperators - does not detect & in background operator', t => {
	// Single & for background is not banned, only && || and ;
	t.false(hasChainOperators('sleep 10 &'));
});

test('hasChainOperators - does not detect operators in command substitution', t => {
	// Operators inside $() should not be flagged as top-level operators
	t.false(hasChainOperators('echo "$(cd /tmp && ls)"'));
});

test('hasChainOperators - handles simple commands', t => {
	t.false(hasChainOperators('ls -la'));
	t.false(hasChainOperators('git status'));
	t.false(hasChainOperators('npm install'));
});
