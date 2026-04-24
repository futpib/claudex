/* eslint-disable unicorn/no-process-exit */

import process from 'node:process';
import { readStdin } from './shared.js';

export async function main() {
	// Wire-through stub for codex's SessionStart event. Rule classes can be
	// added later; for now we simply accept the payload and exit successfully.
	await readStdin();
	process.exit(0);
}
