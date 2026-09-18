import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSessionContext,
  estimateTokens,
  findCutPoint,
  getLatestCompactionEntry,
  SessionManager,
  sessionEntryToContextMessages,
  type CompactionEntry,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { pairToolCalls } from "../src/2026-09-18_pi-adapter.ts";
import { redactErrorMessage } from "../src/2026-09-18_redact.ts";
import { createRuntime } from "../src/2026-09-18_runtime.ts";
import {
  JEV_COMPACTION_KIND,
  JEV_COMPACTION_MARKER_PREFIX,
  type AgentMessage,
  type SessionEntryLike,
} from "../src/2026-09-18_types.ts";

const COPY_PATH = "/tmp/2026-09-18_pi-jev-right-pane-session-test.jsonl";
const REPORT_NAME = "2026-09-18_右侧Pi会话_Jev真实压缩测试报告.md";
const PI_COMPACTION_SETTINGS = {
  enabled: true,
  keepRecentTokens: 20000,
  reserveTokens: 16384,
} as const;

interface PublicPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
}

interface AggregateReport {
  status: "passed" | "failed";
  phase: string;
  error?: string;
  originalUnchanged?: boolean;
  apiKeyPresent?: boolean;
  defaultBudgetAttemptEnabledOnly?: boolean;
  defaultBudgetJudgeCalls?: number;
  persistenceUsedRaisedMax?: boolean;
  raisedMaxJudgeCalls?: number;
  disabledLocalReplayApplied?: boolean;
  explicitEnableOverride?: boolean;
  publicApiOnly?: boolean;
  branchEntries?: number;
  preparationDefined?: boolean;
  isSplitTurn?: boolean;
  tokensBefore?: number;
  windowMessages?: number;
  messagesToSummarize?: number;
  turnPrefixMessages?: number;
  toolPairs?: number;
  orphanCalls?: number;
  orphanResults?: number;
  defaultBudgetRejected?: boolean;
  defaultBudgetReason?: string;
  compactionReturned?: boolean;
  detailsKindOk?: boolean;
  replayMessageCount?: number;
  charsBefore?: number;
  charsAfter?: number;
  reductionRatio?: number;
  kept?: number;
  truncated?: number;
  dropped?: number;
  protected?: number;
  requests?: number;
  model?: string;
  elapsedMs?: number;
  replayTokens?: number;
  budgetWarning?: boolean;
  markerPresent?: boolean;
  compactionEntryWritten?: boolean;
  reopenRestoredKind?: boolean;
  contextReplayApplied?: boolean;
  reopenReplayApplied?: boolean;
  contextMessagesAfter?: number;
  contextSummaryRemaining?: number;
}

function fingerprint(path: string): { size: number; mtimeMs: number; sha256: string } {
  const st = statSync(path);
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { size: st.size, mtimeMs: st.mtimeMs, sha256 };
}

function sanitize(value: unknown): string {
  return redactErrorMessage(value instanceof Error ? value.message : String(value));
}

