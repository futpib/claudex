import { formatTranscriptInfo, logMessage } from '../shared.js';
import type { KnownToolInput } from '../schemas.js';
import type { Rule } from './index.js';

// Skip logging for read-only tools and internal tools
const readOnlyTools = new Set([ 'Grep', 'LS', 'WebFetch', 'Glob', 'NotebookRead', 'WebSearch', 'BashOutput' ]);
const internalTools = new Set([ 'TodoWrite', 'Task', 'AskUserQuestion' ]);

function omitLongFields(input: KnownToolInput): unknown {
	if (input.tool_name === 'Edit') {
		const { old_string: _oldString, new_string: _newString, ...rest } = input.tool_input;
		return rest;
	}

	if (input.tool_name === 'MultiEdit') {
		const { edits, ...rest } = input.tool_input;
		return rest;
	}

	if (input.tool_name === 'Write') {
		const { content, ...rest } = input.tool_input;
		return rest;
	}

	return input.tool_input;
}

export const logToolUse: Rule = {
	name: 'log-tool-use',
	async fn(context) {
		const isMcpTool = context.toolName.startsWith('mcp__');

		if (readOnlyTools.has(context.toolName) || internalTools.has(context.toolName) || isMcpTool) {
			return { type: 'pass' };
		}

		const filteredInput = context.knownInput ? omitLongFields(context.knownInput) : context.input.tool_input;

		const toolInputString = JSON.stringify(filteredInput);
		const transcriptInfo = formatTranscriptInfo(context.sessionId, context.transcriptPath);
		const message = `Session: ${context.sessionId}${transcriptInfo}, Tool: ${context.toolName}, Input: ${toolInputString}`;
		await logMessage(message);

		return { type: 'side-effect' };
	},
};
