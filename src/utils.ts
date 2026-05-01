import os from 'node:os';
import path from 'node:path';

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

export function expandTilde(filePath: string): string {
	if (filePath.startsWith('~/')) {
		return path.join(os.homedir(), filePath.slice(2));
	}

	return filePath;
}

export function parseJson(text: string): unknown {
	return JSON.parse(text);
}

export function collapseHomedir(value: string): string {
	const home = os.homedir();
	if (value === home || value.startsWith(home + '/')) {
		return '~' + value.slice(home.length);
	}

	return value;
}

// Strip trailing slashes (except for root "/") so two paths that differ only
// by a trailing slash compare equal.
function normalizeMountPath(value: string): string {
	if (value === '/') {
		return value;
	}

	return value.replace(/\/+$/, '');
}

export type SubsumingPaths = {
	ancestor: string;
	descendants: string[];
};

// Find paths in `paths` that are strict ancestors of other paths in the same
// list. Returns one entry per ancestor with all of its descendants. Useful for
// detecting redundant bind mounts: mounting "/home/x" alongside
// "/home/x/foo" makes the second mount mostly meaningless.
export function findSubsumingPaths(paths: string[]): SubsumingPaths[] {
	const normalized = [ ...new Set(paths.map(p => normalizeMountPath(p))) ];

	const ancestors = new Map<string, string[]>();
	for (const a of normalized) {
		const prefix = a === '/' ? '/' : a + '/';
		for (const b of normalized) {
			if (a === b) {
				continue;
			}

			if (b.startsWith(prefix)) {
				const list = ancestors.get(a);
				if (list) {
					list.push(b);
				} else {
					ancestors.set(a, [ b ]);
				}
			}
		}
	}

	return [ ...ancestors.entries() ]
		.map(([ ancestor, descendants ]) => ({ ancestor, descendants: descendants.sort((x, y) => x.localeCompare(y)) }))
		.sort((x, y) => x.ancestor.localeCompare(y.ancestor));
}
