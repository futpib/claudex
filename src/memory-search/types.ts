export type SearchTarget = 'user' | 'assistant' | 'bash-command' | 'bash-output' | 'tool-use' | 'tool-result' | 'subagent-prompt';

export type SearchOptions = {
	patterns: RegExp[];
	targets: Set<SearchTarget>;
	projectPath: string;
	sessionId?: string;
	contextBefore: number;
	contextAfter: number;
	maxResults: number;
	maxLineWidth: number;
	jsonOutput: boolean;
};

export type SearchMatch = {
	matchNumber: number;
	sessionId: string;
	timestamp: string;
	target: SearchTarget;
	toolName?: string;
	text: string;
	matchedLines: MatchedLine[];
};

export type MatchedLine = {
	lineNumber: number;
	line: string;
	isMatch: boolean;
};

export type SessionFile = {
	sessionId: string;
	filePath: string;
	mtime: Date;
	isSubagent?: boolean;
};

export type ExtractedContent = {
	target: SearchTarget;
	text: string;
	toolName?: string;
	timestamp: string;
	sessionId: string;
};
