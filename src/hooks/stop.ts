/* eslint-disable @typescript-eslint/naming-convention, unicorn/no-process-exit */

import process from 'node:process';
import { z } from 'zod';
import { sendHostMessage } from '../host-socket/client.js';
import { collapseHomedir } from '../utils.js';
import { readStdin, parseJsonWithSchema } from './shared.js';

const stopInputSchema = z.object({
	session_id: z.string(),
	transcript_path: z.string().optional(),
	hook_event_name: z.literal('Stop'),
});

export async function main() {
	const input = await readStdin();
	parseJsonWithSchema(input, stopInputSchema);

	const project = collapseHomedir(process.cwd());

	await sendHostMessage({
		type: 'notify',
		summary: `Claude Code — ${project}`,
		body: 'Task completed',
	});

	process.exit(0);
}
