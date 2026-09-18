import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyDecisions,
  compactionMarker,
  describeResultContent,
  estimateChars,
  estimateTokens,
  expandPreviousReplay,
  imagePlaceholder,
  isRecord,
  pairToolCalls,
  textBlock,
  tryClone,
} from "./2026-09-18_pi-adapter.ts";
import {
  buildJevState,
  buildQuestions,
  chunkPairs,
  keepCallQuestionId,
  keepResultQuestionId,
  questionBudget,
} from "./2026-09-18_state.ts";
import { splitJudgeByChunks } from "./2026-09-18_jev-client.ts";
import type {
  AgentMessage,
  CompactOutcome,
  CompactionAction,
  ImageContent,
  JevCompactionConfig,
  JevCompactionDetails,
  JevJudge,
  SessionEntryLike,
  ToolDecision,
  ToolPair,
  ToolResultContent,
  ToolResultMessage,
} from "./2026-09-18_types.ts";
import { JEV_COMPACTION_KIND, JEV_COMPACTION_SCHEMA_VERSION } from "./2026-09-18_types.ts";

const LOOKUP_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function decideAction(keepCall: number, keepResult: number, threshold: number): Exclude<CompactionAction, "protected"> {
  if (keepResult >= threshold) return "keep";
  if (keepCall >= threshold) return "truncate_result";
  return "drop_call";
}

export function isProtectedToolName(name: string, protectTools: string[]): boolean {
  const lower = name.toLowerCase();
  return protectTools.some((item) => item.toLowerCase() === lower);
}

export function protectedReasonForPair(
  pair: ToolPair,
  messages: AgentMessage[],
  config: JevCompactionConfig,
): string | undefined {
  if (pair.assistantIndex === 0 || pair.resultIndex === 0) return "first_message";
  const recentStart = Math.max(0, messages.length - config.preserveRecentMessages);
  if (pair.assistantIndex >= recentStart || pair.resultIndex >= recentStart) return "recent";
  if (isProtectedToolName(pair.toolName, config.protectTools)) return "protect_tool";
  if (config.protectErrors && pair.result.isError === true) return "error";
  return undefined;
}

export function truncateResultContent(
  result: ToolResultMessage,
  toolName: string,
  config: JevCompactionConfig,
): ToolResultContent {
  const described = describeResultContent(result.content);
  const blocks: ToolResultContent = [];
  const original = Array.isArray(result.content) ? result.content : [textBlock(described.text)];
  for (const block of original) {
    if (!isRecord(block)) continue;
    if (block.type === "image") blocks.push(imagePlaceholder(block as ImageContent));
  }

  const name = toolName.toLowerCase();
  let text: string;
  if (name === "bash" || name === "powershell") {
    text = truncateBash(described.text, result, config);
  } else if (LOOKUP_TOOLS.has(name)) {
    text = truncateLookup(described.text, toolName, config);
  } else {
    text = truncateGeneric(described.text, toolName, config);
  }
  blocks.unshift(textBlock(text));
  return blocks;
}

function truncateBash(text: string, result: ToolResultMessage, config: JevCompactionConfig): string {
  const head = config.truncateHeadChars;
  const tail = config.truncateTailChars;
  const exitInfo = extractExitInfo(result);
  const body = sliceHeadTail(text, head, tail);
  const suffix = exitInfo ? `\n${exitInfo}` : "";
  if (body === text) return `${text}${suffix}`.trim();
  return `${body}${suffix}\n[pi-jev-compaction truncated bash output]`;
}

function truncateLookup(text: string, toolName: string, config: JevCompactionConfig): string {
  const head = text.slice(0, config.truncateHeadChars);
  const omitted = Math.max(0, text.length - head.length);
  return `${head}\n[pi-jev-compaction truncated ${toolName} output; ${omitted} chars omitted. Re-run the original tool to recover the full output.]`;
}

function truncateGeneric(text: string, toolName: string, config: JevCompactionConfig): string {
  const head = text.slice(0, config.truncateHeadChars);
  const omitted = Math.max(0, text.length - head.length);
  if (omitted === 0) return text;
  return `${head}\n[pi-jev-compaction omitted ${omitted} chars from ${toolName}]`;
}

function sliceHeadTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n...[${omitted} chars omitted]...\n${text.slice(-tail)}`;
}

function extractExitInfo(result: ToolResultMessage): string | undefined {
  const details = result.details;
  if (isRecord(details)) {
    const exit = details.exitCode ?? details.exit_code;
    if (typeof exit === "number" || typeof exit === "string") return `exitCode=${exit}`;
    if (details.cancelled === true) return "cancelled=true";
  }
  const match = describeResultContent(result.content).text.match(/exit(?:Code| status)?[:=]\s*(-?\d+)/i);
  if (match) return `exitCode=${match[1]}`;
  if (result.isError) return "isError=true";
  return undefined;
}

export function buildSummary(details: JevCompactionDetails): string {
  const { stats, decisions, createdAt } = details;
  const lines = [
    compactionMarker(createdAt),
    "Jev compacted older tool calls. User and assistant text are kept. Replay lives in compaction details.",
    "",
    "## Stats",
    `- messages: ${stats.messagesBefore} -> ${stats.messagesAfter}`,
    `- chars: ${stats.charsBefore} -> ${stats.charsAfter} (${Math.round(stats.reductionRatio * 100)}% reduction)`,
    `- kept=${stats.kept} truncated=${stats.truncated} dropped=${stats.dropped} protected=${stats.protected}`,
    `- model=${stats.model} requests=${stats.requests} elapsedMs=${stats.elapsedMs}`,
    `- replayTokens=${stats.replayTokens} target=${stats.targetReplayTokens} max=${stats.maxReplayTokens} budgetWarning=${stats.budgetWarning}`,
    "",
    "## Tool decisions",
  ];
  for (const decision of decisions) {
    const probs =
      decision.action === "protected"
        ? decision.protectedReason ?? "protected"
        : `keep_call=${fmt(decision.keepCall)} keep_result=${fmt(decision.keepResult)}`;
    lines.push(`- ${decision.toolName} ${decision.toolCallId}: ${decision.action} (${probs})`);
  }
  if (decisions.length === 0) lines.push("- none");
  return lines.join("\n");
}

function fmt(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return value.toFixed(3);
}

export function readExtensionVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export interface CompactWindowInput {
  messages: AgentMessage[];
  config: JevCompactionConfig;
  judge: JevJudge;
  branchEntries?: SessionEntryLike[];
  customInstructions?: string;
  reason?: string;
  signal?: AbortSignal;
  now?: () => number;
  extensionVersion?: string;
}

export async function compactWindow(input: CompactWindowInput): Promise<CompactOutcome> {
  const started = (input.now ?? Date.now)();
  const cloned = tryClone(input.messages);
  const expanded = expandPreviousReplay(cloned, input.branchEntries);
  const messages = expanded.messages;
  const charsBefore = estimateChars(messages);
  const pairing = pairToolCalls(messages);
  const decisions: ToolDecision[] = [];
  const judgeable: ToolPair[] = [];

  for (const pair of pairing.pairs) {
    const protectedReason = protectedReasonForPair(pair, messages, input.config);
    if (protectedReason) {
      decisions.push({
        toolCallId: pair.toolCallId,
        toolName: pair.toolName,
        action: "protected",
        protectedReason,
      });
    } else {
      judgeable.push(pair);
    }
  }

  let model = input.config.model;
  let requests = 0;
  if (judgeable.length > 0) {
    try {
      const judged = await judgePairs({
        messages,
        pairs: judgeable,
        config: input.config,
        judge: input.judge,
        customInstructions: input.customInstructions,
        reason: input.reason,
        signal: input.signal,
      });
      model = judged.model;
      requests = judged.requests;
      for (const pair of judgeable) {
        const keepCall = judged.answers[keepCallQuestionId(pair.toolCallId)]?.noul;
        const keepResult = judged.answers[keepResultQuestionId(pair.toolCallId)]?.noul;
        if (
          keepCall === undefined ||
          keepResult === undefined ||
          !Number.isFinite(keepCall) ||
          !Number.isFinite(keepResult)
        ) {
          return { ok: false, reason: "malformed_answer" };
        }
        decisions.push({
          toolCallId: pair.toolCallId,
          toolName: pair.toolName,
          action: decideAction(keepCall, keepResult, input.config.keepThreshold),
          keepCall,
          keepResult,
        });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "jev_failed";
      return { ok: false, reason };
    }
  }

  const replayMessages = applyDecisions(messages, decisions, (result, toolName) =>
    truncateResultContent(result, toolName, input.config),
  );
  const charsAfter = estimateChars(replayMessages);
  const reductionRatio = charsBefore <= 0 ? 0 : 1 - charsAfter / charsBefore;
  if (reductionRatio + 1e-9 < input.config.minReductionRatio) {
    return { ok: false, reason: "min_reduction_ratio" };
  }
  const replayTokens = replayMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
  if (replayTokens > input.config.maxReplayTokens) {
    return { ok: false, reason: "max_replay_tokens" };
  }
  const budgetWarning = replayTokens > input.config.targetReplayTokens;

  const statsCounts = countActions(decisions);
  const details: JevCompactionDetails = {
    kind: JEV_COMPACTION_KIND,
    schemaVersion: JEV_COMPACTION_SCHEMA_VERSION,
    extensionVersion: input.extensionVersion ?? readExtensionVersion(),
    createdAt: new Date((input.now ?? Date.now)()).toISOString(),
    replayMessages: tryClone(replayMessages),
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: replayMessages.length,
      charsBefore,
      charsAfter,
      reductionRatio,
      kept: statsCounts.kept,
      truncated: statsCounts.truncated,
      dropped: statsCounts.dropped,
      protected: statsCounts.protected,
      requests,
      elapsedMs: Math.max(0, (input.now ?? Date.now)() - started),
      model,
      replayTokens,
      targetReplayTokens: input.config.targetReplayTokens,
      maxReplayTokens: input.config.maxReplayTokens,
      budgetWarning,
    },
  };

  JSON.stringify(details);
  return { ok: true, details, summary: buildSummary(details) };
}

async function judgePairs(input: {
  messages: AgentMessage[];
  pairs: ToolPair[];
  config: JevCompactionConfig;
  judge: JevJudge;
  customInstructions?: string;
  reason?: string;
  signal?: AbortSignal;
}) {
  const baseState = buildJevState({
    messages: input.messages,
    pairs: input.pairs,
    config: input.config,
    customInstructions: input.customInstructions,
    reason: input.reason,
  });
  const budget = questionBudget(input.config, baseState);
  const chunks = chunkPairs(input.pairs, budget).filter((chunk) => chunk.length > 0);
  const payload = chunks.map((pairs) => ({
    state: buildJevState({
      messages: input.messages,
      pairs,
      config: input.config,
      customInstructions: input.customInstructions,
      reason: input.reason,
    }),
    questions: buildQuestions(pairs),
  }));
  return splitJudgeByChunks(input.judge, payload, input.config.model, input.signal);
}

function countActions(decisions: ToolDecision[]): {
  kept: number;
  truncated: number;
  dropped: number;
  protected: number;
} {
  const counts = { kept: 0, truncated: 0, dropped: 0, protected: 0 };
  for (const decision of decisions) {
    if (decision.action === "keep") counts.kept += 1;
    else if (decision.action === "truncate_result") counts.truncated += 1;
    else if (decision.action === "drop_call") counts.dropped += 1;
    else counts.protected += 1;
  }
  return counts;
}

export function createMapJudge(
  map: Record<string, { keepCall: number; keepResult: number }>,
  model = "jev-mock",
): JevJudge {
  return {
    async judge(input) {
      const answers: Record<string, { noul: number }> = {};
      for (const id of Object.keys(input.questions)) {
        const toolId = id.replace(/^keep_(?:call|result)_/, "");
        const programmed = map[toolId] ?? map[id];
        if (id.startsWith("keep_call_")) answers[id] = { noul: programmed?.keepCall ?? 1 };
        else answers[id] = { noul: programmed?.keepResult ?? 1 };
      }
      return { model, answers, requests: 1 };
    },
  };
}