function writeReport(report: AggregateReport): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const lines = [
    "# 右侧 Pi 会话 · Jev 真实压缩测试报告",
    "",
    "日期：2026-09-18",
    `状态：${report.status}`,
    `阶段：${report.phase}`,
    "",
    "本报告只含聚合数字与布尔结果。不含用户正文、助手正文、工具参数、文件内容、会话路径或 API Key。",
    "",
    "## 环境与隔离",
    "",
    `- apiKeyPresent: ${report.apiKeyPresent ?? false}`,
    `- defaultBudgetAttemptEnabledOnly: ${report.defaultBudgetAttemptEnabledOnly ?? false}`,
    `- defaultBudgetJudgeCalls: ${num(report.defaultBudgetJudgeCalls)}`,
    `- persistenceUsedRaisedMax: ${report.persistenceUsedRaisedMax ?? false}`,
    `- raisedMaxJudgeCalls: ${num(report.raisedMaxJudgeCalls)}`,
    `- disabledLocalReplayApplied: ${report.disabledLocalReplayApplied ?? false}`,
    `- explicitEnableOverride: ${report.explicitEnableOverride ?? false}`,
    `- publicApiOnly: ${report.publicApiOnly ?? false}`,
    `- originalUnchanged: ${report.originalUnchanged ?? false}`,
    `- copyPath: \`${COPY_PATH}\`（测试后删除）`,
    `- Pi CompactionSettings: keepRecentTokens=${PI_COMPACTION_SETTINGS.keepRecentTokens}, reserveTokens=${PI_COMPACTION_SETTINGS.reserveTokens}`,
    "",
    "## 会话窗口",
    "",
    `- branchEntries: ${num(report.branchEntries)}`,
    `- preparationDefined: ${report.preparationDefined ?? false}`,
    `- isSplitTurn: ${report.isSplitTurn ?? false}`,
    `- tokensBefore: ${num(report.tokensBefore)}`,
    `- windowMessages: ${num(report.windowMessages)}`,
    `- messagesToSummarize: ${num(report.messagesToSummarize)}`,
    `- turnPrefixMessages: ${num(report.turnPrefixMessages)}`,
    `- toolPairs: ${num(report.toolPairs)}`,
    `- orphanCalls: ${num(report.orphanCalls)}`,
    `- orphanResults: ${num(report.orphanResults)}`,
    "",
    "## Jev compaction",
    "",
    `- defaultBudgetRejected: ${report.defaultBudgetRejected ?? false}`,
    `- defaultBudgetReason: ${report.defaultBudgetReason ?? "n/a"}`,
    `- compactionReturned: ${report.compactionReturned ?? false}`,
    `- detailsKindOk: ${report.detailsKindOk ?? false}`,
    `- replayMessageCount: ${num(report.replayMessageCount)}`,
    `- charsBefore: ${num(report.charsBefore)}`,
    `- charsAfter: ${num(report.charsAfter)}`,
    `- reductionRatio: ${ratio(report.reductionRatio)}`,
    `- kept: ${num(report.kept)}`,
    `- truncated: ${num(report.truncated)}`,
    `- dropped: ${num(report.dropped)}`,
    `- protected: ${num(report.protected)}`,
    `- requests: ${num(report.requests)}`,
    `- model: ${report.model ?? "n/a"}`,
    `- elapsedMs: ${num(report.elapsedMs)}`,
    `- replayTokens: ${num(report.replayTokens)}`,
    `- budgetWarning: ${report.budgetWarning ?? false}`,
    "",
    "## 公共 session API / 重开",
    "",
    `- markerPresent: ${report.markerPresent ?? false}`,
    `- compactionEntryWritten: ${report.compactionEntryWritten ?? false}`,
    `- reopenRestoredKind: ${report.reopenRestoredKind ?? false}`,
    `- contextReplayApplied: ${report.contextReplayApplied ?? false}`,
    `- reopenReplayApplied: ${report.reopenReplayApplied ?? false}`,
    `- contextMessagesAfter: ${num(report.contextMessagesAfter)}`,
    `- contextSummaryRemaining: ${num(report.contextSummaryRemaining)}`,
  ];
  if (report.error) {
    lines.push("", "## 错误（已脱敏）", "", report.error);
  }
  writeFileSync(join(root, REPORT_NAME), `${lines.join("\n")}\n`, "utf8");
}

function num(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function ratio(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

function messagesFromEntry(entry: SessionEntry): AgentMessage[] {
  if (entry.type === "compaction") return [];
  return sessionEntryToContextMessages(entry) as AgentMessage[];
}

/** Equivalent of Pi prepareCompaction, assembled only from public package exports. */
function prepareUsingPublicApi(
  pathEntries: SessionEntry[],
  settings: { keepRecentTokens: number },
): PublicPreparation | undefined {
  if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1]?.type === "compaction") return undefined;
  let prevIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i -= 1) {
    if (pathEntries[i]?.type === "compaction") {
      prevIndex = i;
      break;
    }
  }
  let previousSummary: string | undefined;
  let boundaryStart = 0;
  if (prevIndex >= 0) {
    const prev = pathEntries[prevIndex] as CompactionEntry;
    previousSummary = prev.summary;
    const firstKept = pathEntries.findIndex((entry) => entry.id === prev.firstKeptEntryId);
    boundaryStart = firstKept >= 0 ? firstKept : prevIndex + 1;
  }
  const tokensBefore = buildSessionContext(pathEntries).messages.reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
  const cut = findCutPoint(pathEntries, boundaryStart, pathEntries.length, settings.keepRecentTokens);
  const firstKeptEntry = pathEntries[cut.firstKeptEntryIndex];
  if (!firstKeptEntry?.id) return undefined;
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < historyEnd; i += 1) {
    const entry = pathEntries[i];
    if (entry) messagesToSummarize.push(...messagesFromEntry(entry));
  }
  const turnPrefixMessages: AgentMessage[] = [];
  if (cut.isSplitTurn) {
    for (let i = cut.turnStartIndex; i < cut.firstKeptEntryIndex; i += 1) {
      const entry = pathEntries[i];
      if (entry) turnPrefixMessages.push(...messagesFromEntry(entry));
    }
  }
  if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
  return {
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    turnPrefixMessages,
    isSplitTurn: cut.isSplitTurn,
    tokensBefore,
    previousSummary,
  };
}

