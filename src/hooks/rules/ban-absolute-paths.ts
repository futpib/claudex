import path from 'node:path';
import os from 'node:os';
import type { Rule } from './index.js';

function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}

	if (filePath === '~') {
		return os.homedir();
	}

	return filePath;
}

export const banAbsolutePaths: Rule = {
	meta: {
		name: 'ban-absolute-paths',
		configKey: 'banAbsolutePaths',
		recommended: true,
		phase: 'main',
		description: 'Do not use absolute paths under cwd in bash commands; use relative paths instead',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const result = await context.helpers.findAbsolutePathUnderCwd(context.command, context.cwd);
		if (result) {
			const expanded = expandTilde(result);
			const relativePath = './' + path.relative(context.cwd, expanded);
			return {
				type: 'violation',
				messages: [
					`❌ Absolute path under cwd is not allowed: ${result}`,
					`cwd: ${context.cwd}`,
					`Use relative path instead: ${relativePath}`,
				],
			};
		}

		return { type: 'pass' };
	},
};
