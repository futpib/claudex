import test from 'ava';
import { builtinLauncherDefinitions } from './index.js';

test('builtinLauncherDefinitions includes claude and ollama', t => {
	t.truthy(builtinLauncherDefinitions.claude);
	t.deepEqual(builtinLauncherDefinitions.claude.command, [ 'claude' ]);

	t.truthy(builtinLauncherDefinitions.ollama);
	t.deepEqual(builtinLauncherDefinitions.ollama.command, [ 'ollama', 'launch', 'claude' ]);
	t.deepEqual(builtinLauncherDefinitions.ollama.packages, [ 'ollama' ]);
	t.deepEqual(builtinLauncherDefinitions.ollama.hostPorts, [ 11_434 ]);
});
