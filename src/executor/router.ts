import { routeBackend } from "../config.js";
import type { Executor, UltracodexConfig } from "../types.js";
import { CodexExecutor } from "./codex.js";
import { ClaudeExecutor } from "./claude.js";

export function createExecutors(config: UltracodexConfig): Record<string, Executor> {
  return {
    codex: new CodexExecutor(config.codex, config.profiles),
    claude: new ClaudeExecutor(config.claude, config.profiles),
  };
}

export function pickExecutor(
  executors: Record<string, Executor>,
  config: UltracodexConfig,
  label: string,
  phase: string | null,
): Executor {
  const backend = routeBackend(config, label, phase);
  const executor = executors[backend];
  if (!executor) {
    throw new Error(
      `route resolved agent "${label}" to unknown backend "${backend}" (available: ${Object.keys(executors).join(", ") || "none"})`,
    );
  }
  return executor;
}
