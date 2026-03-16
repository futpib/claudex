import {
	hashAction, hasConfirmation, createConfirmationToken,
	generateShortId, storePendingConfirmation,
} from '../../confirm.js';
import type { Rule, RuleResult } from './index.js';

export const requireCoAuthorshipProof: Rule = {
	meta: {
		name: 'require-co-authorship-proof',
		configKey: 'requireCoAuthorshipProof',
		recommended: false,
		description: 'Commits with co-authorship require proof of human review before committing',
		phase: 'main',
	},
	async fn(context): Promise<RuleResult> {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (!(context.command.toLowerCase().includes('git commit') && context.command.toLowerCase().includes('co-authored-by'))) {
			return { type: 'pass' };
		}

		const actionHash = hashAction(context.command);

		if (await hasConfirmation(actionHash, context.sessionId)) {
			return { type: 'pass' };
		}

		const token = await createConfirmationToken(
			actionHash,
			'git commit with Co-authored-by (requires co-authorship justification)',
			context.transcriptPath,
			context.sessionId,
		);

		const shortId = generateShortId();
		await storePendingConfirmation(shortId, token);

		return {
			type: 'violation',
			messages: [
				'⚠️  This commit includes co-authorship. Claude Code must:',
				'1. FIRST run \'git diff --cached\' to see what changes are being committed',
				'2. ACTUALLY check the session transcript - did Claude Code make these specific changes?',
				'3. If Claude Code genuinely co-authored, confirm with:',
				`   claudex confirm ${shortId} '<describe what Claude Code changed in this session>'`,
				'4. If Claude Code did NOT make these changes, remove Co-authored-by and try again.',
			],
		};
	},
};
