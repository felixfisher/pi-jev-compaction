import { redactSecrets, redactUnknown, truncateChars } from "./2026-09-18_redact.ts";
import { describeResultContent, estimateTokens, isRecord, userAndAssistantSnippets } from "./2026-09-18_pi-adapter.ts";
import type {
  AgentMessage,
  JevAnswer,
  JevCompactionConfig,
  NoulQuestion,
  ToolPair,
} from "./2026-09-18_types.ts";

export function keepCallQuestionId(toolCallId: string): string {
  return `keep_call_${toolCallId}`;
}

export function keepResultQuestionId(toolCallId: string): string {
  return `keep_result_${toolCallId}`;
}

export function buildToolStateItem(pair: ToolPair, config: JevCompactionConfig): Record<string, unknown> {
  const described = describeResultContent(pair.result.content);
  const args = redactUnknown(pair.call.arguments, config.privacyMode);
  return {
    id: pair.toolCallId,
    name: pair.toolName,
    args: truncateUnknown(args, 800),
    resultChars: described.chars,
    isError: pair.result.isError === true,
    imageCount: described.imageCount,
    resultTags: resultTags(pair, described),
  };
}

function resultTags(
  pair: ToolPair,
  described: { chars: number; imageCount: number },
): string[] {
  const tags: string[] = [];
  if (pair.result.isError) tags.push("error");
  if (described.imageCount > 0) tags.push("image");
  if (described.chars > 4000) tags.push("long");
  else if (described.chars === 0) tags.push("empty");
  else tags.push("text");
  const details = pair.result.details;
  if (isRecord(details) && ("exitCode" in details || "exit_code" in details)) tags.push("has_exit_code");
  return tags;
}

function truncateUnknown(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") return truncateChars(value, maxChars);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined && json.length > maxChars) {
      return { truncated: true, preview: truncateChars(json, maxChars) };
    }
  } catch {
    return "[unserializable]";
  }
  return value;
}

export function buildJevState(input: {
  messages: AgentMessage[];
  pairs: ToolPair[];
  config: JevCompactionConfig;
  customInstructions?: string;
  reason?: string;
}): Record<string, unknown> {
  const conversation = userAndAssistantSnippets(input.messages).map((item) => ({
    role: item.role,
    text: redactSecrets(item.text, input.config.privacyMode),
  }));
  const tools = input.pairs.map((pair) => buildToolStateItem(pair, input.config));
  const state: Record<string, unknown> = {
    task: {
      note: "Continue the same coding task. User and assistant prose will be kept verbatim. Decide only whether each listed tool call/result is still needed.",
      reason: input.reason ?? "unknown",
      customInstructions: input.customInstructions
        ? redactSecrets(input.customInstructions, input.config.privacyMode)
        : undefined,
    },
    conversation,
    tools,
  };
  return shrinkState(state, input.config.maxStateTokens);
}

export function shrinkState(state: Record<string, unknown>, maxStateTokens: number): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  if (estimateTokens(clone) <= maxStateTokens) return clone;

  const tools = Array.isArray(clone.tools) ? (clone.tools as Array<Record<string, unknown>>) : [];
  for (const tool of tools) {
    if (isRecord(tool.args)) {
      tool.args = { truncated: true, preview: truncateChars(JSON.stringify(tool.args) ?? "", 240) };
    } else if (typeof tool.args === "string") {
      tool.args = truncateChars(tool.args, 240);
    }
  }
  if (estimateTokens(clone) <= maxStateTokens) return clone;

  const conversation = Array.isArray(clone.conversation) ? (clone.conversation as unknown[]) : [];
  clone.conversation = conversation.slice(-6);
  if (estimateTokens(clone) <= maxStateTokens) return clone;

  clone.conversation = conversation.slice(-2);
  return clone;
}

export function buildQuestions(pairs: ToolPair[]): Record<string, NoulQuestion> {
  const questions: Record<string, NoulQuestion> = {};
  for (const pair of pairs) {
    questions[keepCallQuestionId(pair.toolCallId)] = {
      type: "noul",
      instructions: {
        proposition: "Later work still needs to know that this tool was called and what its inputs were.",
        toolName: pair.toolName,
        toolCallId: pair.toolCallId,
        true: "The call identity or arguments remain useful even if the result can be discarded or re-run.",
        false: "The later task can proceed without knowing this call happened.",
      },
    };
    questions[keepResultQuestionId(pair.toolCallId)] = {
      type: "noul",
      instructions: {
        proposition: "Later work still needs the original full tool result, and re-running the tool would not be an adequate substitute.",
        toolName: pair.toolName,
        toolCallId: pair.toolCallId,
        true: "The exact original output is still required.",
        false: "The result can be dropped or replaced by a short truncated reminder.",
      },
    };
  }
  return questions;
}

export function chunkPairs(pairs: ToolPair[], questionsBudget: number): ToolPair[][] {
  const perPair = 2;
  const maxPairs = Math.max(1, Math.floor(questionsBudget / perPair));
  const chunks: ToolPair[][] = [];
  for (let i = 0; i < pairs.length; i += maxPairs) {
    chunks.push(pairs.slice(i, i + maxPairs));
  }
  return chunks.length > 0 ? chunks : [[]];
}

export function parseNoul(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (isRecord(value) && typeof value.noul === "number") return value.noul;
  return undefined;
}

export function collectAnswers(
  requiredIds: string[],
  answers: Record<string, unknown>,
): { ok: true; answers: Record<string, JevAnswer> } | { ok: false; reason: string } {
  const out: Record<string, JevAnswer> = {};
  for (const id of requiredIds) {
    const raw = parseNoul(answers[id]);
    if (raw === undefined || !Number.isFinite(raw)) {
      return { ok: false, reason: `malformed_answer:${id}` };
    }
    out[id] = { noul: clamp01(raw) };
  }
  return { ok: true, answers: out };
}

export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function questionBudget(config: JevCompactionConfig, state: unknown): number {
  const remaining = config.maxRequestTokens - estimateTokens(state) - 400;
  const maxQuestions = Math.max(2, Math.floor(remaining / 80));
  return Math.min(80, maxQuestions);
}
