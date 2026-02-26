import type { Rule } from './index.js';

export const banYarnCwd: Rule = {
	meta: {
		name: 'ban-yarn-cwd',
		configKey: 'banYarnCwd',
		recommended: true,
		phase: 'main',
		description: 'Do not use yarn --cwd; run yarn commands in the project directory',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const yarnInfo = await context.helpers.getYarnCwdInfo(context.command);
		if (yarnInfo) {
			return {
				type: 'violation',
				messages: [
					'❌ yarn --cwd is not allowed',
					'Running yarn commands with a different working directory is not permitted.',
					'Please change directory first, then run the yarn command:',
					`  Bash(cd ${yarnInfo.path})`,
					`  Bash(${yarnInfo.commandWithout})`,
				],
			};
		}

		if (await context.helpers.hasYarnCwdFlag(context.command)) {
			return {
				type: 'violation',
				messages: [
					'❌ yarn --cwd is not allowed',
					'Running yarn commands with a different working directory is not permitted.',
				],
			};
		}

		return { type: 'pass' };
	},
};