test("real Jev compaction against copied PI_SESSION_FILE via public APIs", async () => {
  const report: AggregateReport = {
    status: "failed",
    phase: "start",
    apiKeyPresent: Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim() !== ""),
    defaultBudgetAttemptEnabledOnly: true,
    explicitEnableOverride: true,
    publicApiOnly: true,
  };
  const emptyHome = mkdtempSync(join(tmpdir(), "jev-real-session-home-"));
  let originalFp: { size: number; mtimeMs: number; sha256: string } | undefined;
  let sourcePath: string | undefined;

  try {
    sourcePath = process.env.PI_SESSION_FILE?.trim();
    if (!sourcePath) {
      report.phase = "missing_PI_SESSION_FILE";
      report.error = "PI_SESSION_FILE is missing";
      writeReport(report);
      assert.fail("PI_SESSION_FILE is missing");
    }

    originalFp = fingerprint(sourcePath);
    copyFileSync(sourcePath, COPY_PATH);

    report.phase = "open_copy";
    const session = SessionManager.open(COPY_PATH);
    const branch = session.getBranch();
    report.branchEntries = branch.length;

    report.phase = "prepareUsingPublicApi";
    const preparation = prepareUsingPublicApi(branch, PI_COMPACTION_SETTINGS);
    report.preparationDefined = Boolean(preparation);
    if (!preparation) {
      report.error = "public prepare returned undefined (no cut point / empty window)";
      writeReport(report);
      assert.fail("public prepare returned undefined");
    }

    const windowMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    const pairing = pairToolCalls(windowMessages);
    report.isSplitTurn = preparation.isSplitTurn;
    report.tokensBefore = preparation.tokensBefore;
    report.windowMessages = windowMessages.length;
    report.messagesToSummarize = preparation.messagesToSummarize.length;
    report.turnPrefixMessages = preparation.turnPrefixMessages.length;
    report.toolPairs = pairing.pairs.length;
    report.orphanCalls = pairing.orphanCallIds.length;
    report.orphanResults = pairing.orphanResultIndexes.length;

    report.phase = "handleBeforeCompact";
    let defaultBudgetJudgeCalls = 0;
    const defaultRuntime = createRuntime({
      home: emptyHome,
      configOverride: { enabled: true },
      judgeFactory: () => ({
        async judge() {
          defaultBudgetJudgeCalls += 1;
          throw new Error("jev_should_not_run_on_default_budget_precheck");
        },
      }),
    });
    const defaultAttempt = await defaultRuntime.handleBeforeCompact(
      {
        preparation: {
          messagesToSummarize: preparation.messagesToSummarize,
          turnPrefixMessages: preparation.turnPrefixMessages,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          previousSummary: preparation.previousSummary,
        },
        branchEntries: branch as SessionEntryLike[],
        reason: "manual",
      },
      { cwd: emptyHome, isProjectTrusted: () => false, hasUI: false },
    );
    report.defaultBudgetJudgeCalls = defaultBudgetJudgeCalls;
    if (!defaultAttempt?.compaction) {
      report.defaultBudgetRejected = true;
      report.defaultBudgetReason = sanitize(defaultRuntime.lastRun()?.reason ?? "undefined");
    } else {
      report.defaultBudgetRejected = false;
    }
    report.persistenceUsedRaisedMax = !defaultAttempt?.compaction;

    const runtime = createRuntime({
      home: emptyHome,
      configOverride: defaultAttempt?.compaction
        ? { enabled: true }
        : { enabled: true, maxReplayTokens: 2_000_000 },
    });
    const compactResult = defaultAttempt?.compaction
      ? defaultAttempt
      : await runtime.handleBeforeCompact(
      {
        preparation: {
          messagesToSummarize: preparation.messagesToSummarize,
          turnPrefixMessages: preparation.turnPrefixMessages,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          previousSummary: preparation.previousSummary,
        },
        branchEntries: branch as SessionEntryLike[],
        reason: "manual",
      },
      { cwd: emptyHome, isProjectTrusted: () => false, hasUI: false },
    );

    report.compactionReturned = Boolean(compactResult?.compaction);
    if (!compactResult?.compaction) {
      report.error = sanitize(runtime.lastRun()?.reason ?? "compaction returned undefined");
      writeReport(report);
      assert.fail("handleBeforeCompact did not return compaction details");
    }

    const details = compactResult.compaction.details;
    report.detailsKindOk = details.kind === JEV_COMPACTION_KIND;
    report.replayMessageCount = details.replayMessages.length;
    report.charsBefore = details.stats.charsBefore;
    report.charsAfter = details.stats.charsAfter;
    report.reductionRatio = details.stats.reductionRatio;
    report.kept = details.stats.kept;
    report.truncated = details.stats.truncated;
    report.dropped = details.stats.dropped;
    report.protected = details.stats.protected;
    report.requests = details.stats.requests;
    report.model = details.stats.model;
    report.elapsedMs = details.stats.elapsedMs;
    report.replayTokens = details.stats.replayTokens;
    report.budgetWarning = details.stats.budgetWarning;
    report.markerPresent = compactResult.compaction.summary.includes(JEV_COMPACTION_MARKER_PREFIX);

    report.phase = "appendCompaction";
    const entryId = session.appendCompaction(
      compactResult.compaction.summary,
      compactResult.compaction.firstKeptEntryId,
      compactResult.compaction.tokensBefore,
      details,
      true,
    );
    report.compactionEntryWritten = Boolean(entryId);
    const liveLatest = getLatestCompactionEntry(session.getBranch());
    assert.equal((liveLatest as CompactionEntry | null)?.details && details.kind, JEV_COMPACTION_KIND);

    report.phase = "contextReplay";
    const liveContext = buildSessionContext(session.getBranch());
    const replayed = runtime.handleContext(
      { messages: liveContext.messages as AgentMessage[] },
      { cwd: emptyHome, isProjectTrusted: () => false, sessionManager: { getBranch: () => session.getBranch() as SessionEntryLike[] } },
    );
    report.contextReplayApplied = Boolean(replayed?.messages);
    report.contextMessagesAfter = replayed?.messages?.length;
    report.contextSummaryRemaining = replayed?.messages?.filter((item) => item.role === "compactionSummary").length ?? -1;

    report.phase = "reopen";
    const reopened = SessionManager.open(COPY_PATH);
    const restored = getLatestCompactionEntry(reopened.getBranch()) as CompactionEntry | null;
    report.reopenRestoredKind = Boolean(
      restored && restored.details && (restored.details as { kind?: string }).kind === JEV_COMPACTION_KIND,
    );
    const reopenedContext = buildSessionContext(reopened.getBranch());
    const reopenedReplay = runtime.handleContext(
      { messages: reopenedContext.messages as AgentMessage[] },
      {
        cwd: emptyHome,
        isProjectTrusted: () => false,
        sessionManager: { getBranch: () => reopened.getBranch() as SessionEntryLike[] },
      },
    );
    report.reopenReplayApplied = Boolean(reopenedReplay?.messages);

    const disabledRuntime = createRuntime({
      home: emptyHome,
      configOverride: { enabled: false },
    });
    const disabledReplay = disabledRuntime.handleContext(
      { messages: reopenedContext.messages as AgentMessage[] },
      {
        cwd: emptyHome,
        isProjectTrusted: () => false,
        sessionManager: { getBranch: () => reopened.getBranch() as SessionEntryLike[] },
      },
    );
    report.disabledLocalReplayApplied = Boolean(disabledReplay?.messages);

    report.raisedMaxJudgeCalls = details.stats.requests;

    assert.equal(details.kind, JEV_COMPACTION_KIND);
    assert.ok(Array.isArray(details.replayMessages));
    assert.ok(details.replayMessages.length > 0);
    assert.equal(report.markerPresent, true);
    assert.equal(report.compactionEntryWritten, true);
    assert.equal(report.contextReplayApplied, true);
    assert.equal(report.reopenRestoredKind, true);
    assert.equal(report.reopenReplayApplied, true);
    assert.equal(report.disabledLocalReplayApplied, true);
    assert.equal(report.defaultBudgetJudgeCalls, 0);
    assert.equal(report.contextSummaryRemaining, 0);

    report.status = "passed";
    report.phase = "done";
    writeReport(report);
  } catch (error) {
    if (!report.error) report.error = sanitize(error);
    report.status = "failed";
    try {
      writeReport(report);
    } catch {
      // still rethrow
    }
    throw error;
  } finally {
    try {
      rmSync(COPY_PATH, { force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(emptyHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
    if (sourcePath && originalFp) {
      const after = fingerprint(sourcePath);
      report.originalUnchanged = after.size === originalFp.size && after.sha256 === originalFp.sha256;
      if (!report.originalUnchanged) {
        report.status = "failed";
        report.error = sanitize(report.error ? `${report.error}; original session changed` : "original session changed");
        writeReport(report);
        assert.fail("original session file changed");
      } else {
        try {
          writeReport(report);
        } catch {
          // ignore
        }
      }
    }
  }
});
