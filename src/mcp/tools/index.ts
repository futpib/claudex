import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type ToolHandler = {
	definition: Tool;
	handle: (args: unknown) => Promise<Array<{ type: 'text'; text: string }>>;
};

export const tools: Map<string, ToolHandler> = new Map();

export function registerTool(handler: ToolHandler) {
	tools.set(handler.definition.name, handler);
}
