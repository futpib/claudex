import type { Rule } from './index.js';

const nudge = 'Ask the user for explicit approval before performing write operations on their behalf.';

// Generic write-action words matched against tokenized MCP tool names
const writeActionWords = new Set([
	'add',
	'append',
	'approve',
	'archive',
	'assign',
	'cancel',
	'close',
	'create',
	'delete',
	'deploy',
	'draft',
	'duplicate',
	'edit',
	'execute',
	'insert',
	'invite',
	'mark',
	'merge',
	'modify',
	'move',
	'patch',
	'post',
	'publish',
	'put',
	'react',
	'reject',
	'remove',
	'rename',
	'revoke',
	'schedule',
	'send',
	'set',
	'submit',
	'trigger',
	'unassign',
	'update',
	'upload',
	'write',
]);

// Split on underscores, hyphens, and camelCase boundaries
function tokenize(name: string): string[] {
	return name.split(/[_-]/).flatMap(part => part.split(/(?<=[a-z])(?=[A-Z])/));
}

function checkMcpTool(toolName: string): string | undefined {
	if (!toolName.startsWith('mcp__')) {
		return undefined;
	}

	const tokens = tokenize(toolName);
	if (tokens.some(token => writeActionWords.has(token.toLowerCase()))) {
		return `MCP write tool: ${toolName}`;
	}

	return undefined;
}

export const banWriteOperations: Rule = {
	meta: {
		name: 'ban-write-operations',
		configKey: 'banWriteOperations',
		recommended: true,
		phase: 'pre-exit',
		description: 'Do not perform write operations (HTTP POST/PUT/PATCH/DELETE, GraphQL mutations, MCP mutations) without explicit user approval',
	},
	async fn(context) {
		const mcpMatch = checkMcpTool(context.toolName);
		if (mcpMatch) {
			return {
				type: 'violation',
				messages: [
					`❌ ${mcpMatch} — this is a write operation that acts on behalf of the user`,
					nudge,
				],
			};
		}

		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const bashMatch = await context.helpers.getWriteOperation(context.command);
		if (bashMatch) {
			return {
				type: 'violation',
				messages: [
					`❌ ${bashMatch} — this is a write operation that acts on behalf of the user`,
					nudge,
				],
			};
		}

		return { type: 'pass' };
	},
};
