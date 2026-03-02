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
			const usedInGroup = group.filter(cmd => usedCommands.has(cmd));
			if (usedInGroup.length === 0) {
				continue;
			}

			// Check existence of all commands in the group in parallel
			// eslint-disable-next-line no-await-in-loop
			const existsResults = await Promise.all(group.map(async cmd => commandExists(cmd)));
			const existsMap = new Map(group.map((cmd, i) => [ cmd, existsResults[i] ]));

			for (const cmd of usedInGroup) {
				if (existsMap.get(cmd)) {
					continue; // Command exists, no issue
				}

				const available = group.filter(other => other !== cmd && existsMap.get(other));

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
