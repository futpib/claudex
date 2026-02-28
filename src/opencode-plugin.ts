/* eslint-disable @typescript-eslint/naming-convention */

// OpenCode plugin for claudex — bridges OpenCode hooks to claudex hook executables
import process from 'node:process';
import { execa } from 'execa';

const toolNameMap: Record<string, string> = {
	bash: 'Bash',
	read: 'Read',
	write: 'Write',
	edit: 'Edit',
	multiedit: 'MultiEdit',
	grep: 'Grep',
	glob: 'Glob',
	webfetch: 'WebFetch',
	websearch: 'WebSearch',
	list: 'LS',
	todowrite: 'TodoWrite',
	task: 'Task',
	question: 'AskUserQuestion',
};

const argFieldMap: Record<string, Record<string, string>> = {
	read: {
		filePath: 'file_path',
	},
	write: {
		filePath: 'file_path',
		content: 'content',
	},
	edit: {
		filePath: 'file_path',
		oldString: 'old_string',
		newString: 'new_string',
		replaceAll: 'replace_all',
	},
	bash: {
		command: 'command',
		description: 'description',
		timeout: 'timeout',
	},
	grep: {
		pattern: 'pattern',
		path: 'path',
		include: 'glob',
	},
	glob: {
		pattern: 'pattern',
		path: 'path',
	},
	webfetch: {
		url: 'url',
		format: 'prompt',
	},
	websearch: {
		query: 'query',
	},
};

function mapArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
	const mapping = argFieldMap[toolName];
	if (!mapping) {
		return args;
	}

	const mapped: Record<string, unknown> = {};
	for (const [ key, value ] of Object.entries(args)) {
		mapped[mapping[key] ?? key] = value;
	}

	return mapped;
}

type ToolExecuteBeforeInput = {
	tool: string;
	sessionID: string;
	callID: string;
};

type ToolExecuteBeforeOutput = {
	args: Record<string, unknown>;
};

type ChatMessageInput = {
	sessionID: string;
};

type Part = {
	type: string;
	text?: string;
	synthetic?: boolean;
};

type ChatMessageOutput = {
	parts: Part[];
};

export const ClaudexPlugin = async () => ({
	async 'tool.execute.before'(input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) {
		const claudeName = toolNameMap[input.tool] ?? input.tool;
		const claudeArgs = mapArgs(input.tool, output.args);

		const hookInput = JSON.stringify({
			tool_name: claudeName,
			tool_input: claudeArgs,
			session_id: input.sessionID ?? '',
		});

		try {
			await execa('claudex-hook-pre-tool-use', { input: hookInput, timeout: 10_000 });
		} catch (error) {
			const { exitCode, stderr } = error as { exitCode?: number; stderr?: string };
			if (exitCode === 2) {
				throw new Error('Blocked by claudex hook: ' + (stderr ?? 'tool call rejected'));
			}

			console.error('[claudex] hook error:', stderr ?? (error as Error).message ?? error);
		}
	},
	async event(input: { event: { type: string; properties?: { sessionID?: string } } }) {
		if (input.event.type !== 'session.idle') {
			return;
		}

		const hookInput = JSON.stringify({
			session_id: input.event.properties?.sessionID ?? '',
			hook_event_name: 'Stop',
		});

		try {
			await execa('claudex-hook-stop', { input: hookInput, timeout: 10_000 });
		} catch (error) {
			const { stderr } = error as { stderr?: string };
			console.error('[claudex] stop hook error:', stderr ?? (error as Error).message ?? error);
		}
	},
	async 'chat.message'(input: ChatMessageInput, output: ChatMessageOutput) {
		const prompt = (output.parts ?? [])
			.filter(p => p.type === 'text' && !p.synthetic)
			.map(p => p.text)
			.join('\n');

		if (!prompt) {
			return;
		}

		const hookInput = JSON.stringify({
			session_id: input.sessionID ?? '',
			cwd: process.cwd(),
			hook_event_name: 'UserPromptSubmit',
			prompt,
		});

		try {
			await execa('claudex-hook-user-prompt-submit', { input: hookInput, timeout: 10_000 });
		} catch (error) {
			const { stderr } = error as { stderr?: string };
			console.error('[claudex] user-prompt-submit hook error:', stderr ?? (error as Error).message ?? error);
		}
	},
});
