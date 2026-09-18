import {
  JEV_COMPACTION_KIND,
  JEV_COMPACTION_MARKER_PREFIX,
  type AgentMessage,
  type AssistantMessage,
  type CompactionEntryLike,
  type CompactionSummaryMessage,
  type ImageContent,
  type JevCompactionDetails,
  type SessionEntryLike,
  type TextContent,
  type ToolCallContent,
  type ToolDecision,
  type ToolPair,
  type ToolResultContent,
  type ToolResultMessage,
} from "./2026-09-18_types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || typeof value.role !== "string") return false;
  return [
    "user",
    "assistant",
    "toolResult",
    "bashExecution",
    "custom",
    "branchSummary",
    "compactionSummary",
  ].includes(value.role);
}

export function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

export function isToolResultMessage(message: AgentMessage): message is ToolResultMessage {
  return message.role === "toolResult";
}

export function isCompactionSummaryMessage(message: AgentMessage): message is CompactionSummaryMessage {
  return message.role === "compactionSummary";
}

export function isToolCallContent(value: unknown): value is ToolCallContent {
  return isRecord(value) && value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string";
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function tryClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    try {
      return cloneJson(value);
    } catch {
      return value;
    }
  }
}

export function estimateChars(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(estimateChars(value) / 4);
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(block.thinking);
  }
  return parts.join("\n");
}

export function describeResultContent(content: unknown): {
  text: string;
  chars: number;
  imageCount: number;
  blockCount: number;
} {
  if (typeof content === "string") {
    return { text: content, chars: content.length, imageCount: 0, blockCount: 1 };
  }
  if (!Array.isArray(content)) {
    const text = safeContentFallback(content);
    return { text, chars: text.length, imageCount: 0, blockCount: 0 };
  }
  let text = "";
  let imageCount = 0;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text += block.text;
    else if (block.type === "image") imageCount += 1;
  }
  return { text, chars: text.length, imageCount, blockCount: content.length };
}

function safeContentFallback(content: unknown): string {
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "";
  }
}

export function pairToolCalls(messages: AgentMessage[]): {
  pairs: ToolPair[];
  orphanCallIds: string[];
  orphanResultIndexes: number[];
} {
  const pendingCalls = new Map<string, Array<{ assistantIndex: number; callBlockIndex: number; call: ToolCallContent }>>();
  const pairs: ToolPair[] = [];
  const usedResultIndexes = new Set<number>();
  const seenCallOrder: Array<{ id: string; assistantIndex: number; callBlockIndex: number; call: ToolCallContent }> = [];

  messages.forEach((message, assistantIndex) => {
    if (!isAssistantMessage(message) || !Array.isArray(message.content)) return;
    message.content.forEach((block, callBlockIndex) => {
      if (!isToolCallContent(block) || block.id === "") return;
      const call: ToolCallContent = {
        type: "toolCall",
        id: block.id,
        name: typeof block.name === "string" ? block.name : "unknown",
        arguments: isRecord(block.arguments) ? block.arguments : {},
      };
      const list = pendingCalls.get(call.id) ?? [];
      list.push({ assistantIndex, callBlockIndex, call });
      pendingCalls.set(call.id, list);
      seenCallOrder.push({ id: call.id, assistantIndex, callBlockIndex, call });
    });
  });

  messages.forEach((message, resultIndex) => {
    if (!isToolResultMessage(message)) return;
    const id = message.toolCallId;
    const pending = pendingCalls.get(id);
    const nextCall = pending?.shift();
    if (!nextCall) return;
    usedResultIndexes.add(resultIndex);
    pairs.push({
      toolCallId: id,
      toolName: nextCall.call.name || message.toolName || "unknown",
      call: nextCall.call,
      assistantIndex: nextCall.assistantIndex,
      callBlockIndex: nextCall.callBlockIndex,
      result: message,
      resultIndex,
    });
    if (pending && pending.length === 0) pendingCalls.delete(id);
  });

  const orphanCallIds: string[] = [];
  for (const [id, leftover] of pendingCalls) {
    for (const item of leftover) orphanCallIds.push(item.call.id || id);
  }

  const orphanResultIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (isToolResultMessage(message) && !usedResultIndexes.has(index)) {
      orphanResultIndexes.push(index);
    }
  });

  void seenCallOrder;
  return { pairs, orphanCallIds, orphanResultIndexes };
}

