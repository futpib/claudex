#!/usr/bin/env node

import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from '../paths.js';

async function main() {
	const proofText = process.argv[2];

	if (!proofText) {
		console.error('Usage: claudex-submit-co-authorship-proof <proof-text>');
		console.error('Example: claudex-submit-co-authorship-proof "Claude Code modified src/component.tsx lines 15-20 to fix the bug"');
		process.exit(1);
	}

	const pin = crypto.createHash('sha256').update(proofText).digest('hex');

	const proofsDir = path.join(paths.data, 'co-authorship-proofs');
	await fs.mkdir(proofsDir, { recursive: true });

	const proofFile = path.join(proofsDir, `${pin}.json`);
	const proofData = {
		pin,
		proof: proofText,
		timestamp: new Date().toISOString(),
	};

	await fs.writeFile(proofFile, JSON.stringify(proofData, null, 2));

	console.log(pin);
}

await main();
