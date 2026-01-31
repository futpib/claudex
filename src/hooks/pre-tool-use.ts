#!/usr/bin/env node

import process from 'node:process';
import { getMergedConfig, resolveHooks } from '../config.js';
import {
	readStdin, parseJsonWithSchema,
} from './shared.js';
import {
	knownToolInputSchema, preToolUseHookInputSchema,
} from './schemas.js';
import * as helpers from './bash-parser-helpers.js';
import { createRuleRegistry } from './rules/index.js';

// Skip all checks for read-only tools and internal tools
// eslint-disable-next-line @typescript-eslint/naming-convention
const READ_ONLY_TOOLS = new Set([ 'Grep', 'LS', 'WebFetch', 'Glob', 'NotebookRead', 'WebSearch', 'BashOutput' ]);
// eslint-disable-next-line @typescript-eslint/naming-convention
const INTERNAL_TOOLS = new Set([ 'TodoWrite', 'Task', 'AskUserQuestion' ]);

async function main() {
	const input = await readStdin();

	const preToolUseHookInput = parseJsonWithSchema(input, preToolUseHookInputSchema);

	const knownInput = knownToolInputSchema.safeParse(preToolUseHookInput).data;

	const toolName = preToolUseHookInput.tool_name ?? '';
	const command = knownInput?.tool_name === 'Bash' ? knownInput.tool_input.command : '';
	const sessionId = preToolUseHookInput.session_id ?? '';
	const transcriptPath = preToolUseHookInput.transcript_path ?? '';
	const isMcpTool = toolName.startsWith('mcp__');

	const { config } = await getMergedConfig(process.cwd());
	const hooks = resolveHooks(config.hooks);

	const registry = createRuleRegistry();

	const context = {
		input: preToolUseHookInput,
		knownInput,
		toolName,
		sessionId,
		transcriptPath,
		command,
		cwd: process.cwd(),
		helpers,
	};

	// Rules that run before the read-only/internal/MCP early exit
	const preExitRules: Array<keyof typeof hooks> = [ 'banOutdatedYearInSearch', 'logToolUse' ];

	for (const flag of preExitRules) {
		if (!hooks[flag]) {
			continue;
		}

		const rule = registry.get(flag);
		if (rule) {
			// eslint-disable-next-line no-await-in-loop
			const result = await rule.fn(context);
			if (result.type === 'violation') {
				for (const message of result.messages) {
					console.error(message);
				}

				process.exit(2);
			}
		}
	}

	// Early exit for read-only, internal, and MCP tools
	if (READ_ONLY_TOOLS.has(toolName) || INTERNAL_TOOLS.has(toolName) || isMcpTool) {
		process.exit(0);
	}

	// Run all other enabled rules

	for (const [ flag, rule ] of registry) {
		if (preExitRules.includes(flag)) {
			continue;
		}

		if (!hooks[flag]) {
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
	}

	process.exit(0);
}

await main();