export function validateReplayStructure(messages: unknown): messages is AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  return messages.every((item) => isAgentMessage(item));
}

export function toolResultsHaveValidOrdering(messages: AgentMessage[]): boolean {
  const seenCalls = new Set<string>();
  for (const message of messages) {
    if (isAssistantMessage(message) && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isToolCallContent(block) && block.id) seenCalls.add(block.id);
      }
    }
    if (isToolResultMessage(message)) {
      const id = message.toolCallId;
      if (!id) continue;
      if (!seenCalls.has(id)) {
        const laterCall = messages.some(
          (candidate) =>
            isAssistantMessage(candidate) &&
            Array.isArray(candidate.content) &&
            candidate.content.some((block) => isToolCallContent(block) && block.id === id),
        );
        if (laterCall) return false;
      }
    }
  }
  return true;
}

export function isJevDetails(value: unknown): value is JevCompactionDetails {
  if (!isRecord(value)) return false;
  if (value.kind !== JEV_COMPACTION_KIND) return false;
  if (value.schemaVersion !== 1) return false;
  if (!Array.isArray(value.replayMessages)) return false;
  return validateReplayStructure(value.replayMessages);
}

export function findLatestJevCompaction(entries: SessionEntryLike[] | undefined): CompactionEntryLike | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "compaction" && isJevDetails(entry.details)) {
      return entry as CompactionEntryLike;
    }
  }
  return undefined;
}

export function compactionMarker(createdAt: string): string {
  return `${JEV_COMPACTION_MARKER_PREFIX}:${createdAt} -->`;
}

export function summaryMatchesEntry(message: CompactionSummaryMessage, entry: CompactionEntryLike): boolean {
  if (typeof entry.summary === "string" && entry.summary === message.summary) return true;
  if (typeof entry.summary === "string" && message.summary.includes(entry.summary) && message.summary.includes(JEV_COMPACTION_MARKER_PREFIX)) {
    return true;
  }
  if (typeof entry.summary === "string" && entry.summary.includes(JEV_COMPACTION_MARKER_PREFIX) && message.summary.includes(JEV_COMPACTION_MARKER_PREFIX)) {
    const entryMark = extractMarker(entry.summary);
    const messageMark = extractMarker(message.summary);
    if (entryMark && entryMark === messageMark) return true;
  }
  const entryTs = parseTimestamp(entry.timestamp);
  const tokensMatch =
    typeof entry.tokensBefore === "number" &&
    Number.isFinite(entry.tokensBefore) &&
    entry.tokensBefore === message.tokensBefore;
  if (tokensMatch && entryTs !== undefined && Math.abs(entryTs - message.timestamp) <= 5000) {
    return message.summary.includes(JEV_COMPACTION_MARKER_PREFIX) || typeof entry.summary === "string";
  }
  return false;
}

