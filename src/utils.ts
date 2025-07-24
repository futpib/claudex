export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

export function parseJson(text: string): unknown {
	return JSON.parse(text);
}
