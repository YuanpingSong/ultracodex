import type { ActivityEvent, Effort, Usage } from "../types.js";

export interface CapabilityDescriptor {
  schema: "wire" | "prompt-only";
  resume: boolean;
  interrupt: "graceful" | "kill-only";
  usage: "per-turn" | "final" | "none";
  activity: boolean;
  sandbox: string[];
}

export interface ExecutorRequest {
  prompt: string;
  /** Raw JSON Schema from the script (NOT strictified — executor strictifies). */
  schema?: Record<string, unknown>;
  /** Workflow-level tier name (opus/sonnet/haiku/fable/...) — executor maps via config. */
  model?: string;
  /** Workflow-level effort — executor maps via config (identity on codex ≥0.144). */
  effort?: Effort;
  cwd: string;
  label: string;
  /** agentType from the script — resolved to a config-defined profile. */
  agentProfile?: string;
}

export interface ExecutorContext {
  signal: AbortSignal;
  onActivity(ev: ActivityEvent): void;
  /** Cumulative usage for this agent call so far (monotonic ticks). */
  onUsage(usage: Usage): void;
  /** Called once when the backend session/thread id becomes known. */
  onThread?(threadId: string): void;
}

export type ExecutorResult =
  | {
      ok: true;
      /** Final message text (schema-less calls). */
      text?: string;
      /** Validated parsed object (schema calls). */
      object?: unknown;
      usage: Usage;
      threadId?: string;
    }
  | {
      ok: false;
      error: string;
      usage?: Usage;
      threadId?: string;
    };

export interface Executor {
  readonly backend: string;
  readonly capabilities: CapabilityDescriptor;
  run(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult>;
}
