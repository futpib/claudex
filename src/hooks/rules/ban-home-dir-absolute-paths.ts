import os from 'node:os';
import type { Rule } from './index.js';

export const banHomeDirAbsolutePaths: Rule = {
	meta: {
		name: 'ban-home-dir-absolute-paths',
		configKey: 'banHomeDirAbsolutePaths',
		recommended: true,
		phase: 'main',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const homeDir = os.homedir();
		const result = await context.helpers.findAbsolutePathUnderHome(context.command, homeDir);
		if (result) {
			const tildePath = result === homeDir
				? '~'
				: '~/' + result.slice(homeDir.length + 1);
			return {
				type: 'violation',
				messages: [
					`❌ Home directory absolute path is not allowed: ${result}`,
					`Use tilde expansion instead: ${tildePath}`,
				],
			};
		}

		return { type: 'pass' };
	},
};
