import { execa } from 'execa';
import type { Rule } from './index.js';

async function commandExists(cmd: string): Promise<boolean> {
	try {
		await execa('which', [ cmd ]);
		return true;
	} catch {
		return false;
	}
}

export const preferGhx: Rule = {
	meta: {
		name: 'prefer-ghx',
		configKey: 'preferGhx',
		recommended: true,
		phase: 'main',
		description: 'Do not use gh when ghx is available; use ghx instead',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const commands = await context.helpers.extractCommandNames(context.command);
		if (!commands.has('gh')) {
			return { type: 'pass' };
		}

		if (await commandExists('ghx')) {
			return {
				type: 'violation',
				messages: [
					'❌ Use ghx instead of gh',
					'ghx is available and should be used instead of gh.',
				],
			};
		}

		return { type: 'pass' };
	},
};
