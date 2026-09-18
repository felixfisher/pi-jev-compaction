import { DEFAULT_CONFIG } from "../src/2026-09-18_config.ts";
import type {
  AgentMessage,
  AssistantMessage,
  CompactionSummaryMessage,
  JevCompactionConfig,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from "../src/2026-09-18_types.ts";

export function config(overrides: Partial<JevCompactionConfig> = {}): JevCompactionConfig {
  return {
    ...DEFAULT_CONFIG,
    protectTools: [...DEFAULT_CONFIG.protectTools],
    minReductionRatio: 0,
    preserveRecentMessages: 0,
    ...overrides,
  };
}

export function user(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: text, timestamp };
}

export function assistant(content: AssistantMessage["content"], timestamp = 2): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "toolUse",
    timestamp,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  };
}

export function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCallContent {
  return { type: "toolCall", id, name, arguments: args };
}

export function result(
  id: string,
  name: string,
  text: string,
  options: { isError?: boolean; timestamp?: number; details?: unknown; extra?: ToolResultMessage["content"] } = {},
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }, ...(options.extra ?? [])],
    isError: options.isError ?? false,
    timestamp: options.timestamp ?? 3,
    details: options.details,
  };
}

export function summary(text: string, tokensBefore = 1000, timestamp = 10): CompactionSummaryMessage {
  return { role: "compactionSummary", summary: text, tokensBefore, timestamp };
}

export function conversation(tools: Array<[string, string, string, Record<string, unknown>?]>): AgentMessage[] {
  const calls = tools.map(([id, name, _text, args]) => call(id, name, args ?? { path: "x" }));
  const results = tools.map(([id, name, text], index) => result(id, name, text, { timestamp: 20 + index }));
  return [user("please inspect"), assistant([{ type: "text", text: "working" }, ...calls], 2), ...results];
}
