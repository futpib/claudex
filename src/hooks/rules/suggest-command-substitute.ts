import process from 'node:process';
import path from 'node:path';
import { access, constants } from 'node:fs/promises';
import type { Rule } from './index.js';

type CommandSubstitution = {
	/** Commands that may be unavailable and should be substituted */
	commands: string[];
	/** The substitute command to check for */
	substitute: string;
	/** Human-readable description of the substitute */
	substituteDescription: string;
	/** How to map the original command invocation to the substitute */
	getSubstituteHint: (originalCommand: string) => string;
};

const commandSubstitutions: CommandSubstitution[] = [
	{
		commands: [ 'pip', 'pip3' ],
		substitute: 'uv',
		substituteDescription: 'uv (a fast Python package manager)',
		getSubstituteHint: _originalCommand => 'uv pip',
	},
];

async function commandExists(cmd: string): Promise<boolean> {
	const pathEnv = process.env.PATH ?? '';
	const dirs = pathEnv.split(path.delimiter);

	for (const dir of dirs) {
		if (!dir) {
			continue;
		}

		try {
			// eslint-disable-next-line no-await-in-loop
			await access(path.join(dir, cmd), constants.X_OK);
			return true;
		} catch {
			// Not in this directory, continue searching
		}
	}

	return false;
}

export const suggestCommandSubstitute: Rule = {
	meta: {
		name: 'suggest-command-substitute',
		configKey: 'suggestCommandSubstitute',
		recommended: true,
		phase: 'main',
		description: 'When a command does not exist but a substitute is available, suggest the substitute',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const usedCommands = await context.helpers.extractCommandNames(context.command);

		for (const substitution of commandSubstitutions) {
			for (const cmd of substitution.commands) {
				if (!usedCommands.has(cmd)) {
					continue;
				}

				// eslint-disable-next-line no-await-in-loop
				const [ originalExists, substituteExists ] = await Promise.all([
					commandExists(cmd),
					commandExists(substitution.substitute),
				]);

				if (!originalExists && substituteExists) {
					const hint = substitution.getSubstituteHint(cmd);
					return {
						type: 'violation',
						messages: [
							`❌ Command "${cmd}" not found, but ${substitution.substituteDescription} is available`,
							`Use "${hint}" instead of "${cmd}".`,
						],
					};
				}
			}
		}

		return { type: 'pass' };
	},
};
