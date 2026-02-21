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
