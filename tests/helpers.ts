import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the fake `codex` app-server fixture binary. */
export function fakeCodexPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-codex", "codex");
}
