#!/usr/bin/env node

import process from 'node:process';
import {
	loadPendingConfirmation, verifyConfirmationToken, storeConfirmation,
} from '../confirm.js';
import { buildToolUseMap, extractContent } from '../memory-search/parser.js';

async function main() {
	const shortId = process.argv[2];
	const proof = process.argv[3];

	if (!shortId || !proof) {
		console.error('Usage: claudex confirm <id> <proof>');
		console.error('Example: claudex confirm a1b2c3d4e5f6 \'User said: "please push to main"\'');
		process.exit(1);
	}

	let token;
	try {
		token = await loadPendingConfirmation(shortId);
	} catch {
		console.error(`❌ Unknown confirmation ID: ${shortId}`);
		process.exit(1);
	}

	let payload;
	try {
		payload = await verifyConfirmationToken(token);
	} catch (error) {
		console.error(`❌ Invalid or expired confirmation token: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	const { actionHash, sessionId, transcriptPath } = payload;

	// Verify proof against session transcript
	try {
		const toolUseMap = await buildToolUseMap(transcriptPath);
		let found = false;

		for await (const content of extractContent(transcriptPath, toolUseMap, {
			targets: new Set([ 'user' ] as const),
			sessionId,
		})) {
			if (content.text.includes(proof) || proof.includes(content.text.trim())) {
				found = true;
				break;
			}

			// Check for substantial substring match (at least 20 chars or full proof)
			const minLength = Math.min(20, proof.length);
			if (proof.length >= minLength) {
				for (let i = 0; i <= proof.length - minLength; i++) {
					const substring = proof.slice(i, i + minLength);
					if (content.text.includes(substring)) {
						found = true;
						break;
					}
				}
			}

			if (found) {
				break;
			}
		}

		if (!found) {
			console.error('❌ Proof quote not found in session transcript.');
			console.error('The proof must contain an exact quote from the user in this session.');
			process.exit(1);
		}
	} catch (error) {
		console.error(`❌ Failed to read session transcript: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}

	await storeConfirmation(actionHash, sessionId, token, proof);
	console.log(`✅ Confirmation stored for action ${actionHash.slice(0, 12)}...`);
}

await main();
