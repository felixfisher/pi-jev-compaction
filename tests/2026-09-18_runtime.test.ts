import assert from "node:assert/strict";
import { test } from "node:test";
import { globalConfigPath, loadConfig, parseConfig, projectConfigPath } from "../src/2026-09-18_config.ts";
import { createJevClient, JevRequestError } from "../src/2026-09-18_jev-client.ts";
import { createRuntime, registerJevCompaction } from "../src/2026-09-18_runtime.ts";
import { compactionMarker } from "../src/2026-09-18_pi-adapter.ts";
import { createMapJudge } from "../src/2026-09-18_compact.ts";
import { JEV_COMPACTION_KIND, JEV_COMPACTION_SCHEMA_VERSION, type AgentMessage } from "../src/2026-09-18_types.ts";
import { assistant, call, result, summary, user } from "./2026-09-18_fixtures.ts";

test("invalid config values warn and fall back to defaults", () => {
  const warnings: string[] = [];
  const config = parseConfig(
    {
      keepThreshold: 9,
      minReductionRatio: "nope",
      preserveRecentMessages: -4,
      privacyMode: "purple",
      timeoutMs: 0,
    },
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(config.keepThreshold, 1);
  assert.equal(config.minReductionRatio, 0.25);
  assert.equal(config.preserveRecentMessages, 0);
  assert.equal(config.privacyMode, "balanced");
  assert.equal(config.timeoutMs, 1);
  assert.ok(warnings.length >= 3);
});

test("loadConfig keeps unspecified default fields from a global partial", () => {
  const home = "/tmp/jev-home";
  const globalPath = globalConfigPath(home, {});
  const { config, sources } = loadConfig({
    home,
    env: {},
    trusted: false,
    readFile: (path) => {
      if (path === globalPath) return { ok: true, value: { keepThreshold: 0.8 } };
      return { ok: false, reason: "missing" };
    },
  });
  assert.equal(config.keepThreshold, 0.8);
  assert.equal(config.timeoutMs, 15000);
  assert.equal(config.minReductionRatio, 0.25);
  assert.deepEqual(config.protectTools, ["edit", "write"]);
  assert.equal(sources.includes(globalPath), true);
});

test("project partial does not reset unspecified global fields", () => {
  const home = "/tmp/jev-home";
  const cwd = "/tmp/jev-project";
  const globalPath = globalConfigPath(home, {});
  const projectPath = projectConfigPath(cwd);
  const { config, sources } = loadConfig({
    home,
    cwd,
    env: {},
    trusted: true,
    readFile: (path) => {
      if (path === globalPath) {
        return { ok: true, value: { keepThreshold: 0.8, protectTools: ["edit"] } };
      }
      if (path === projectPath) return { ok: true, value: { timeoutMs: 20000 } };
      return { ok: false, reason: "missing" };
    },
  });
  assert.equal(config.keepThreshold, 0.8);
  assert.equal(config.timeoutMs, 20000);
  assert.deepEqual(config.protectTools, ["edit"]);
  assert.equal(config.model, "jev-latest");
  assert.equal(sources.includes(globalPath), true);
  assert.equal(sources.includes(projectPath), true);
});

test("untrusted project config is not read", () => {
  const home = "/tmp/jev-home";
  const cwd = "/tmp/jev-project";
  const globalPath = globalConfigPath(home, {});
  const projectPath = projectConfigPath(cwd);
  const read: string[] = [];
  const { config, sources } = loadConfig({
    home,
    cwd,
    env: {},
    trusted: false,
    readFile: (path) => {
      read.push(path);
      if (path === globalPath) return { ok: true, value: { keepThreshold: 0.8 } };
      if (path === projectPath) return { ok: true, value: { keepThreshold: 0.1, timeoutMs: 20000 } };
      return { ok: false, reason: "missing" };
    },
  });
  assert.equal(read.includes(projectPath), false);
  assert.equal(config.keepThreshold, 0.8);
  assert.equal(config.timeoutMs, 15000);
  assert.equal(sources.includes(projectPath), false);
});

test("Jev client retries 429 and 529, but not 401 or 422", async () => {
  const calls: number[] = [];
  const retrying = createJevClient({
    apiKey: "test-key-not-real",
    timeoutMs: 200,
    maxRetries: 2,
    sleep: async () => undefined,
    fetchImpl: async () => {
      calls.push(1);
      if (calls.length < 3) return new Response("no", { status: calls.length === 1 ? 429 : 529 });
      return new Response(JSON.stringify({ model: "jev-latest", answers: { keep_call_a: { noul: 0.7 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const ok = await retrying.judge({
    state: { x: 1 },
    questions: { keep_call_a: { type: "noul", instructions: "keep?" } },
    model: "jev-latest",
  });
  assert.equal(ok.answers.keep_call_a?.noul, 0.7);
  assert.equal(calls.length, 3);

  for (const status of [401, 422]) {
    let hits = 0;
    const client = createJevClient({
      apiKey: "test-key-not-real",
      maxRetries: 3,
      sleep: async () => undefined,
      fetchImpl: async () => {
        hits += 1;
        return new Response("denied", { status });
      },
    });
    await assert.rejects(
      () =>
        client.judge({
          state: {},
          questions: { q: { type: "noul", instructions: "x" } },
          model: "jev-latest",
        }),
      (error: unknown) => error instanceof JevRequestError && error.status === status && hits === 1,
    );
  }
});

test("Jev client times out and does not leak the API key", async () => {
  const client = createJevClient({
    apiKey: "super-secret-api-key-value",
    timeoutMs: 30,
    maxRetries: 0,
    fetchImpl: () =>
      new Promise<Response>((resolve) => {
        setTimeout(() => resolve(new Response("{}")), 400);
      }),
  });
  await assert.rejects(
    () =>
      client.judge({
        state: {},
        questions: { q: { type: "noul", instructions: "x" } },
        model: "jev-latest",
      }),
    (error: unknown) => {
      assert.ok(error instanceof JevRequestError);
      assert.equal(error.message.includes("super-secret-api-key-value"), false);
      assert.match(error.message, /timeout/);
      return true;
    },
  );
});

test("runtime fail-open without API key", async () => {
  const notes: string[] = [];
  const runtime = createRuntime({ env: {}, configOverride: { enabled: true } });
  const resultValue = await runtime.handleBeforeCompact(
    {
      preparation: {
        messagesToSummarize: [user("hi"), assistant([call("c1", "ls")]), result("c1", "ls", "files")],
        firstKeptEntryId: "keep1",
        tokensBefore: 1000,
      },
      reason: "manual",
    },
    { ui: { notify: (message) => notes.push(message) }, isProjectTrusted: () => false },
  );
  assert.equal(resultValue, undefined);
  assert.equal(runtime.lastRun()?.reason, "missing_api_key");
  assert.equal(notes.some((item) => item.includes("TYPESAFE_API_KEY")), true);
  assert.equal(notes.some((item) => item.includes("sk-") || item.includes("super-secret")), false);
});

test("runtime context fail-open leaves original messages", () => {
  const runtime = createRuntime({ env: { TYPESAFE_API_KEY: "not-a-real-key" }, configOverride: { enabled: true } });
  const original: AgentMessage[] = [summary("not jev"), user("later")];
  const handled = runtime.handleContext(
    { messages: original },
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "compaction",
            summary: "different",
            details: { kind: "other" },
          },
        ],
      },
    },
  );
  assert.equal(handled, undefined);
});

test("runtime compact + context replay round-trip", async () => {
  const runtime = createRuntime({
    env: { TYPESAFE_API_KEY: "not-a-real-key" },
    configOverride: { enabled: true, preserveRecentMessages: 0, minReductionRatio: 0.1, truncateHeadChars: 20, truncateTailChars: 20 },
    judgeFactory: () => createMapJudge({ c1: { keepCall: 0.9, keepResult: 0.1 } }),
  });
  const long = "OUTPUT".repeat(80);
  const compactResult = await runtime.handleBeforeCompact(
    {
      preparation: {
        messagesToSummarize: [
          user("run ls"),
          assistant([{ type: "text", text: "running" }, call("c1", "bash", { command: "ls -la" })]),
          result("c1", "bash", long, { details: { exitCode: 0 } }),
        ],
        firstKeptEntryId: "tail1",
        tokensBefore: 8000,
      },
      reason: "threshold",
    },
    { isProjectTrusted: () => false },
  );
  assert.ok(compactResult?.compaction.details);
  const details = compactResult.compaction.details;
  const ctx = runtime.handleContext(
    {
      messages: [
        summary(compactResult.compaction.summary, 8000, Date.parse(details.createdAt)),
        user("what next"),
      ],
    },
    {
      sessionManager: {
        getBranch: () => [
          {
            type: "compaction",
            summary: compactResult.compaction.summary,
            tokensBefore: 8000,
            timestamp: details.createdAt,
            details,
          },
        ],
      },
    },
  );
  assert.ok(ctx?.messages);
  assert.equal(ctx.messages.some((item) => item.role === "compactionSummary"), false);
  assert.equal(ctx.messages.some((item) => item.role === "user" && item.content === "run ls"), true);
  assert.equal(ctx.messages.some((item) => item.role === "user" && item.content === "what next"), true);
});

test("registerJevCompaction exposes /jev-status without crashing when key is missing", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: never) => unknown }>();
  const events = new Map<string, Function>();
  registerJevCompaction(
    {
      on(event, handler) {
        events.set(event, handler);
      },
      registerCommand(name, spec) {
        commands.set(name, spec);
      },
    },
    { env: {} },
  );
  assert.equal(commands.has("jev-status"), true);
  const notes: string[] = [];
  await commands.get("jev-status")?.handler("", {
    ui: { notify: (message: string) => notes.push(message) },
    hasUI: true,
    isProjectTrusted: () => false,
    sessionManager: { getBranch: () => [] },
  } as never);
  assert.match(notes.join("\n"), /apiKey: missing/);
  assert.match(notes.join("\n"), /enabled: false/);
  assert.equal(events.has("session_before_compact"), true);
  assert.equal(events.has("context"), true);
});

test("state sent to Jev does not include full tool result text", async () => {
  let captured: unknown;
  const runtime = createRuntime({
    env: { TYPESAFE_API_KEY: "not-a-real-key" },
    configOverride: { enabled: true, preserveRecentMessages: 0, minReductionRatio: 0 },
    judgeFactory: () => ({
      async judge(input) {
        captured = input.state;
        return createMapJudge({ c1: { keepCall: 0.2, keepResult: 0.2 } }).judge(input);
      },
    }),
  });
  const secret = "UNIQUE_RESULT_BODY_SHOULD_NOT_BE_SENT";
  await runtime.handleBeforeCompact(
    {
      preparation: {
        messagesToSummarize: [
          user("see file"),
          assistant([call("c1", "read", { path: "a.ts", token: "sk-ant-secretvalue999" })]),
          result("c1", "read", secret.repeat(10)),
        ],
        firstKeptEntryId: "x",
        tokensBefore: 100,
      },
    },
    { isProjectTrusted: () => false },
  );
  const encoded = JSON.stringify(captured);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("sk-ant-secretvalue999"), false);
});

test("default install stays disabled until explicit enable", async () => {
  const runtime = createRuntime({ env: { TYPESAFE_API_KEY: "not-a-real-key" } });
  const resultValue = await runtime.handleBeforeCompact(
    {
      preparation: {
        messagesToSummarize: [user("hi"), assistant([call("c1", "ls")]), result("c1", "ls", "files")],
        firstKeptEntryId: "keep1",
        tokensBefore: 1000,
      },
    },
    { isProjectTrusted: () => false },
  );
  assert.equal(resultValue, undefined);
  assert.equal(runtime.lastRun(), undefined);
});

test("PI_CODING_AGENT_DIR relocates the global config file", () => {
  const customDir = "/tmp/custom-pi-agent-dir";
  const { config, sources } = loadConfig({
    home: "/tmp/ignored-home",
    env: { PI_CODING_AGENT_DIR: customDir },
    trusted: false,
    readFile: (path) => {
      if (path === `${customDir}/jev-compaction.json`) {
        return { ok: true, value: { enabled: true, keepThreshold: 0.7 } };
      }
      return { ok: false, reason: "missing" };
    },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.keepThreshold, 0.7);
  assert.equal(sources.includes(`${customDir}/jev-compaction.json`), true);
});

test("maxReplayTokens below target is raised with a warning", () => {
  const warnings: string[] = [];
  const config = parseConfig(
    { targetReplayTokens: 90000, maxReplayTokens: 1000 },
    { warn: (message) => warnings.push(message) },
  );
  assert.equal(config.targetReplayTokens, 90000);
  assert.equal(config.maxReplayTokens, 90000);
  assert.equal(warnings.some((item) => item.includes("maxReplayTokens")), true);
});

test("marker helper is stable for matching", () => {
  const marker = compactionMarker("2026-09-18T00:00:00.000Z");
  assert.match(marker, /pi-jev-compaction:v1:2026-09-18T00:00:00.000Z/);
  assert.equal(JEV_COMPACTION_KIND, "pi-jev-compaction");
  assert.equal(JEV_COMPACTION_SCHEMA_VERSION, 1);
});
