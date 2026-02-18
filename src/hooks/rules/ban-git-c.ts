import path from 'node:path';
import os from 'node:os';
import type { Rule } from './index.js';

function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}

	return filePath;
}

export const banGitC: Rule = {
	meta: {
		name: 'ban-git-c',
		configKey: 'banGitC',
		recommended: true,
		phase: 'main',
		description: 'Do not use git -C; run git commands in the current directory',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const gitChangeDirPath = await context.helpers.getGitChangeDirectoryPath(context.command);
		if (gitChangeDirPath === undefined) {
			return { type: 'pass' };
		}

		const resolvedPath = path.resolve(context.cwd, expandTilde(gitChangeDirPath));
		if (resolvedPath === context.cwd) {
			return {
				type: 'violation',
				messages: [
					'❌ git -C is not needed here',
					`The target directory "${gitChangeDirPath}" is already the current working directory.`,
					'Please run the git command directly without -C.',
				],
			};
		}

		return {
			type: 'violation',
			messages: [
				'❌ git -C is not allowed',
				'Running git commands in a different directory is not permitted.',
				'Please cd to the target directory and run git commands there instead.',
			],
		};
	},
};
