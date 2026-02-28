/* eslint-disable @typescript-eslint/naming-convention */

import { z } from 'zod';

export const editToolInputSchema = z.object({
	file_path: z.string(),
	old_string: z.string(),
	new_string: z.string(),
	replace_all: z.boolean().optional(),
});

export const multiEditToolInputSchema = z.object({
	file_path: z.string(),
	edits: z.array(z.object({
		old_string: z.string(),
		new_string: z.string(),
		replace_all: z.boolean().optional(),
	})),
});

export const writeToolInputSchema = z.object({
	file_path: z.string(),
	content: z.string(),
});

export const bashToolInputSchema = z.object({
	command: z.string(),
	description: z.string().optional(),
	timeout: z.number().optional(),
	run_in_background: z.boolean().optional(),
});

export const readToolInputSchema = z.object({
	file_path: z.string(),
	offset: z.number().optional(),
	limit: z.number().optional(),
});

export const grepToolInputSchema = z.object({
	pattern: z.string(),
	path: z.string().optional(),
	output_mode: z.string().optional(),
	glob: z.string().optional(),
	type: z.string().optional(),
	head_limit: z.number().optional(),
	multiline: z.boolean().optional(),
	'-A': z.number().optional(),
	'-B': z.number().optional(),
	'-C': z.number().optional(),
	'-i': z.boolean().optional(),
	'-n': z.boolean().optional(),
});

export const exitPlanModeToolInputSchema = z.object({
	plan: z.string(),
});

export const lsToolInputSchema = z.object({
	path: z.string(),
	ignore: z.array(z.string()).optional(),
});

export const webFetchToolInputSchema = z.object({
	url: z.string(),
	prompt: z.string(),
});

export const globToolInputSchema = z.object({
	pattern: z.string(),
	path: z.string().optional(),
});

export const notebookReadToolInputSchema = z.object({
	notebook_path: z.string(),
	cell_id: z.string().optional(),
});

export const notebookEditToolInputSchema = z.object({
	notebook_path: z.string(),
	new_source: z.string(),
	cell_id: z.string().optional(),
	cell_type: z.string().optional(),
	edit_mode: z.string().optional(),
});

export const webSearchToolInputSchema = z.object({
	query: z.string(),
	allowed_domains: z.array(z.string()).optional(),
	blocked_domains: z.array(z.string()).optional(),
});

export const bashOutputToolInputSchema = z.object({
	bash_id: z.string(),
	filter: z.string().optional(),
});

export const killBashToolInputSchema = z.object({
	shell_id: z.string(),
});

export const baseToolInputSchema = z.object({
	session_id: z.string(),
	transcript_path: z.string().optional(),
});

export const knownToolInputSchema = z.union([
	z.object({ tool_name: z.literal('Edit'), tool_input: editToolInputSchema }),
	z.object({ tool_name: z.literal('MultiEdit'), tool_input: multiEditToolInputSchema }),
	z.object({ tool_name: z.literal('Write'), tool_input: writeToolInputSchema }),
	z.object({ tool_name: z.literal('Bash'), tool_input: bashToolInputSchema }),
	z.object({ tool_name: z.literal('Read'), tool_input: readToolInputSchema }),
	z.object({ tool_name: z.literal('Grep'), tool_input: grepToolInputSchema }),
	z.object({ tool_name: z.literal('ExitPlanMode'), tool_input: exitPlanModeToolInputSchema }),
	z.object({ tool_name: z.literal('LS'), tool_input: lsToolInputSchema }),
	z.object({ tool_name: z.literal('WebFetch'), tool_input: webFetchToolInputSchema }),
	z.object({ tool_name: z.literal('Glob'), tool_input: globToolInputSchema }),
	z.object({ tool_name: z.literal('NotebookRead'), tool_input: notebookReadToolInputSchema }),
	z.object({ tool_name: z.literal('NotebookEdit'), tool_input: notebookEditToolInputSchema }),
	z.object({ tool_name: z.literal('WebSearch'), tool_input: webSearchToolInputSchema }),
	z.object({ tool_name: z.literal('BashOutput'), tool_input: bashOutputToolInputSchema }),
	z.object({ tool_name: z.literal('KillBash'), tool_input: killBashToolInputSchema }),
]);

export const unknownToolInputSchema = z.object({
	tool_name: z.string(),
	tool_input: z.unknown(),
});

export const preToolUseHookInputSchema = baseToolInputSchema.and(z.union([ knownToolInputSchema, unknownToolInputSchema ]));

export type KnownToolInput = z.infer<typeof knownToolInputSchema>;
export type PreToolUseHookInput = z.infer<typeof preToolUseHookInputSchema>;
