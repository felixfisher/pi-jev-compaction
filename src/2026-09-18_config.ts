import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { DiagnosticSink, JevCompactionConfig, PrivacyMode } from "./2026-09-18_types.ts";

export const DEFAULT_CONFIG: JevCompactionConfig = {
  enabled: false,
  model: "jev-latest",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
  truncateTailChars: 500,
  minReductionRatio: 0.25,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  timeoutMs: 15000,
  maxRetries: 2,
  protectTools: ["edit", "write"],
  protectErrors: true,
  privacyMode: "balanced",
  targetReplayTokens: 80_000,
  maxReplayTokens: 100_000,
};

export function resolveConfigDirName(): string {
  return CONFIG_DIR_NAME || ".pi";
}


export function resolveAgentDir(options: { home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const override = (env.PI_CODING_AGENT_DIR ?? "").trim();
  if (override) return expandUserPath(override, home);
  return join(home, resolveConfigDirName(), "agent");
}

function expandUserPath(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefault(): JevCompactionConfig {
  return { ...DEFAULT_CONFIG, protectTools: [...DEFAULT_CONFIG.protectTools] };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONFIG.keepThreshold;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asInteger(value: unknown): number | undefined {
  const num = asFiniteNumber(value);
  if (num === undefined) return undefined;
  return Math.trunc(num);
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items;
}

function asPrivacyMode(value: unknown): PrivacyMode | undefined {
  if (value === "off" || value === "balanced" || value === "strict") return value;
  return undefined;
}

/** Validated fields from one config layer. Unspecified keys are omitted so later merge stays partial. */
export function parseConfigPatch(raw: unknown, diagnostics?: DiagnosticSink): Partial<JevCompactionConfig> {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) {
    diagnostics?.warn("jev-compaction config is not an object; ignored");
    return {};
  }

  const patch: Partial<JevCompactionConfig> = {};

  if (raw.enabled !== undefined) {
    const enabled = asBoolean(raw.enabled);
    if (enabled === undefined) diagnostics?.warn("enabled is invalid; ignored");
    else patch.enabled = enabled;
  }

  if (raw.model !== undefined) {
    const model = asNonEmptyString(raw.model);
    if (!model) diagnostics?.warn("model is invalid; ignored");
    else patch.model = model;
  }

  if (raw.keepThreshold !== undefined) {
    const value = asFiniteNumber(raw.keepThreshold);
    if (value === undefined) {
      diagnostics?.warn("keepThreshold is invalid; ignored");
    } else {
      if (value < 0 || value > 1) diagnostics?.warn("keepThreshold clamped to [0,1]");
      patch.keepThreshold = clamp01(value);
    }
  }

  const intFields: Array<[keyof JevCompactionConfig, number, number]> = [
    ["preserveRecentMessages", 0, 10_000],
    ["truncateHeadChars", 0, 1_000_000],
    ["truncateTailChars", 0, 1_000_000],
    ["maxStateTokens", 1, 1_000_000],
    ["maxRequestTokens", 1, 1_000_000],
    ["timeoutMs", 1, 10 * 60_000],
    ["maxRetries", 0, 10],
    ["targetReplayTokens", 1, 2_000_000],
    ["maxReplayTokens", 1, 2_000_000],
  ];
  for (const [key, min, max] of intFields) {
    if (raw[key] === undefined) continue;
    const value = asInteger(raw[key]);
    if (value === undefined) {
      diagnostics?.warn(`${key} is invalid; ignored`);
      continue;
    }
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) diagnostics?.warn(`${key} clamped to [${min}, ${max}]`);
    (patch[key] as number) = clamped;
  }

  if (raw.minReductionRatio !== undefined) {
    const value = asFiniteNumber(raw.minReductionRatio);
    if (value === undefined) {
      diagnostics?.warn("minReductionRatio is invalid; ignored");
    } else {
      if (value < 0 || value > 1) diagnostics?.warn("minReductionRatio clamped to [0,1]");
      patch.minReductionRatio = clamp01(value);
    }
  }

  if (raw.protectTools !== undefined) {
    const tools = asStringArray(raw.protectTools);
    if (!tools) diagnostics?.warn("protectTools is invalid; ignored");
    else patch.protectTools = [...tools];
  }

  if (raw.protectErrors !== undefined) {
    const value = asBoolean(raw.protectErrors);
    if (value === undefined) diagnostics?.warn("protectErrors is invalid; ignored");
    else patch.protectErrors = value;
  }

  if (raw.privacyMode !== undefined) {
    const value = asPrivacyMode(raw.privacyMode);
    if (!value) diagnostics?.warn("privacyMode is invalid; ignored");
    else patch.privacyMode = value;
  }

  return patch;
}

export function applyBudgetGuards(config: JevCompactionConfig, diagnostics?: DiagnosticSink): JevCompactionConfig {
  const next = { ...config, protectTools: [...config.protectTools] };
  if (next.maxReplayTokens < next.targetReplayTokens) {
    diagnostics?.warn("maxReplayTokens raised to targetReplayTokens");
    next.maxReplayTokens = next.targetReplayTokens;
  }
  return next;
}

export function parseConfig(raw: unknown, diagnostics?: DiagnosticSink): JevCompactionConfig {
  return applyBudgetGuards(mergeConfigs(cloneDefault(), parseConfigPatch(raw, diagnostics)), diagnostics);
}

export function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    const text = readFileSync(path, "utf8");
    if (text.trim() === "") return { ok: true, value: {} };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: err.message || "read_failed" };
  }
}

