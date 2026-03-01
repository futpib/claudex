import { execa } from 'execa';
import type { Rule } from './index.js';

function normalizeGitUrl(url: string): { protocol: 'ssh' | 'https' | 'other'; canonical: string } | undefined {
	// SSH: git@host:owner/repo.git
	const sshMatch = /^git@([^:]+):(.+)$/.exec(url);
	if (sshMatch) {
		const host = sshMatch[1];
		const path = sshMatch[2]?.replace(/\.git$/, '');
		return { protocol: 'ssh', canonical: `${host}/${path}` };
	}

	// HTTPS: https://host/owner/repo.git
	const httpsMatch = /^https?:\/\/([^/]+)\/(.+)$/.exec(url);
	if (httpsMatch) {
		const host = httpsMatch[1];
		const path = httpsMatch[2]?.replace(/\.git$/, '');
		return { protocol: 'https', canonical: `${host}/${path}` };
	}

	return undefined;
}

export const banGitRemoteSetUrl: Rule = {
	meta: {
		name: 'ban-git-remote-set-url',
		configKey: 'banGitRemoteSetUrl',
		recommended: true,
		phase: 'main',
		description: 'Do not change git remote URL from SSH to HTTPS; keep the existing protocol',
	},
	async fn(context) {
		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		// Match: git remote set-url <name> <url>
		const match = /\bgit\s+remote\s+set-url\s+(\S+)\s+(\S+)/.exec(context.command);
		if (!match) {
			return { type: 'pass' };
		}

		const remoteName = match[1];
		const newUrl = match[2];

		if (!remoteName || !newUrl) {
			return { type: 'pass' };
		}

		const parsed = normalizeGitUrl(newUrl);
		if (!parsed || parsed.protocol !== 'https') {
			return { type: 'pass' };
		}

		try {
			const result = await execa('git', [ 'remote', 'get-url', remoteName ], { cwd: context.cwd });
			const currentUrl = result.stdout.trim();

			const currentParsed = normalizeGitUrl(currentUrl);
			if (!currentParsed) {
				return { type: 'pass' };
			}

			if (currentParsed.protocol === 'ssh' && currentParsed.canonical === parsed.canonical) {
				return {
					type: 'violation',
					messages: [
						'❌ Changing git remote URL from SSH to HTTPS is not allowed',
						`The remote "${remoteName}" is already configured with SSH: ${currentUrl}`,
						'Switching to HTTPS would break SSH key authentication.',
						'Keep the existing SSH URL.',
					],
				};
			}
		} catch {
			// Remote doesn't exist or git command failed, skip check
		}

		return { type: 'pass' };
	},
};
