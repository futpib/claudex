import { execa } from 'execa';
import type { Rule } from './index.js';

export const banGitCheckoutRedundantStartPoint: Rule = {
	name: 'ban-git-checkout-redundant-start-point',
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const startPoint = await context.helpers.getGitCheckoutBStartPoint(context.command);
		if (!startPoint) {
			return { type: 'pass' };
		}

		try {
			// Check if HEAD is detached (symbolic-ref fails when detached)
			await execa('git', [ 'symbolic-ref', '-q', 'HEAD' ]);
		} catch {
			// HEAD is detached, check if start-point matches current HEAD
			try {
				const [ headResult, startPointResult ] = await Promise.all([
					execa('git', [ 'rev-parse', 'HEAD' ]),
					execa('git', [ 'rev-parse', startPoint ]),
				]);
				if (headResult.stdout.trim() === startPointResult.stdout.trim()) {
					return {
						type: 'violation',
						messages: [
							'❌ Unnecessary start-point in git checkout -b',
							`You are already on a detached HEAD at ${startPoint}.`,
							'Just use: git checkout -b <branch-name>',
							`Instead of: git checkout -b <branch-name> ${startPoint}`,
						],
					};
				}
			} catch {
				// If rev-parse fails, skip this check
			}
		}

		return { type: 'pass' };
	},
};
