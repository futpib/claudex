/* eslint-disable unicorn/no-process-exit */
import process from 'node:process';
import { getMergedConfig, resolveHooks } from '../config/index.js';
import {
	readStdin, parseJsonWithSchema,
} from './shared.js';
import {
	knownToolInputSchema, preToolUseHookInputSchema,
} from './schemas.js';
import * as helpers from './bash-parser-helpers.js';
import { allRules } from './rules/index.js';

// Skip all checks for read-only tools and internal tools
const readOnlyTools = new Set([ 'Grep', 'LS', 'WebFetch', 'Glob', 'NotebookRead', 'WebSearch', 'BashOutput' ]);
const internalTools = new Set([ 'TodoWrite', 'Task', 'AskUserQuestion' ]);

function handleAskResult(reason: string, permissionMode: string): never {
	if (permissionMode === 'bypassPermissions') {
		console.error(reason);
		process.exit(2);
	}

	const output = {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'ask',
			permissionDecisionReason: reason,
		},
	};
	console.log(JSON.stringify(output));
	process.exit(0);
}

export async function main() {
	const input = await readStdin();

	const preToolUseHookInput = parseJsonWithSchema(input, preToolUseHookInputSchema);

	const knownInput = knownToolInputSchema.safeParse(preToolUseHookInput).data;

	const toolName = preToolUseHookInput.tool_name ?? '';
	const command = knownInput?.tool_name === 'Bash' ? knownInput.tool_input.command : '';
	const sessionId = preToolUseHookInput.session_id ?? '';
	const transcriptPath = preToolUseHookInput.transcript_path ?? '';
	const permissionMode = preToolUseHookInput.permission_mode ?? 'default';
	const isMcpTool = toolName.startsWith('mcp__');

	const { config } = await getMergedConfig(process.cwd());
	const hooks = resolveHooks(config.hooks);

	const context = {
		input: preToolUseHookInput,
		knownInput,
		toolName,
		sessionId,
		transcriptPath,
		command,
		permissionMode,
		cwd: process.cwd(),
		helpers,
		hooks,
	};

	// Rules that run before the read-only/internal/MCP early exit
	for (const rule of allRules) {
		if (rule.meta.phase !== 'pre-exit') {
			continue;
		}

		if (!hooks[rule.meta.configKey]) {
			continue;
		}

		// eslint-disable-next-line no-await-in-loop
		const result = await rule.fn(context);
		if (result.type === 'violation') {
			for (const message of result.messages) {
				console.error(message);
			}

			process.exit(2);
		}

		if (result.type === 'ask') {
			handleAskResult(result.reason, permissionMode);
		}
	}

	// Early exit for read-only, internal, and MCP tools
	if (readOnlyTools.has(toolName) || internalTools.has(toolName) || isMcpTool) {
		process.exit(0);
	}

	// Run all other enabled rules
	for (const rule of allRules) {
		if (rule.meta.phase !== 'main') {
			continue;
		}

		if (!hooks[rule.meta.configKey]) {
			continue;
		}

		// eslint-disable-next-line no-await-in-loop
		const result = await rule.fn(context);

		if (result.type === 'violation') {
			for (const message of result.messages) {
				console.error(message);
			}

			process.exit(2);
		}

		if (result.type === 'ask') {
			handleAskResult(result.reason, permissionMode);
		}
	}

	process.exit(0);
}
