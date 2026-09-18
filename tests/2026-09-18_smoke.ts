import { registerJevCompaction } from "../src/2026-09-18_runtime.ts";
import factory from "../extensions/index.ts";

const commands = new Map<string, { description?: string; handler: (args: string, ctx: never) => unknown }>();
const events: string[] = [];
const notes: string[] = [];

const mockPi = {
  on(event: string, _handler: unknown) {
    events.push(event);
  },
  registerCommand(
    name: string,
    spec: { description?: string; handler: (args: string, ctx: never) => unknown },
  ) {
    commands.set(name, spec);
  },
};

factory(mockPi as never);
registerJevCompaction(mockPi, { env: {} });

if (!events.includes("session_before_compact") || !events.includes("context")) {
  throw new Error("extension did not register required events");
}
if (!commands.has("jev-status")) {
  throw new Error("/jev-status was not registered");
}

await commands.get("jev-status")?.handler("", {
  ui: { notify: (message: string) => notes.push(message) },
  hasUI: true,
  isProjectTrusted: () => false,
  sessionManager: { getBranch: () => [] },
} as never);

const text = notes.join("\n");
if (!text.includes("apiKey: missing") || !text.includes("pi-jev-compaction") || !text.includes("enabled: false")) {
  throw new Error(`unexpected status output: ${text}`);
}
if (text.includes("sk" + "-") || text.includes("TYPESAFE_API_KEY" + "=")) {
  throw new Error("status output looks like it leaked a key");
}

process.stdout.write("smoke ok: factory loaded, /jev-status works without API key\n");
