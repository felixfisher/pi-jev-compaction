export const JEV_COMPACTION_KIND = "pi-jev-compaction";
export const JEV_COMPACTION_SCHEMA_VERSION = 1;
export const JEV_COMPACTION_MARKER_PREFIX = "<!-- pi-jev-compaction:v1";

export type PrivacyMode = "off" | "balanced" | "strict";
export type CompactionAction = "keep" | "truncate_result" | "drop_call" | "protected";

export interface JevCompactionConfig {
  enabled: boolean;
  model: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  truncateHeadChars: number;
  truncateTailChars: number;
  minReductionRatio: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  timeoutMs: number;
  maxRetries: number;
  protectTools: string[];
  protectErrors: boolean;
  privacyMode: PrivacyMode;
  targetReplayTokens: number;
  maxReplayTokens: number;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type UserContent = string | Array<TextContent | ImageContent>;
export type AssistantContent = Array<TextContent | ThinkingContent | ToolCallContent>;
export type ToolResultContent = Array<TextContent | ImageContent>;

export interface UserMessage {
  role: "user";
  content: UserContent;
  timestamp: number;
}

export interface AssistantUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: Record<string, number>;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent;
  api?: string;
  provider?: string;
  model?: string;
  usage?: AssistantUsage;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ToolResultContent;
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | Array<TextContent | ImageContent>;
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

export interface ToolPair {
  toolCallId: string;
  toolName: string;
  call: ToolCallContent;
  assistantIndex: number;
  callBlockIndex: number;
  result: ToolResultMessage;
  resultIndex: number;
}

export interface ToolDecision {
  toolCallId: string;
  toolName: string;
  action: CompactionAction;
  keepCall?: number;
  keepResult?: number;
  protectedReason?: string;
}

export interface JevCompactionStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  reductionRatio: number;
  kept: number;
  truncated: number;
  dropped: number;
  protected: number;
  requests: number;
  elapsedMs: number;
  model: string;
  replayTokens: number;
  targetReplayTokens: number;
  maxReplayTokens: number;
  budgetWarning: boolean;
}

export interface JevCompactionDetails {
  kind: typeof JEV_COMPACTION_KIND;
  schemaVersion: typeof JEV_COMPACTION_SCHEMA_VERSION;
  extensionVersion: string;
  createdAt: string;
  replayMessages: AgentMessage[];
  decisions: ToolDecision[];
  stats: JevCompactionStats;
}

export interface CompactionEntryLike {
  type: "compaction";
  id?: string;
  timestamp?: string;
  summary?: string;
  tokensBefore?: number;
  details?: unknown;
}

export interface SessionEntryLike {
  type: string;
  id?: string;
  timestamp?: string;
  summary?: string;
  tokensBefore?: number;
  details?: unknown;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string | Record<string, unknown>;
}

export interface JevAnswer {
  noul: number;
}

export interface JevJudgeResult {
  model: string;
  answers: Record<string, JevAnswer>;
  requests: number;
}

export interface JevJudge {
  judge(input: {
    state: unknown;
    questions: Record<string, NoulQuestion>;
    model: string;
    signal?: AbortSignal;
  }): Promise<JevJudgeResult>;
}

export interface CompactSuccess {
  ok: true;
  details: JevCompactionDetails;
  summary: string;
}

export interface CompactFallback {
  ok: false;
  reason: string;
}

export type CompactOutcome = CompactSuccess | CompactFallback;

export interface DiagnosticSink {
  warn(message: string): void;
}
