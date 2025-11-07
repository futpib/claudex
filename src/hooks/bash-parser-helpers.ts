import { parse as parseShellQuote } from 'shell-quote';

/**
 * Extracts actual command names from parsed shell tokens.
 * This properly distinguishes between:
 * - Actual commands: cat file.txt
 * - Commands in strings: echo "cat file.txt" (cat is inside the string, not a command)
 * - Commands in comments: # cat file.txt
 * - Commands in substitutions: git commit -m "$(cat <<'EOF'...)" (recursively parses)
 */
export function extractCommandNames(command: string): Set<string> {
	const tokens = parseShellQuote(command);
	const commands = new Set<string>();

	let expectCommand = true; // We expect a command at the start
	let backtickBuffer: string[] = []; // Collects tokens between backticks

	for (const token of tokens) {
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

/**
 * Checks if a bash command contains chain operators (&&, ||, ;).
 * Uses shell-quote parser to distinguish between actual operators and operators in strings/comments.
 * Returns true if the command contains any of the banned operators.
 */
export function hasChainOperators(command: string): boolean {
	const tokens = parseShellQuote(command);
	const bannedOperators = new Set([ '&&', '||', ';' ]);

	return tokens.some(token =>
		typeof token === 'object' && token !== null && 'op' in token
		&& bannedOperators.has((token as { op: string }).op));
}