function extractMarker(summary: string): string | undefined {
  const start = summary.indexOf(JEV_COMPACTION_MARKER_PREFIX);
  if (start < 0) return undefined;
  const end = summary.indexOf("-->", start);
  if (end < 0) return undefined;
  return summary.slice(start, end + 3);
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

export function expandPreviousReplay(
  messages: AgentMessage[],
  entries: SessionEntryLike[] | undefined,
): { messages: AgentMessage[]; expanded: boolean; reason?: string } {
  const entry = findLatestJevCompaction(entries);
  if (!entry || !isJevDetails(entry.details)) {
    return { messages, expanded: false, reason: "no_previous_jev_compaction" };
  }
  const index = messages.findIndex(
    (message) => isCompactionSummaryMessage(message) && summaryMatchesEntry(message, entry),
  );
  if (index < 0) return { messages, expanded: false, reason: "summary_not_in_window" };
  const replay = tryClone(entry.details.replayMessages);
  if (!validateReplayStructure(replay)) {
    return { messages, expanded: false, reason: "invalid_previous_replay" };
  }
  const next = [...messages.slice(0, index), ...replay, ...messages.slice(index + 1)];
  return { messages: next, expanded: true };
}

export function replayContextMessages(
  messages: AgentMessage[],
  entries: SessionEntryLike[] | undefined,
): { messages: AgentMessage[]; applied: boolean; reason?: string } {
  const entry = findLatestJevCompaction(entries);
  if (!entry || !isJevDetails(entry.details)) {
    return { messages, applied: false, reason: "no_jev_compaction_entry" };
  }
  const summaryIndex = messages.findIndex(
    (message) => isCompactionSummaryMessage(message) && summaryMatchesEntry(message, entry),
  );
  if (summaryIndex < 0) {
    return { messages, applied: false, reason: "compaction_summary_not_found" };
  }
  const replay = tryClone(entry.details.replayMessages);
  if (!validateReplayStructure(replay)) {
    return { messages, applied: false, reason: "invalid_replay_messages" };
  }
  const tail = messages.slice(summaryIndex + 1);
  const rebuilt = [...messages.slice(0, summaryIndex), ...replay, ...tail];
  if (!toolResultsHaveValidOrdering(rebuilt)) {
    return { messages, applied: false, reason: "tool_ordering_invalid" };
  }
  const originalTailResults = new Set(
    tail.filter(isToolResultMessage).map((item) => identityKey(item)),
  );
  for (const message of rebuilt) {
    if (!isToolResultMessage(message)) continue;
    const hasPriorCall = hasPrecedingCall(rebuilt, message);
    if (hasPriorCall) continue;
    const inTail = originalTailResults.has(identityKey(message));
    const orphanInReplay = replay.includes(message) || replay.some((item) => isToolResultMessage(item) && identityKey(item) === identityKey(message));
    if (!inTail && !orphanInReplay) {
      return { messages, applied: false, reason: "unpaired_result_not_in_tail" };
    }
  }
  return { messages: rebuilt, applied: true };
}

function identityKey(message: ToolResultMessage): string {
  return `${message.toolCallId}:${message.timestamp}:${estimateChars(message.content)}:${message.isError ? 1 : 0}`;
}

function hasPrecedingCall(messages: AgentMessage[], result: ToolResultMessage): boolean {
  for (const message of messages) {
    if (message === result) return false;
    if (isAssistantMessage(message) && Array.isArray(message.content)) {
      if (message.content.some((block) => isToolCallContent(block) && block.id === result.toolCallId)) {
        return true;
      }
    }
  }
  return false;
}

export function applyDecisions(
  messages: AgentMessage[],
  decisions: ToolDecision[],
  truncate: (result: ToolResultMessage, toolName: string) => ToolResultContent,
): AgentMessage[] {
  const byId = new Map(decisions.map((item) => [item.toolCallId, item]));
  const dropped = new Set(decisions.filter((item) => item.action === "drop_call").map((item) => item.toolCallId));
  const truncated = new Set(
    decisions.filter((item) => item.action === "truncate_result").map((item) => item.toolCallId),
  );

  const rebuilt: AgentMessage[] = [];
  for (const message of messages) {
    if (isAssistantMessage(message)) {
      const content = Array.isArray(message.content) ? message.content : [];
      const nextContent = content.filter((block) => {
        if (!isToolCallContent(block)) return true;
        return !dropped.has(block.id);
      });
      if (nextContent.length === 0) continue;
      rebuilt.push({ ...message, content: nextContent });
      continue;
    }
    if (isToolResultMessage(message)) {
      if (dropped.has(message.toolCallId)) continue;
      if (truncated.has(message.toolCallId)) {
        const toolName = byId.get(message.toolCallId)?.toolName || message.toolName;
        rebuilt.push({
          ...message,
          content: truncate(message, toolName),
        });
        continue;
      }
      rebuilt.push(message);
      continue;
    }
    rebuilt.push(message);
  }
  return rebuilt;
}

export function userAndAssistantSnippets(messages: AgentMessage[], limit = 20, maxChars = 400): Array<{
  role: string;
  text: string;
}> {
  const snippets: Array<{ role: string; text: string }> = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "custom") continue;
    const text = contentText("content" in message ? message.content : "");
    if (!text.trim()) continue;
    snippets.push({ role: message.role, text: text.slice(0, maxChars) });
  }
  return snippets.slice(-limit);
}

export function textBlock(text: string): TextContent {
  return { type: "text", text };
}

export function imagePlaceholder(block: ImageContent): TextContent {
  const bytes = typeof block.data === "string" ? block.data.length : 0;
  const mime = block.mimeType || "image";
  return textBlock(`[image omitted: ${mime}, ${bytes} b64-chars]`);
}