export function globalConfigPath(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAgentDir({ home, env }), "jev-compaction.json");
}

export function projectConfigPath(cwd: string, configDirName = resolveConfigDirName()): string {
  return join(cwd, configDirName, "jev-compaction.json");
}

export function mergeConfigs(base: JevCompactionConfig, patch: Partial<JevCompactionConfig>): JevCompactionConfig {
  const next: JevCompactionConfig = {
    ...base,
    ...patch,
    protectTools:
      Object.prototype.hasOwnProperty.call(patch, "protectTools") && Array.isArray(patch.protectTools)
        ? [...patch.protectTools]
        : [...base.protectTools],
  };
  return next;
}

export interface LoadConfigOptions {
  cwd?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  trusted?: boolean;
  readFile?: typeof readJsonFile;
  diagnostics?: DiagnosticSink;
}

export function loadConfig(options: LoadConfigOptions = {}): {
  config: JevCompactionConfig;
  sources: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const diagnostics: DiagnosticSink = {
    warn(message: string) {
      warnings.push(message);
      options.diagnostics?.warn(message);
    },
  };
  const readFile = options.readFile ?? readJsonFile;
  const env = options.env ?? process.env;
  const sources: string[] = ["defaults"];
  let config = cloneDefault();

  const globalPath = globalConfigPath(options.home, env);
  const globalFile = readFile(globalPath);
  if (globalFile.ok) {
    config = mergeConfigs(config, parseConfigPatch(globalFile.value, diagnostics));
    sources.push(globalPath);
  } else if (globalFile.reason !== "missing") {
    diagnostics.warn(`ignored global config (${sanitizePath(globalPath)}): ${globalFile.reason}`);
  }

  if (options.trusted && options.cwd) {
    const localPath = projectConfigPath(options.cwd);
    const localFile = readFile(localPath);
    if (localFile.ok) {
      config = mergeConfigs(config, parseConfigPatch(localFile.value, diagnostics));
      sources.push(localPath);
    } else if (localFile.reason !== "missing") {
      diagnostics.warn(`ignored project config: ${localFile.reason}`);
    }
  }

  config = applyBudgetGuards(config, diagnostics);
  return { config, sources, warnings };
}

export function sanitizePath(path: string): string {
  return path.replaceAll(homedir(), "~");
}

export function hasTypesafeApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.TYPESAFE_API_KEY;
  return typeof value === "string" && value.trim() !== "";
}

export function readTypesafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.TYPESAFE_API_KEY;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
