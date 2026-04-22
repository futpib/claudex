import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { paths } from './paths.js';

export type AccountPaths = {
	claudeConfigDir: string;
	codexConfigDir: string;
};

export function getAccountPaths(accountName: string | undefined): AccountPaths {
	if (!accountName) {
		return {
			claudeConfigDir: path.join(os.homedir(), '.claude'),
			codexConfigDir: path.join(os.homedir(), '.codex'),
		};
	}

	return {
		claudeConfigDir: path.join(paths.config, 'accounts', accountName, 'claude'),
		codexConfigDir: path.join(paths.config, 'accounts', accountName, 'codex'),
	};
}

export async function ensureAccountDirs(
	accountPaths: AccountPaths,
	which: { claude?: boolean; codex?: boolean } = { claude: true, codex: true },
): Promise<void> {
	if (which.claude) {
		await fs.mkdir(accountPaths.claudeConfigDir, { recursive: true });
	}

	if (which.codex) {
		await fs.mkdir(accountPaths.codexConfigDir, { recursive: true });
	}
}
