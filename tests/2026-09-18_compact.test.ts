import assert from "node:assert/strict";
import { test } from "node:test";
import { compactWindow, createMapJudge, decideAction, truncateResultContent } from "../src/2026-09-18_compact.ts";
import { compactionMarker } from "../src/2026-09-18_pi-adapter.ts";
import { JEV_COMPACTION_KIND, JEV_COMPACTION_SCHEMA_VERSION, type AgentMessage } from "../src/2026-09-18_types.ts";
import { assistant, call, config, conversation, result, summary, user } from "./2026-09-18_fixtures.ts";

test("decideAction uses result then call thresholds", () => {
  assert.equal(decideAction(0.1, 0.9, 0.5), "keep");
  assert.equal(decideAction(0.9, 0.1, 0.5), "truncate_result");
  assert.equal(decideAction(0.1, 0.1, 0.5), "drop_call");
  assert.equal(decideAction(0.5, 0.5, 0.5), "keep");
});

test("single tool keep retains call and full result", async () => {
  const messages = conversation([["k1", "bash", "hello world ".repeat(20), { command: "echo hi" }]]);
  const outcome = await compactWindow({
    messages,
    config: config(),
    judge: createMapJudge({ k1: { keepCall: 0.9, keepResult: 0.9 } }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const replay = outcome.details.replayMessages;
  assert.equal(replay.some((item) => item.role === "toolResult" && item.toolCallId === "k1"), true);
  const toolResult = replay.find((item) => item.role === "toolResult" && item.toolCallId === "k1");
  assert.ok(toolResult && toolResult.role === "toolResult");
  const text = toolResult.content[0] && "text" in toolResult.content[0] ? toolResult.content[0].text : "";
  assert.match(text, /hello world/);
  assert.equal(outcome.details.decisions[0]?.action, "keep");
});

test("truncate_result keeps the call and replaces the result text", async () => {
  const long = "ABCDEFGHIJ".repeat(80);
  const messages = conversation([["t1", "bash", long, { command: "seq 1000" }]]);
  const outcome = await compactWindow({
    messages,
    config: config({ truncateHeadChars: 20, truncateTailChars: 20 }),
    judge: createMapJudge({ t1: { keepCall: 0.9, keepResult: 0.1 } }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const assistantMsg = outcome.details.replayMessages.find((item) => item.role === "assistant");
  assert.ok(assistantMsg && assistantMsg.role === "assistant");
  assert.equal(assistantMsg.content.some((block) => block.type === "toolCall" && block.id === "t1"), true);
  const toolResult = outcome.details.replayMessages.find((item) => item.role === "toolResult");
  assert.ok(toolResult && toolResult.role === "toolResult");
  const text = toolResult.content[0] && "text" in toolResult.content[0] ? toolResult.content[0].text : "";
  assert.ok(text.length < long.length);
  assert.match(text, /omitted|truncated/);
  assert.equal(outcome.details.decisions[0]?.action, "truncate_result");
});

test("drop_call removes both the call block and the result", async () => {
  const messages: AgentMessage[] = [
    user("inspect"),
    assistant([{ type: "text", text: "looking" }, call("d1", "read", { path: "big.ts" })]),
    result("d1", "read", "huge file ".repeat(50)),
  ];
  const outcome = await compactWindow({
    messages,
    config: config(),
    judge: createMapJudge({ d1: { keepCall: 0.1, keepResult: 0.1 } }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const assistantMsg = outcome.details.replayMessages.find((item) => item.role === "assistant");
  assert.ok(assistantMsg && assistantMsg.role === "assistant");
  assert.equal(assistantMsg.content.some((block) => block.type === "toolCall"), false);
  assert.equal(outcome.details.replayMessages.some((item) => item.role === "toolResult"), false);
  assert.equal(outcome.details.decisions[0]?.action, "drop_call");
});

test("edit and write are permanently protected", async () => {
  const messages: AgentMessage[] = [
    user("change files"),
    assistant([call("e1", "edit", { path: "a.ts" }), call("w1", "write", { path: "b.ts" })]),
    result("e1", "edit", "patched"),
    result("w1", "write", "wrote"),
  ];
  const outcome = await compactWindow({
    messages,
    config: config(),
    judge: createMapJudge({
      e1: { keepCall: 0, keepResult: 0 },
      w1: { keepCall: 0, keepResult: 0 },
    }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    outcome.details.decisions.map((item) => [item.toolCallId, item.action, item.protectedReason]),
    [
      ["e1", "protected", "protect_tool"],
      ["w1", "protected", "protect_tool"],
    ],
  );
  assert.equal(outcome.details.replayMessages.filter((item) => item.role === "toolResult").length, 2);
});

test("error results are permanently protected", async () => {
  const messages: AgentMessage[] = [
    user("run it"),
    assistant([call("err1", "bash", { command: "false" })]),
    result("err1", "bash", "boom", { isError: true }),
  ];
  const outcome = await compactWindow({
    messages,
    config: config(),
    judge: createMapJudge({ err1: { keepCall: 0, keepResult: 0 } }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.details.decisions[0]?.action, "protected");
  assert.equal(outcome.details.decisions[0]?.protectedReason, "error");
});

test("recent messages are protected", async () => {
  const messages: AgentMessage[] = [
    user("old"),
    assistant([call("old1", "read", { path: "old.ts" })]),
    result("old1", "read", "old-content ".repeat(40)),
    user("new"),
    assistant([call("new1", "read", { path: "new.ts" })]),
    result("new1", "read", "new-content ".repeat(40)),
  ];
  const outcome = await compactWindow({
    messages,
    config: config({ preserveRecentMessages: 3 }),
    judge: createMapJudge({
      old1: { keepCall: 0.1, keepResult: 0.1 },
      new1: { keepCall: 0.1, keepResult: 0.1 },
    }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const byId = Object.fromEntries(outcome.details.decisions.map((item) => [item.toolCallId, item]));
  assert.equal(byId.old1?.action, "drop_call");
  assert.equal(byId.new1?.action, "protected");
  assert.equal(byId.new1?.protectedReason, "recent");
});

test("minReductionRatio fallback when keep does not shrink enough", async () => {
  const messages = conversation([["k1", "read", "short", { path: "a.ts" }]]);
  const outcome = await compactWindow({
    messages,
    config: config({ minReductionRatio: 0.9 }),
    judge: createMapJudge({ k1: { keepCall: 1, keepResult: 1 } }),
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "min_reduction_ratio");
});

test("malformed Jev answers fall back", async () => {
  const messages = conversation([["k1", "read", "abc", { path: "a.ts" }]]);
  const outcome = await compactWindow({
    messages,
    config: config(),
    judge: {
      async judge() {
        return { model: "jev-latest", answers: { keep_call_k1: { noul: Number.NaN } }, requests: 1 };
      },
    },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /malformed/);
});

test("bash truncation keeps head, tail, and exit info", () => {
  const text = "HEADDATA".repeat(40) + "TAILDATA".repeat(40);
  const truncated = truncateResultContent(
    result("b1", "bash", text, { details: { exitCode: 0 } }),
    "bash",
    config({ truncateHeadChars: 16, truncateTailChars: 16 }),
  );
  const out = truncated[0] && "text" in truncated[0] ? truncated[0].text : "";
  assert.match(out, /HEADDATA/);
  assert.match(out, /TAILDATA/);
  assert.match(out, /exitCode=0/);
  assert.match(out, /omitted|truncated/);
});

test("read truncation tells the model it can re-run", () => {
  const truncated = truncateResultContent(
    result("r1", "read", "LINE\n".repeat(80)),
    "read",
    config({ truncateHeadChars: 20 }),
  );
  const out = truncated[0] && "text" in truncated[0] ? truncated[0].text : "";
  assert.match(out, /Re-run the original tool/);
});

test("toolResult images do not throw during truncation", () => {
  const truncated = truncateResultContent(
    result("img", "read", "caption", {
      extra: [{ type: "image", data: "AAA", mimeType: "image/png" }],
    }),
    "read",
    config({ truncateHeadChars: 10 }),
  );
  assert.equal(truncated.some((block) => block.type === "image"), false);
  assert.equal(truncated.some((block) => block.type === "text" && /image omitted/.test(block.text)), true);
});

test("second compaction expands the first replay instead of nesting details", async () => {
  const firstMessages: AgentMessage[] = [
    user("start"),
    assistant([{ type: "text", text: "first pass" }, call("old", "bash", { command: "ls" })]),
    result("old", "bash", "src dist node_modules ".repeat(30)),
  ];
  const first = await compactWindow({
    messages: firstMessages,
    config: config(),
    judge: createMapJudge({ old: { keepCall: 0.9, keepResult: 0.1 } }),
    now: () => Date.parse("2026-09-18T01:00:00.000Z"),
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const marker = compactionMarker(first.details.createdAt);
  const secondWindow: AgentMessage[] = [
    summary(first.summary, 2000, Date.parse(first.details.createdAt)),
    user("more"),
    assistant([call("new", "read", { path: "a.ts" })]),
    result("new", "read", "export const x = 1\n".repeat(40)),
  ];
  const second = await compactWindow({
    messages: secondWindow,
    config: config(),
    judge: createMapJudge({
      old: { keepCall: 0.9, keepResult: 0.1 },
      new: { keepCall: 0.1, keepResult: 0.1 },
    }),
    branchEntries: [
      {
        type: "compaction",
        summary: first.summary,
        tokensBefore: 2000,
        timestamp: first.details.createdAt,
        details: first.details,
      },
    ],
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.details.replayMessages.some((item) => item.role === "compactionSummary"), false);
  assert.equal(
    JSON.stringify(second.details.replayMessages).includes(JEV_COMPACTION_KIND) &&
      second.details.replayMessages.some((item) => JSON.stringify(item).includes('"replayMessages"')),
    false,
  );
  assert.equal(second.details.replayMessages.some((item) => item.role === "user" && item.content === "start"), true);
  assert.equal(second.details.replayMessages.some((item) => item.role === "user" && item.content === "more"), true);
  assert.equal(second.details.replayMessages.some((item) => item.role === "toolResult" && item.toolCallId === "new"), false);
  assert.match(second.summary, new RegExp(marker.slice(0, 20)));
  assert.equal("details" in (second.details.replayMessages[0] ?? {}), false);
});

test("replay under target has no budget warning", async () => {
  const messages = conversation([["k1", "read", "short", { path: "a.ts" }]]);
  const outcome = await compactWindow({
    messages,
    config: config({ targetReplayTokens: 1_000_000, maxReplayTokens: 2_000_000 }),
    judge: createMapJudge({ k1: { keepCall: 1, keepResult: 1 } }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.details.stats.budgetWarning, false);
  assert.ok(outcome.details.stats.replayTokens > 0);
  assert.ok(outcome.details.stats.replayTokens <= outcome.details.stats.targetReplayTokens);
});

test("replay between target and max sets budgetWarning", async () => {
  const messages = conversation([["k1", "read", "payload ".repeat(80), { path: "a.ts" }]]);
  const outcome = await compactWindow({
    messages,
    config: config({ targetReplayTokens: 1, maxReplayTokens: 2_000_000 }),
    judge: createMapJudge({ k1: { keepCall: 1, keepResult: 1 } }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.details.stats.budgetWarning, true);
  assert.ok(outcome.details.stats.replayTokens > outcome.details.stats.targetReplayTokens);
  assert.ok(outcome.details.stats.replayTokens <= outcome.details.stats.maxReplayTokens);
});

test("replay over maxReplayTokens falls back", async () => {
  const messages = conversation([["k1", "read", "payload ".repeat(80), { path: "a.ts" }]]);
  const outcome = await compactWindow({
    messages,
    config: config({ targetReplayTokens: 1, maxReplayTokens: 2 }),
    judge: createMapJudge({ k1: { keepCall: 1, keepResult: 1 } }),
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.reason, "max_replay_tokens");
});
