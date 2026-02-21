import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function isUnsafeDirectory(dir: string): Promise<{ unsafe: boolean; reason: string }> {
	const homeDir = os.homedir();
	const userInfo = os.userInfo();

	// Check if it's the home directory itself
	if (dir === homeDir) {
		return { unsafe: true, reason: 'home directory' };
	}

	// Check if it's a hidden directory in home (e.g., ~/.config, ~/.ssh)
	if (dir.startsWith(homeDir + '/.')) {
		return { unsafe: true, reason: 'hidden directory in home' };
	}

	// Check if directory is owned by current user
	try {
		const stat = await fs.stat(dir);
		if (stat.uid !== userInfo.uid) {
			return { unsafe: true, reason: 'directory not owned by current user' };
		}
	} catch {
		// If we can't stat, consider it unsafe
		return { unsafe: true, reason: 'cannot access directory' };
	}

	// Check if directory contains .git
	try {
		await fs.access(path.join(dir, '.git'));
	} catch {
		return { unsafe: true, reason: 'directory does not contain .git' };
	}

	return { unsafe: false, reason: '' };
}
