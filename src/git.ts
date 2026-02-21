import path from 'node:path';
import { execa } from 'execa';

export async function getGitRoot(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execa('git', [ 'rev-parse', '--show-toplevel' ], { cwd });
		return stdout.trim();
	} catch {
		// Not a git repo
		return undefined;
	}
}

export async function getGitWorktreeParentPath(cwd: string): Promise<string | undefined> {
	try {
		const { stdout: gitCommonDir } = await execa('git', [ 'rev-parse', '--git-common-dir' ], { cwd });
		const { stdout: gitDir } = await execa('git', [ 'rev-parse', '--git-dir' ], { cwd });

		// Resolve to absolute paths before comparing, since git may return
		// different relative paths for each (e.g., "../.git" vs ".git")
		const absoluteCommonDir = path.resolve(cwd, gitCommonDir);
		const absoluteGitDir = path.resolve(cwd, gitDir);

		// If they differ, we're in a worktree
		if (absoluteCommonDir !== absoluteGitDir) {
			// GitCommonDir is like /path/to/main/.git, we need /path/to/main
			return path.dirname(absoluteCommonDir);
		}
	} catch {
		// Not a git repo
	}

	return undefined;
}
