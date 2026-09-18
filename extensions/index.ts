import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerJevCompaction } from "../src/2026-09-18_runtime.ts";

export default function piJevCompaction(pi: ExtensionAPI): void {
  registerJevCompaction(pi);
}
