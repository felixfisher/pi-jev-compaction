import { applyBudgetGuards, hasTypesafeApiKey, loadConfig, readTypesafeApiKey } from "./2026-09-18_config.ts";
import { createJevClient } from "./2026-09-18_jev-client.ts";
import { compactWindow, readExtensionVersion } from "./2026-09-18_compact.ts";
import { findLatestJevCompaction, isJevDetails, replayContextMessages, tryClone } from "./2026-09-18_pi-adapter.ts";
import { redactErrorMessage } from "./2026-09-18_redact.ts";
import type {
  AgentMessage,
  CompactOutcome,
  DiagnosticSink,
  JevCompactionConfig,
  JevCompactionDetails,
  JevJudge,
  SessionEntryLike,
} from "./2026-09-18_types.ts";

export interface RuntimeUi {
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}

export interface RuntimeContext {
  cwd?: string;
  hasUI?: boolean;
  isProjectTrusted?: () => boolean;
  ui?: RuntimeUi;
  sessionManager?: {
    getBranch?: () => SessionEntryLike[];
    getEntries?: () => SessionEntryLike[];
  };
  signal?: AbortSignal;
}

export interface BeforeCompactEvent {
  preparation: {
    messagesToSummarize?: AgentMessage[];
    turnPrefixMessages?: AgentMessage[];
    firstKeptEntryId: string;
    tokensBefore: number;
    previousSummary?: string;
  };
  branchEntries?: SessionEntryLike[];
  customInstructions?: string;
  reason?: string;
  signal?: AbortSignal;
}

export interface LastRunInfo {
  at: string;
  ok: boolean;
  reason?: string;
  stats?: JevCompactionDetails["stats"];
}

export interface JevRuntime {
  loadCurrentConfig(ctx: RuntimeContext): { config: JevCompactionConfig; sources: string[]; warnings: string[] };
  handleBeforeCompact(event: BeforeCompactEvent, ctx: RuntimeContext): Promise<
    | undefined
    | {
        compaction: {
          summary: string;
          firstKeptEntryId: string;
          tokensBefore: number;
          details: JevCompactionDetails;
        };
      }
  >;
  handleContext(event: { messages: AgentMessage[] }, ctx: RuntimeContext): { messages?: AgentMessage[] } | undefined;
  statusText(ctx: RuntimeContext): string;
  lastRun(): LastRunInfo | undefined;
}

export interface CreateRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  judgeFactory?: (config: JevCompactionConfig, apiKey: string) => JevJudge;
  now?: () => number;
  diagnostics?: DiagnosticSink;
  configOverride?: Partial<JevCompactionConfig>;
}

