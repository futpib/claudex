import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { paths } from './paths.js';

export type AccountPaths = {
	claudeConfigDir: string;
};

export function getAccountPaths(accountName: string | undefined): AccountPaths {
	if (!accountName) {
		return {
			claudeConfigDir: path.join(os.homedir(), '.claude'),
		};
	}

	return {
		claudeConfigDir: path.join(paths.config, 'accounts', accountName, 'claude'),
	};
}

export async function ensureAccountDirs(accountPaths: AccountPaths): Promise<void> {
	await fs.mkdir(accountPaths.claudeConfigDir, { recursive: true });
}
