import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collapseHomedir } from '../../utils.js';
import type { Rule } from './index.js';

const githubUrlPatterns = [
	// Raw.githubusercontent.com/{owner}/{repo}/...
	/^https?:\/\/raw\.githubusercontent\.com\/[^/]+\/([^/]+)\//,
	// Github.com/{owner}/{repo}/blob/...
	/^https?:\/\/github\.com\/[^/]+\/([^/]+)\/blob\//,
	// Github.com/{owner}/{repo}/tree/...
	/^https?:\/\/github\.com\/[^/]+\/([^/]+)\/tree\//,
];

function extractRepoName(url: string): string | undefined {
	for (const pattern of githubUrlPatterns) {
		const match = pattern.exec(url);
		if (match) {
			return match[1];
		}
	}

	return undefined;
}

export const preferLocalGithubRepo: Rule = {
	meta: {
		name: 'prefer-local-github-repo',
		configKey: 'preferLocalGithubRepo',
		recommended: true,
		phase: 'pre-exit',
		description: 'Do not fetch files from GitHub when the repo is cloned locally as a sibling directory',
	},
	fn(context) {
		if (context.knownInput?.tool_name !== 'WebFetch') {
			return { type: 'pass' };
		}

		const { url } = context.knownInput.tool_input;
		const repoName = extractRepoName(url);
		if (!repoName) {
			return { type: 'pass' };
		}

		const siblingDir = join(dirname(context.cwd), repoName);
		if (!existsSync(siblingDir) || !existsSync(join(siblingDir, '.git'))) {
			return { type: 'pass' };
		}

		return {
			type: 'violation',
			messages: [
				`❌ The repository "${repoName}" is cloned locally at ${collapseHomedir(siblingDir)}`,
				'Read the files directly from the local directory instead of fetching from GitHub.',
			],
		};
	},
};
