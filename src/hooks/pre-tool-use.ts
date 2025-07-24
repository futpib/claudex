#!/usr/bin/env node

import process from 'node:process';
import { readStdin, formatTranscriptInfo, logMessage } from './shared.js';

type EditToolInput = {
	file_path: string;
	old_string: string;
	new_string: string;
	replace_all?: boolean;
};

type MultiEditToolInput = {
	file_path: string;
	edits: Array<{
		old_string: string;
		new_string: string;
		replace_all?: boolean;
	}>;
};

type WriteToolInput = {
	file_path: string;
	content: string;
};

type BashToolInput = {
	command: string;
	description?: string;
	timeout?: number;
};

type BaseToolInput = {
	session_id: string;
	transcript_path: string;
};

type ToolInput = BaseToolInput & (
	| { tool_name: 'Edit'; tool_input: EditToolInput }
	| { tool_name: 'MultiEdit'; tool_input: MultiEditToolInput }
	| { tool_name: 'Write'; tool_input: WriteToolInput }
	| { tool_name: 'Bash'; tool_input: BashToolInput }
	| { tool_name: string; tool_input: Record<string, any> }
);

async function main() {
	const input = await readStdin();
	const toolInput: ToolInput = JSON.parse(input);
	const toolName = toolInput.tool_name || '';
	const command = (toolInput as any).tool_input?.command || '';
	const sessionId = toolInput.session_id || '';
	const transcriptPath = toolInput.transcript_path || '';

	if (toolName === 'TodoWrite' || toolName === 'Task') {
		process.exit(0);
	}

	try {
		const filteredInput = omitLongFields(toolInput);
		const logInput = filteredInput.tool_input;

		const toolInputString = JSON.stringify(logInput);
		const transcriptInfo = formatTranscriptInfo(sessionId, transcriptPath);
		const message = `Session: ${sessionId}${transcriptInfo}, Tool: ${toolName}, Input: ${toolInputString}`;
		await logMessage(message);
	} catch {}

	if (toolName === 'Bash' && command.toLowerCase().includes('git commit') && command.toLowerCase().includes('co-authored-by')) {
		const markerPattern = /x-claude-code-actually-co-authored:\s*\d{4}/i;
		if (markerPattern.test(command)) {
			process.exit(0);
		} else {
			const pin = Math.floor(1000 + Math.random() * 9000);
			console.error('⚠️  This commit includes co-authorship. Claude Code should:');
			console.error('1. Review the staged changes with \'git diff --cached -ub\'');
			console.error('2. Check the session history to verify if you made these changes');
			console.error('3. If you did co-author, add the following to the end of your commit message:');
			console.error(`   x-claude-code-actually-co-authored: ${pin}`);
			console.error('4. If not, remove the Co-authored-by line and try again.');
			process.exit(2);
		}
	}

	process.exit(0);
}

function omitLongFields(input: ToolInput): ToolInput {
	if (input.tool_name === 'Edit') {
		return {
			...input,
			tool_input: {
				...input.tool_input,
				old_string: '__OMITTED__',
				new_string: '__OMITTED__',
			},
		} as any;
	}

	if (input.tool_name === 'MultiEdit') {
		return {
			...input,
			tool_input: {
				...input.tool_input,
				edits: '__OMITTED__',
			},
		} as any;
	}

	if (input.tool_name === 'Write') {
		return {
			...input,
			tool_input: {
				...input.tool_input,
				content: '__OMITTED__',
			},
		} as any;
	}

	return input;
}

main().catch(error => {
	console.error('Error in pre-tool-use hook:', error);
	process.exit(1);
});
