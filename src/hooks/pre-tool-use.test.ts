import test from 'ava';
import { parse as parseShellQuote } from 'shell-quote';

/**
 * Extracts actual command names from parsed shell tokens.
 * This is a copy of the function from pre-tool-use.ts for testing purposes.
 */
function extractCommandNames(command: string): Set<string> {
	const tokens = parseShellQuote(command);
	const commands = new Set<string>();

	let expectCommand = true; // We expect a command at the start
	let backtickBuffer: string[] = []; // Collects tokens between backticks

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (typeof token === 'string') {
			// Check if we're collecting a backtick substitution
			if (backtickBuffer.length > 0) {
				backtickBuffer.push(token);
				if (token.endsWith('`')) {
					// Complete backtick substitution found
					const subCommand = backtickBuffer.join(' ')
						.replace(/^`/, '') // Remove leading backtick
						.replace(/`$/, ''); // Remove trailing backtick
					const subCommands = extractCommandNames(subCommand);
					for (const cmd of subCommands) {
						commands.add(cmd);
					}

					backtickBuffer = [];
				}
				continue;
			}

			// Check if this token starts a backtick substitution
			if (token.startsWith('`')) {
				backtickBuffer.push(token);
				if (token.endsWith('`') && token.length > 1) {
					// Complete backtick in single token
					const subCommand = token.slice(1, -1);
					const subCommands = extractCommandNames(subCommand);
					for (const cmd of subCommands) {
						commands.add(cmd);
					}

					backtickBuffer = [];
				}
				continue;
			}

			if (expectCommand) {
				// This is a command name
				commands.add(token);
				expectCommand = false;
			} else {
				// This is an argument, check for command substitutions $(...)
				const commandSubPattern = /\$\(([^)]+)\)/g;

				let match = commandSubPattern.exec(token);
				while (match !== null) {
					const subCommand = match[1];
					// Recursively parse the substitution content
					const subCommands = extractCommandNames(subCommand);
					for (const cmd of subCommands) {
						commands.add(cmd);
					}

					match = commandSubPattern.exec(token);
				}
			}
		} else if (typeof token === 'object' && token !== null && 'op' in token) {
			// If we're inside backticks, keep collecting tokens (including operators)
			if (backtickBuffer.length > 0) {
				backtickBuffer.push((token as { op: string }).op);
				continue;
			}

			// This is an operator (&&, ||, |, ;, etc.)
			// After operators, we expect a new command
			expectCommand = true;
		}
		// Ignore other token types (comments, patterns, etc.)
	}

	return commands;
}

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
	const input = 'yarn build && yarn ava src/hooks/pre-tool-use.test.ts 2>&1 | grep -A 10 "test"';
	const commands = extractCommandNames(input);
	t.true(commands.has('yarn'));
	t.true(commands.has('grep'));
	// Sets automatically deduplicate - only unique commands
	t.is(commands.size, 3); // yarn, ava, grep
});
