import {
	hashAction, hasConfirmation, createConfirmationToken,
	generateShortId, storePendingConfirmation,
} from '../../confirm.js';
import type { Rule, RuleResult } from './index.js';

const gitMutationSubcommands = new Set([
	'commit',
	'push',
	'merge',
	'rebase',
	'tag',
	'reset',
]);

const gitMutationMultiWordSubcommands = [
	'stash drop',
	'branch -d',
	'branch -D',
];

function isGitMutation(command: string): string | undefined {
	const normalized = command.trim();

	if (!normalized.startsWith('git ')) {
		return undefined;
	}

	const rest = normalized.slice(4).trimStart();

	for (const multi of gitMutationMultiWordSubcommands) {
		if (rest.startsWith(multi)) {
			return multi;
		}
	}

	const subcommand = rest.split(/\s/)[0];
	if (subcommand && gitMutationSubcommands.has(subcommand)) {
		return subcommand;
	}

	return undefined;
}

export const requireGitMutationConfirmation: Rule = {
	meta: {
		name: 'require-git-mutation-confirmation',
		configKey: 'requireGitMutationConfirmation',
		recommended: true,
		description: 'Git mutations (commit, push, merge, etc.) require explicit user confirmation',
		phase: 'main',
	},
	async fn(context): Promise<RuleResult> {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const mutation = isGitMutation(context.command);
		if (!mutation) {
			return { type: 'pass' };
		}

		const actionHash = hashAction(context.command);

		if (await hasConfirmation(actionHash, context.sessionId)) {
			return { type: 'pass' };
		}

		const token = await createConfirmationToken(
			actionHash,
			`git ${mutation} (affects repository)`,
			context.transcriptPath,
			context.sessionId,
		);

		const shortId = generateShortId();
		await storePendingConfirmation(shortId, token);

		return {
			type: 'violation',
			messages: [
				`⚠️  This is a git mutation: ${context.command}`,
				`Did the user explicitly ask you to "${mutation}"? If yes, confirm with:`,
				`  claudex confirm ${shortId} '<proof>'`,
				'',
				'The <proof> must be a VERBATIM quote from the user that SPECIFICALLY',
				`mentions "${mutation}" (or a synonym like "push it", "commit this", etc.).`,
				'A generic instruction like "implement this feature" is NOT sufficient —',
				`the user must have explicitly asked to ${mutation}.`,
				'',
				`If the user did not explicitly ask to ${mutation}, do NOT confirm.`,
				'Instead, ask the user whether they want you to proceed.',
			],
		};
	},
};
