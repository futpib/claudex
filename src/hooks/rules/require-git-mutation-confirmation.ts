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
]);

const gitMutationMultiWordSubcommands = [
	'stash drop',
	'branch -d',
	'branch -D',
];

/**
 * `git reset -- <paths>` only unstages files — it never moves HEAD or
 * discards working-tree changes, so it is safe to run without confirmation.
 *
 * We treat a reset as safe (path-only) when:
 *   1. It contains a bare `--` separator (everything after is paths), AND
 *   2. It has no mode flags that would make it a commit reset.
 *
 * Any other `git reset` (with --hard, --soft, --mixed, --merge, --keep,
 * or without `--`) is treated as a mutation that requires confirmation.
 */
function isSafeGitReset(args: string): boolean {
	const parts = args.split(/\s+/);

	const modeFlags = new Set([ '--hard', '--soft', '--mixed', '--merge', '--keep' ]);
	for (const part of parts) {
		if (modeFlags.has(part)) {
			return false;
		}
	}

	return parts.includes('--');
}

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

	if (subcommand === 'reset') {
		const resetArgs = rest.slice('reset'.length).trimStart();
		if (isSafeGitReset(resetArgs)) {
			return undefined;
		}

		return 'reset';
	}

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
