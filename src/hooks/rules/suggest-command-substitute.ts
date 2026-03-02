import { execa } from 'execa';
import type { Rule } from './index.js';

/**
 * Groups of interchangeable commands. When any command in a group is used but
 * not found, the rule suggests whichever other commands in the group are available.
 */
const commandGroups: string[][] = [
	[ 'pip', 'pip3', 'uv' ],
];

async function commandExists(cmd: string): Promise<boolean> {
	try {
		await execa('which', [ cmd ]);
		return true;
	} catch {
		return false;
	}
}

export const suggestCommandSubstitute: Rule = {
	meta: {
		name: 'suggest-command-substitute',
		configKey: 'suggestCommandSubstitute',
		recommended: true,
		phase: 'main',
		description: 'When a command does not exist but an equivalent command is available, suggest it',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const usedCommands = await context.helpers.extractCommandNames(context.command);

		for (const group of commandGroups) {
			for (const cmd of group) {
				if (!usedCommands.has(cmd)) {
					continue;
				}

				// eslint-disable-next-line no-await-in-loop
				if (await commandExists(cmd)) {
					continue; // Command exists, no issue
				}

				// Find available alternatives from the same group (in parallel)
				const others = group.filter(other => other !== cmd);
				// eslint-disable-next-line no-await-in-loop
				const otherExists = await Promise.all(others.map(async other => commandExists(other)));
				const available = others.filter((_, i) => otherExists[i]);

				if (available.length === 0) {
					continue; // No alternatives available, don't block
				}

				return {
					type: 'violation',
					messages: [
						`❌ Command "${cmd}" not found`,
						`Available alternatives: ${available.join(', ')}`,
					],
				};
			}
		}

		return { type: 'pass' };
	},
};
