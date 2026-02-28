#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */

import process from 'node:process';
import { z } from 'zod';
import { sendHostMessage } from '../host-socket/client.js';
import { collapseHomedir } from '../utils.js';
import { readStdin, parseJsonWithSchema } from './shared.js';

const notificationInputSchema = z.object({
	session_id: z.string(),
	transcript_path: z.string().optional(),
	hook_event_name: z.literal('Notification'),
	message: z.string(),
	title: z.string().optional(),
	notification_type: z.string().optional(),
});

async function main() {
	const input = await readStdin();
	const hookInput = parseJsonWithSchema(input, notificationInputSchema);

	const project = collapseHomedir(process.cwd());
	const summary = hookInput.title ?? `Claude Code — ${project}`;
	const body = [ hookInput.notification_type, hookInput.message ]
		.filter(Boolean)
		.join(': ');

	await sendHostMessage({
		type: 'notify',
		summary,
		body,
	});

	process.exit(0);
}

await main();
