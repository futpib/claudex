import type { Rule } from './index.js';

export const banCargoManifestPath: Rule = {
	meta: {
		name: 'ban-cargo-manifest-path',
		configKey: 'banCargoManifestPath',
		recommended: true,
		phase: 'main',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		if (await context.helpers.hasCargoManifestPathFlag(context.command)) {
			return {
				type: 'violation',
				messages: [
					'❌ cargo --manifest-path is not allowed',
					'Running cargo commands with a different manifest path is not permitted.',
					'Please cd to the target directory and run cargo commands there instead.',
				],
			};
		}

		return { type: 'pass' };
	},
};
