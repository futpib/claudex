import { execa } from 'execa';
import type { Rule } from './index.js';

type CommandAlternative = {
	/** Executable name(s) in bash invocations that trigger this alternative */
	triggers: string[];
	/** Executable name to check for existence on the system */
	executable: string;
	/** How to invoke this alternative (shown in the suggestion message) */
	invocation: string;
};

/**
 * Groups of interchangeable commands. When any command in a group is used but
 * not found, the rule suggests whichever other commands in the group are available.
 */
const commandGroups: CommandAlternative[][] = [
	[
		{ triggers: [ 'pip' ], executable: 'pip', invocation: 'pip' },
		{ triggers: [ 'pip3' ], executable: 'pip3', invocation: 'pip3' },
		{ triggers: [ 'uv' ], executable: 'uv', invocation: 'uv pip' },
	],
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
			for (const alt of group) {
				const triggeredCommand = alt.triggers.find(t => usedCommands.has(t));
				if (!triggeredCommand) {
					continue;
				}

				// eslint-disable-next-line no-await-in-loop
				if (await commandExists(alt.executable)) {
					continue; // Command exists, no issue
				}

				// Find available alternatives from the same group
				const available: string[] = [];
				for (const other of group) {
					if (other.executable === alt.executable) {
						continue;
					}

					// eslint-disable-next-line no-await-in-loop
					if (await commandExists(other.executable)) {
						available.push(other.invocation);
					}
				}

				if (available.length === 0) {
					continue; // No alternatives available, don't block
				}

				return {
					type: 'violation',
					messages: [
						`❌ Command "${triggeredCommand}" not found`,
						`Available alternatives: ${available.join(', ')}`,
					],
				};
			}
		}

		return { type: 'pass' };
	},
};
