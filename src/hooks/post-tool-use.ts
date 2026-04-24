/* eslint-disable unicorn/no-process-exit */

import process from 'node:process';
import { readStdin } from './shared.js';

export async function main() {
	// Wire-through stub. Accepts any PostToolUse payload and exits successfully.
	// Rule classes for post-tool events can read stdin here in the future.
	await readStdin();
	process.exit(0);
}
