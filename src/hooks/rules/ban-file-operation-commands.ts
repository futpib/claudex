import type { Rule } from './index.js';

export const banFileOperationCommands: Rule = {
	meta: {
		name: 'ban-file-operation-commands',
		configKey: 'banFileOperationCommands',
		recommended: true,
		phase: 'main',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const fileOperationCommands = new Set([ 'cat', 'sed', 'head', 'tail', 'awk' ]);

		const actualCommands = await context.helpers.extractCommandNames(context.command);

		const bannedCommands = [ ...actualCommands ].filter(cmd => fileOperationCommands.has(cmd));

		if (bannedCommands.length > 0) {
			// Allow cat with heredoc syntax (e.g., cat <<'EOF' or cat <<EOF)
			const catHeredocPattern = /\bcat\s+<<-?['"]?\w+['"]?/;
			if (bannedCommands.includes('cat') && catHeredocPattern.test(context.command)) {
				return { type: 'pass' };
			}

			// Allow tail with only a negative line offset and a filename (e.g., tail -100 file.log)
			const tailNegativeOffsetPattern = /^\s*tail\s+-\d+\s+\S+\s*$/;
			if (bannedCommands.length === 1 && bannedCommands[0] === 'tail' && tailNegativeOffsetPattern.test(context.command)) {
				return { type: 'pass' };
			}

			return {
				type: 'violation',
				messages: [
					'❌ Using bash commands (cat, sed, head, tail, awk) for file operations is not allowed',
					`Found: ${bannedCommands.join(', ')}`,
					'Please use the dedicated tools instead:',
					'  - Read tool: for reading files (supports offset/limit for specific line ranges)',
					'  - Edit tool: for editing files (instead of sed/awk)',
					'  - Write tool: for creating files (instead of cat/echo redirection)',
					'  - Grep tool: for searching file contents (instead of grep)',
					'Exceptions: cat with heredoc (cat <<EOF), tail with negative offset and filename only (tail -100 file)',
				],
			};
		}

		return { type: 'pass' };
	},
};
