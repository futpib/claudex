export type SearchTarget = 'user' | 'assistant' | 'bash-command' | 'bash-output' | 'tool-use' | 'tool-result' | 'subagent-prompt' | 'compact-summary';

export type ExtractedContent = {
	target: SearchTarget;
	text: string;
	toolName?: string;
	timestamp: string;
	sessionId: string;
};
