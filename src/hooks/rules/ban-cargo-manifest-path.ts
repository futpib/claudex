import type { Rule } from './index.js';

export const banCargoManifestPath: Rule = {
	meta: {
		name: 'ban-cargo-manifest-path',
		configKey: 'banCargoManifestPath',
		recommended: true,
		phase: 'main',
		description: 'Do not use cargo --manifest-path; run cargo commands in the project directory',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const cargoInfo = await context.helpers.getCargoManifestPathInfo(context.command);
		if (cargoInfo) {
			return {
				type: 'violation',
				messages: [
					'❌ cargo --manifest-path is not allowed',
					'Running cargo commands with a different manifest path is not permitted.',
					'Please change directory first, then run the cargo command:',
					`  Bash(cd ${cargoInfo.path})`,
					`  Bash(${cargoInfo.commandWithout})`,
				],
			};
		}

		if (await context.helpers.hasCargoManifestPathFlag(context.command)) {
			return {
				type: 'violation',
				messages: [
					'❌ cargo --manifest-path is not allowed',
					'Running cargo commands with a different manifest path is not permitted.',
				],
			};
		}

		return { type: 'pass' };
	},
};
