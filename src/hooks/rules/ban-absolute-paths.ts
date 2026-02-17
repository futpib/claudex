import path from 'node:path';
import type { Rule } from './index.js';

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
			const relativePath = './' + path.relative(context.cwd, result);
			return {
				type: 'violation',
				messages: [
					`❌ Absolute path under cwd is not allowed: ${result}`,
					`Use relative path instead: ${relativePath}`,
				],
			};
		}

		return { type: 'pass' };
	},
};
