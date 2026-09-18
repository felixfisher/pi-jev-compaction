import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyDecisions,
  compactionMarker,
  expandPreviousReplay,
  pairToolCalls,
  replayContextMessages,
} from "../src/2026-09-18_pi-adapter.ts";
import { redactSecrets } from "../src/2026-09-18_redact.ts";
import { JEV_COMPACTION_KIND, JEV_COMPACTION_SCHEMA_VERSION, type AgentMessage } from "../src/2026-09-18_types.ts";
import { assistant, call, result, summary, user } from "./2026-09-18_fixtures.ts";

test("orphan call and result are left unpaired", () => {
  const messages: AgentMessage[] = [
    user("hi"),
    assistant([call("c1", "read", { path: "a.ts" }), call("orphan-call", "ls")]),
    result("c1", "read", "ok"),
    result("orphan-result", "bash", "no matching call"),
  ];
  const paired = pairToolCalls(messages);
  assert.equal(paired.pairs.length, 1);
  assert.equal(paired.pairs[0]?.toolCallId, "c1");
  assert.deepEqual(paired.orphanCallIds, ["orphan-call"]);
  assert.deepEqual(paired.orphanResultIndexes, [3]);
});

test("duplicate toolResult IDs pair first-come and leave extras as orphans", () => {
  const messages: AgentMessage[] = [
    assistant([call("dup", "read", { path: "a.ts" })]),
    result("dup", "read", "first"),
    result("dup", "read", "second"),
  ];
  const paired = pairToolCalls(messages);
  assert.equal(paired.pairs.length, 1);
  assert.equal(paired.pairs[0]?.result.content[0] && "text" in paired.pairs[0].result.content[0] ? paired.pairs[0].result.content[0].text : "", "first");
  assert.deepEqual(paired.orphanResultIndexes, [2]);
});

test("drop_call removes only the target call block from a mixed assistant message", () => {
  const messages: AgentMessage[] = [
    user("do both"),
    assistant([
      { type: "text", text: "I will inspect and list" },
      call("keep-me", "ls"),
      call("drop-me", "read", { path: "secret.ts" }),
    ]),
    result("keep-me", "ls", "a.ts"),
    result("drop-me", "read", "lots of source"),
  ];
  const rebuilt = applyDecisions(
    messages,
    [
      { toolCallId: "keep-me", toolName: "ls", action: "keep" },
      { toolCallId: "drop-me", toolName: "read", action: "drop_call" },
    ],
    (item) => item.content,
  );
  const assistantMsg = rebuilt.find((item) => item.role === "assistant");
  assert.ok(assistantMsg && assistantMsg.role === "assistant");
  const callIds = assistantMsg.content.filter((block) => block.type === "toolCall").map((block) => block.id);
  assert.deepEqual(callIds, ["keep-me"]);
  assert.equal(assistantMsg.content[0]?.type, "text");
  assert.equal(
    rebuilt.some((item) => item.role === "toolResult" && item.toolCallId === "drop-me"),
    false,
  );
  assert.equal(
    rebuilt.some((item) => item.role === "toolResult" && item.toolCallId === "keep-me"),
    true,
  );
});

test("secret and token redaction strips keys without leaking them", () => {
  const original = "Authorization: Bearer sk-ant-secretvalue999 token=ghp_abcdefghijklmnopqr TYPESAFE_API_KEY=super-secret-key";
  const redacted = redactSecrets(original, "balanced");
  assert.equal(redacted.includes("sk-ant-secretvalue999"), false);
  assert.equal(redacted.includes("ghp_abcdefghijklmnopqr"), false);
  assert.equal(redacted.includes("super-secret-key"), false);
  assert.match(redacted, /\[redacted\]/);
});

test("two consecutive compaction expansions keep the first replay", () => {
  const createdAt = "2026-09-18T00:00:00.000Z";
  const marker = compactionMarker(createdAt);
  const firstReplay: AgentMessage[] = [
    user("original task"),
    assistant([{ type: "text", text: "kept from first compaction" }, call("old", "ls")]),
    result("old", "ls", "src"),
  ];
  const details = {
    kind: JEV_COMPACTION_KIND,
    schemaVersion: JEV_COMPACTION_SCHEMA_VERSION,
    extensionVersion: "0.1.0",
    createdAt,
    replayMessages: firstReplay,
    decisions: [],
    stats: {
      messagesBefore: 5,
      messagesAfter: 3,
      charsBefore: 100,
      charsAfter: 50,
      reductionRatio: 0.5,
      kept: 1,
      truncated: 0,
      dropped: 1,
      protected: 0,
      requests: 1,
      elapsedMs: 1,
      model: "jev-latest",
      replayTokens: 10,
      targetReplayTokens: 80000,
      maxReplayTokens: 100000,
      budgetWarning: false,
    },
  };
  const window: AgentMessage[] = [
    summary(`${marker}\nfirst summary`, 900, Date.parse(createdAt)),
    user("continue"),
    assistant([call("new", "read", { path: "a.ts" })]),
    result("new", "read", "file"),
  ];
  const expanded = expandPreviousReplay(window, [
    {
      type: "compaction",
      summary: `${marker}\nfirst summary`,
      tokensBefore: 900,
      timestamp: createdAt,
      details,
    },
  ]);
  assert.equal(expanded.expanded, true);
  assert.equal(expanded.messages[0]?.role, "user");
  assert.equal(expanded.messages.some((item) => item.role === "user" && item.content === "original task"), true);
  assert.equal(expanded.messages.some((item) => item.role === "user" && item.content === "continue"), true);
  assert.equal(expanded.messages.some((item) => item.role === "compactionSummary"), false);
});

test("context replay fail-open when summary does not match", () => {
  const resultReplay = replayContextMessages([summary("native summary"), user("later")], [
    {
      type: "compaction",
      summary: `${compactionMarker("2026-09-18T00:00:00.000Z")}\njev`,
      details: {
        kind: JEV_COMPACTION_KIND,
        schemaVersion: JEV_COMPACTION_SCHEMA_VERSION,
        extensionVersion: "0.1.0",
        createdAt: "2026-09-18T00:00:00.000Z",
        replayMessages: [user("replayed")],
        decisions: [],
        stats: {
          messagesBefore: 1,
          messagesAfter: 1,
          charsBefore: 1,
          charsAfter: 1,
          reductionRatio: 0,
          kept: 0,
          truncated: 0,
          dropped: 0,
          protected: 0,
          requests: 0,
          elapsedMs: 0,
          model: "jev-latest",
          replayTokens: 1,
          targetReplayTokens: 80000,
          maxReplayTokens: 100000,
          budgetWarning: false,
        },
      },
    },
  ]);
  assert.equal(resultReplay.applied, false);
  assert.equal(resultReplay.messages[0]?.role, "compactionSummary");
});
