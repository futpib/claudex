import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../../paths.js';
import type { Rule, RuleResult } from './index.js';

export const requireCoAuthorshipProof: Rule = {
	name: 'require-co-authorship-proof',
	async fn(context): Promise<RuleResult> {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (!(context.command.toLowerCase().includes('git commit') && context.command.toLowerCase().includes('co-authored-by'))) {
			return { type: 'pass' };
		}

		const markerPattern = /x-claude-code-co-authorship-proof:\s*([a-f\d]{64})/i;
		const match = markerPattern.exec(context.command);
		if (match) {
			const submittedPin = match[1];
			const proofsDir = path.join(paths.data, 'co-authorship-proofs');
			const proofFile = path.join(proofsDir, `${submittedPin}.json`);

			try {
				await fs.access(proofFile);
				return { type: 'pass' };
			} catch {
				return {
					type: 'violation',
					messages: [
						`❌ Invalid co-authorship proof PIN: ${submittedPin}`,
						'The provided PIN does not correspond to a valid proof submission.',
					],
				};
			}
		}

		return {
			type: 'violation',
			messages: [
				'⚠️  This commit includes co-authorship. Claude Code must:',
				'1. FIRST run \'git diff --cached\' to see what changes are being committed',
				'2. ACTUALLY check the session transcript - did Claude Code make these specific changes?',
				'3. If Claude Code genuinely co-authored, submit proof with:',
				'   claudex-submit-co-authorship-proof "Claude Code made changes X, Y, Z in this session"',
				'4. Add the returned PIN right after the Co-authored-by line:',
				'   Co-authored-by: Claude <claude@anthropic.com>',
				'   x-claude-code-co-authorship-proof: <PIN-FROM-SUBMIT-PROOF>',
				'5. If Claude Code did NOT make these changes, remove Co-authored-by and try again.',
			],
		};
	},
};
