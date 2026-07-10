import { loadConfig } from "../config.js";
import type { UltracodexConfig } from "../types.js";

// A lightweight, synchronous "doctor" for the TUI header: the default backend
// and model, plus which other backends the route table wires in. Deliberately
// static — the live probes (auth, binary version, app-server reachability) stay
// in `ultracodex doctor`, which is too heavy to run on a render loop.

export interface StatusSummary {
  ok: boolean;
  /** The catch-all ("*") route backend — what an unlabelled agent runs on. */
  backend: string;
  /** The default model for that backend. */
  model: string;
  /** Backends referenced by any route rule other than the default backend. */
  extraBackends: string[];
  /** Present only when config failed to parse. */
  error?: string;
}

function defaultModelFor(config: UltracodexConfig, backend: string): string {
  if (backend === "claude") return config.claude.defaultModel;
  if (backend === "opencode") return config.opencode.model;
  if (backend === "codex") return config.codex.defaultModel;
  // A mistyped/unknown catch-all backend has no model — don't fabricate codex's.
  return "(unknown backend)";
}

export function summarizeConfig(config: UltracodexConfig): StatusSummary {
  const catchAll = config.route.find((r) => r.pattern === "*");
  const backend = catchAll?.backend ?? "codex";
  const extraBackends = [...new Set(config.route.map((r) => r.backend))].filter((b) => b !== backend);
  return { ok: true, backend, model: defaultModelFor(config, backend), extraBackends };
}

export function loadStatus(projectDir: string): StatusSummary {
  try {
    return summarizeConfig(loadConfig(projectDir));
  } catch (err) {
    return {
      ok: false,
      backend: "?",
      model: "?",
      extraBackends: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
