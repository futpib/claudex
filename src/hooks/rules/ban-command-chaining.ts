import path from 'node:path';
import os from 'node:os';
import type { Rule } from './index.js';

function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}

	return filePath;
}

export const banCommandChaining: Rule = {
	meta: {
		name: 'ban-command-chaining',
		configKey: 'banCommandChaining',
		recommended: true,
		phase: 'main',
		description: 'Do not chain bash commands with &&, ||, ;, or newline; run commands separately',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (!(await context.helpers.hasChainOperators(context.command))) {
			return { type: 'pass' };
		}

		const cdTarget = await context.helpers.getLeadingCdTarget(context.command);
		if (cdTarget !== undefined) {
			const resolvedPath = path.resolve(context.cwd, expandTilde(cdTarget));
			if (resolvedPath === context.cwd) {
				return {
					type: 'violation',
					messages: [
						'❌ cd is not needed here',
						`The target directory "${cdTarget}" is already the current working directory.`,
						'Please run the command directly without cd.',
					],
				};
			}
		}

		return {
			type: 'violation',
			messages: [
				'❌ Chaining bash commands with &&, ||, ;, or newline is not allowed',
				'Please run commands separately for better tracking and error handling.',
			],
		};
	},
};
