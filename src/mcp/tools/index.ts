import type { ZodObject } from 'zod';

export type ToolHandler = {
	definition: {
		name: string;
		description: string;
		inputSchema: ZodObject;
	};
	handle: (args: unknown) => Promise<Array<{ type: 'text'; text: string }>>;
};

export const tools = new Map<string, ToolHandler>();

export function registerTool(handler: ToolHandler) {
	tools.set(handler.definition.name, handler);
}
