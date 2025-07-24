import os from 'node:os';
import { execa } from 'execa';
import { z } from 'zod';
import invariant from 'invariant';

const CLAUDE_CODE_PACKAGE_NAME = '@anthropic-ai/claude-code';

const yarnInspectSchema = z.object({
	type: z.literal('inspect'),
	data: z.string(),
});

const yarnInfoSchema = z.object({
	type: z.literal('info'),
	data: z.string(),
});

async function execaYarnHome(...args: string[]) {
	await execa('yarn', args, {
		cwd: os.homedir(),
		stdio: 'inherit',
	});
}

async function execaYarnHomeJson<T>(...args: string[]): Promise<T> {
	const result = await execa('yarn', [ '--json', ...args ], {
		cwd: os.homedir(),
	});

	return JSON.parse(result.stdout);
}

async function execaYarnHomeJsonLines<T>(...args: string[]): Promise<T[]> {
	const result = await execa('yarn', [ '--json', ...args ], {
		cwd: os.homedir(),
	});

	return result.stdout.split('\n').map(line => JSON.parse(line));
}

export async function checkForClaudeCodeUpdate() {
	const globalListRaw = await execaYarnHomeJsonLines('global', 'list');
	const infoVersionRaw = await execaYarnHomeJson('info', CLAUDE_CODE_PACKAGE_NAME, 'version');

	const globalListEntry = (
		globalListRaw
			.flatMap(entry => {
				const safeParseResult = yarnInfoSchema.safeParse(entry);

				if (!safeParseResult.success) {
					return [];
				}

				return [ safeParseResult.data ];
			})
			.find(entry => entry.data.includes(CLAUDE_CODE_PACKAGE_NAME))
	);

	const infoVersion = yarnInspectSchema.parse(infoVersionRaw);

	invariant(globalListEntry, `Could not find global list entry for ${CLAUDE_CODE_PACKAGE_NAME}`);

	const [ _, packageSpec ] = globalListEntry.data.split('"');
	const packageVersion = packageSpec.split('@').at(-1);

	if (packageVersion === infoVersion.data) {
		return;
	}

	await execaYarnHome('global', 'upgrade', '--latest', '@anthropic-ai/claude-code');
}
