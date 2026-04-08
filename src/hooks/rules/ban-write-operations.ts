import {
	hashAction, hasConfirmation, createConfirmationToken,
	generateShortId, storePendingConfirmation,
} from '../../confirm.js';
import type { Rule, RuleResult } from './index.js';

// Generic write-action words matched against tokenized MCP tool names
export const writeActionWords = new Set([
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

async function requireConfirmation(
	actionIdentity: string,
	description: string,
	context: { sessionId: string; transcriptPath: string; command?: string },
): Promise<RuleResult> {
	const actionHash = hashAction(actionIdentity);

	if (await hasConfirmation(actionHash, context.sessionId)) {
		return { type: 'pass' };
	}

	const token = await createConfirmationToken(
		actionHash,
		`${description} (write operation)`,
		context.transcriptPath,
		context.sessionId,
	);

	const shortId = generateShortId();
	await storePendingConfirmation(shortId, token, context.command);

	return {
		type: 'violation',
		messages: [
			`❌ ${description} (write subcommand) — this is a write operation that acts on behalf of the user`,
			'',
			'Did the user explicitly ask you to perform this action? If yes, confirm with:',
			`  claudex confirm ${shortId} '<proof>' --exec`,
			'',
			'The <proof> must be a VERBATIM quote from the user that SPECIFICALLY',
			'asks for this write operation.',
			'A generic instruction like "implement this feature" is NOT sufficient —',
			'the user must have explicitly asked for this action.',
			'',
			'If the user did not explicitly ask for this, do NOT confirm.',
			'Instead, ask the user whether they want you to proceed.',
		],
	};
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
			return requireConfirmation(context.toolName, mcpMatch, context);
		}

		if (context.toolName !== 'Bash' || !context.command) {
			return { type: 'pass' };
		}

		const bashMatch = await context.helpers.getWriteOperation(context.command);
		if (bashMatch) {
			return requireConfirmation(context.command, bashMatch, context);
		}

		return { type: 'pass' };
	},
};