export function createRuntime(options: CreateRuntimeOptions = {}): JevRuntime {
  const env = options.env ?? process.env;
  let lastRun: LastRunInfo | undefined;
  const extensionVersion = readExtensionVersion();

  const loadCurrentConfig = (ctx: RuntimeContext) => {
    const loaded = loadConfig({
      cwd: ctx.cwd,
      home: options.home,
      env,
      trusted: ctx.isProjectTrusted?.() === true,
      diagnostics: options.diagnostics,
    });
    if (!options.configOverride) return loaded;
    const warnings: string[] = [...loaded.warnings];
    const config = applyBudgetGuards(
      {
        ...loaded.config,
        ...options.configOverride,
        protectTools: options.configOverride.protectTools ?? loaded.config.protectTools,
      },
      { warn: (message) => warnings.push(message) },
    );
    return { ...loaded, config, warnings };
  };

  const notify = (ctx: RuntimeContext, message: string, type: "info" | "warning" | "error" = "info") => {
    try {
      ctx.ui?.notify?.(message, type);
    } catch {
      // Non-TUI / missing UI must never crash the extension.
    }
  };

  const setStatus = (ctx: RuntimeContext, text: string | undefined) => {
    try {
      ctx.ui?.setStatus?.("jev-compaction", text);
    } catch {
      // ignore
    }
  };

  return {
    loadCurrentConfig,
    lastRun() {
      return lastRun;
    },
    async handleBeforeCompact(event, ctx) {
      const { config, warnings } = loadCurrentConfig(ctx);
      for (const warning of warnings) notify(ctx, `jev-compaction: ${warning}`, "warning");
      if (!config.enabled) return undefined;

      const apiKey = readTypesafeApiKey(env);
      if (!apiKey) {
        lastRun = { at: new Date((options.now ?? Date.now)()).toISOString(), ok: false, reason: "missing_api_key" };
        notify(ctx, "Jev compaction skipped (no TYPESAFE_API_KEY); using Pi default", "warning");
        return undefined;
      }

      const windowMessages = [
        ...(event.preparation.messagesToSummarize ?? []),
        ...(event.preparation.turnPrefixMessages ?? []),
      ];
      if (windowMessages.length === 0) {
        lastRun = { at: new Date((options.now ?? Date.now)()).toISOString(), ok: false, reason: "empty_window" };
        notify(ctx, "Jev compaction skipped (empty window); using Pi default", "warning");
        return undefined;
      }

      notify(ctx, "Jev compaction started", "info");
      setStatus(ctx, "Jev compacting…");
      try {
        const judge = (options.judgeFactory ?? defaultJudgeFactory)(config, apiKey);
        const outcome: CompactOutcome = await compactWindow({
          messages: windowMessages,
          config,
          judge,
          branchEntries: event.branchEntries ?? readBranch(ctx),
          customInstructions: event.customInstructions,
          reason: event.reason,
          signal: event.signal ?? ctx.signal,
          now: options.now,
          extensionVersion,
        });
        if (!outcome.ok) {
          lastRun = {
            at: new Date((options.now ?? Date.now)()).toISOString(),
            ok: false,
            reason: outcome.reason,
          };
          notify(ctx, `Jev compaction skipped (${outcome.reason}); using Pi default`, "warning");
          return undefined;
        }
        lastRun = {
          at: outcome.details.createdAt,
          ok: true,
          stats: outcome.details.stats,
        };
        const budgetNote = outcome.details.stats.budgetWarning
          ? ` budgetWarning replayTokens=${outcome.details.stats.replayTokens}`
          : "";
        notify(
          ctx,
          `Jev compaction kept=${outcome.details.stats.kept} truncated=${outcome.details.stats.truncated} dropped=${outcome.details.stats.dropped}${budgetNote}`,
          outcome.details.stats.budgetWarning ? "warning" : "info",
        );
        return {
          compaction: {
            summary: outcome.summary,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details: outcome.details,
          },
        };
      } catch (error) {
        const reason = redactErrorMessage(error instanceof Error ? error.message : String(error), apiKey);
        lastRun = { at: new Date((options.now ?? Date.now)()).toISOString(), ok: false, reason };
        notify(ctx, `Jev compaction skipped (${reason}); using Pi default`, "warning");
        return undefined;
      } finally {
        setStatus(ctx, undefined);
      }
    },
    handleContext(event, ctx) {
      try {
        const { config } = loadCurrentConfig(ctx);
        if (!config.enabled) return undefined;
        const entries = readBranch(ctx);
        const result = replayContextMessages(tryClone(event.messages), entries);
        if (!result.applied) {
          if (result.reason && result.reason !== "no_jev_compaction_entry" && result.reason !== "compaction_summary_not_found") {
            notify(ctx, `Jev replay skipped (${result.reason})`, "warning");
          }
          return undefined;
        }
        return { messages: result.messages };
      } catch (error) {
        const reason = redactErrorMessage(error instanceof Error ? error.message : String(error));
        notify(ctx, `Jev replay skipped (${reason})`, "warning");
        return undefined;
      }
    },
    statusText(ctx) {
      const { config, sources, warnings } = loadCurrentConfig(ctx);
      const latest = findLatestJevCompaction(readBranch(ctx));
      const persisted = isJevDetails(latest?.details) ? latest.details.stats : undefined;
      const keyPresent = hasTypesafeApiKey(env);
      const lines = [
        `pi-jev-compaction ${extensionVersion}`,
        `enabled: ${config.enabled}`,
        `apiKey: ${keyPresent ? "present" : "missing"}`,
        `model: ${config.model}`,
        `keepThreshold: ${config.keepThreshold}`,
        `preserveRecentMessages: ${config.preserveRecentMessages}`,
        `minReductionRatio: ${config.minReductionRatio}`,
        `privacyMode: ${config.privacyMode}`,
        `protectTools: ${config.protectTools.join(", ") || "(none)"}`,
        `protectErrors: ${config.protectErrors}`,
        `timeoutMs: ${config.timeoutMs}`,
        `maxRetries: ${config.maxRetries}`,
        `targetReplayTokens: ${config.targetReplayTokens}`,
        `maxReplayTokens: ${config.maxReplayTokens}`,
        `sources: ${sources.join(" | ")}`,
      ];
      if (warnings.length > 0) lines.push(`warnings: ${warnings.join("; ")}`);
      if (lastRun) {
        lines.push(
          `lastRun: ${lastRun.ok ? "ok" : "fallback"} ${lastRun.reason ?? ""} ${formatStats(lastRun.stats)}`.trim(),
        );
      } else {
        lines.push("lastRun: none");
      }
      if (persisted) lines.push(`persisted: ${formatStats(persisted)}`);
      return lines.join("\n");
    },
  };
}

function defaultJudgeFactory(config: JevCompactionConfig, apiKey: string): JevJudge {
  return createJevClient({
    apiKey,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  });
}

function readBranch(ctx: RuntimeContext): SessionEntryLike[] {
  try {
    return ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
}

function formatStats(stats: JevCompactionDetails["stats"] | undefined): string {
  if (!stats) return "";
  const budget = stats.budgetWarning ? " budgetWarning" : "";
  return `kept=${stats.kept} truncated=${stats.truncated} dropped=${stats.dropped} protected=${stats.protected} reduction=${Math.round(stats.reductionRatio * 100)}% replayTokens=${stats.replayTokens}${budget}`;
}

export function registerJevCompaction(
  pi: {
    on(event: any, handler: any): void;
    registerCommand(name: string, spec: any): void;
  },
  options: CreateRuntimeOptions = {},
): JevRuntime {
  const runtime = createRuntime(options);

  pi.on("session_before_compact", (async (event: BeforeCompactEvent, ctx: RuntimeContext) => {
    return runtime.handleBeforeCompact(event, ctx);
  }) as never);

  pi.on("context", ((event: { messages: AgentMessage[] }, ctx: RuntimeContext) => {
    return runtime.handleContext(event, ctx);
  }) as never);

  pi.on("session_compact", ((event: { compactionEntry?: { details?: unknown } }, ctx: RuntimeContext) => {
    if (isJevDetails(event.compactionEntry?.details)) {
      try {
        ctx.ui?.setStatus?.("jev-compaction", undefined);
      } catch {
        // ignore
      }
    }
  }) as never);

  pi.registerCommand("jev-status", {
    description: "Show pi-jev-compaction status, config, and last persisted stats",
    handler: async (_args: string, ctx: RuntimeContext) => {
      const text = runtime.statusText(ctx);
      try {
        ctx.ui?.notify?.(text, "info");
      } catch {
        // ignore
      }
      if (ctx.hasUI === false) {
        try {
          process.stderr.write(`${text}\n`);
        } catch {
          // ignore
        }
      }
    },
  });

  return runtime;
}
