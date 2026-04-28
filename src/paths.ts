import envPaths from 'env-paths';

type Paths = ReturnType<typeof envPaths>;

function compute(): Paths {
	return envPaths('claudex', { suffix: '' });
}

export const paths: Paths = new Proxy({} as Paths, {
	get(_target, key) {
		return compute()[key as keyof Paths];
	},
});
