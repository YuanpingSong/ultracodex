import os from "node:os";
import type { CodexBackendConfig, ClaudeBackendConfig, UltracodexConfig } from "./types.js";

// Upstream Workflow tool caps (fixtures/workflow_schema.json) — do not change.
export const LIFETIME_AGENT_CAP = 1000;
export const FANOUT_ITEM_CAP = 4096;

export function defaultConcurrency(): number {
  return Math.max(1, Math.min(16, os.cpus().length - 2));
}

// Journal / activity shaping (§4).
export const ACTIVITY_THROTTLE_MS = 250;
export const ACTIVITY_TEXT_MAX = 200;

// app-server turn completion inference (plugin's captureTurn).
export const INFER_COMPLETION_MS = 250;

// Schema repair attempts on the same thread.
export const DEFAULT_SCHEMA_RETRIES = 3;

// Graceful shutdown: turn/interrupt → SIGTERM → SIGKILL.
export const INTERRUPT_GRACE_MS = 5_000;
export const SIGTERM_GRACE_MS = 5_000;

export const RUN_ID_PREFIX = "uc_";

// Run directory layout (§4).
export const STATE_DIR_NAME = ".ultracodex";
export const RUNS_DIR_NAME = "runs";
export const WORKFLOWS_DIR_NAME = "workflows";
export const JOURNAL_FILE = "journal.jsonl";
export const CONTROL_FILE = "control.jsonl";
export const PID_FILE = "pid";
export const SCRIPT_SNAPSHOT = "script.js";
export const ARGS_SNAPSHOT = "args.json";
export const OPTIONS_SNAPSHOT = "options.json";
export const RESULT_FILE = "result.json";
export const AGENTS_DIR = "agents";
export const RUNNER_LOG_FILE = "runner.log";

/**
 * Model map decided against the live lineup (probe 2026-07-02):
 * gpt-5.5 (default, strongest), gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark.
 * All support efforts low|medium|high|xhigh.
 */
export const DEFAULT_CODEX_CONFIG: CodexBackendConfig = {
  binary: "codex",
  sandbox: "workspace-write",
  // codex's own default (model/list isDefault) — matches upstream "inherit
  // the main-loop model" semantics for agents that don't pin a tier.
  defaultModel: "gpt-5.5",
  modelMap: {
    fable: "gpt-5.5",
    opus: "gpt-5.5",
    sonnet: "gpt-5.4",
    haiku: "gpt-5.4-mini",
    spark: "gpt-5.3-codex-spark",
  },
  effortMap: {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "xhigh",
  },
  schemaRetries: DEFAULT_SCHEMA_RETRIES,
};

export const DEFAULT_CLAUDE_CONFIG: ClaudeBackendConfig = {
  binary: "claude",
  defaultModel: "sonnet",
  modelMap: {},
  schemaRetries: DEFAULT_SCHEMA_RETRIES,
};

export const DEFAULT_CONFIG: UltracodexConfig = {
  route: [{ pattern: "*", backend: "codex" }],
  concurrency: null,
  codex: DEFAULT_CODEX_CONFIG,
  claude: DEFAULT_CLAUDE_CONFIG,
  profiles: {
    Explore: {
      sandbox: "read-only",
      preamble:
        "You are a read-only exploration agent. Do not modify any files or system state; only read, search, and report.",
    },
    Plan: {
      sandbox: "read-only",
      preamble:
        "You are a planning agent. Do not modify any files; produce analysis and plans only.",
    },
  },
};

/**
 * Verification-phase inference for activity lines (stolen from the codex
 * plugin's looksLikeVerificationCommand).
 */
export const VERIFICATION_COMMAND_RE =
  /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;

/**
 * Prefix injected ahead of every subagent prompt (upstream semantic: agents
 * are told their final text IS the return value).
 */
export const RETURN_VALUE_CONTRACT =
  "Your final message IS the return value consumed by a program — return raw data exactly as asked, not a chatty summary. Never ask questions; act on stated defaults and finish the task.";
