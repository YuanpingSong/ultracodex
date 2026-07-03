/**
 * Shared contracts for ultracodex. Every module codes against these types.
 * Semantics mirror the upstream Claude Code Workflow tool (see
 * fixtures/workflow_schema.json) — dual-runnability is the compatibility bar.
 */

// ---------------------------------------------------------------------------
// Workflow script surface (upstream-compatible)
// ---------------------------------------------------------------------------

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  effort?: Effort;
  isolation?: "worktree";
  agentType?: string;
}

/** The globals injected into a workflow script body. */
export interface WorkflowGlobals {
  agent(prompt: string, opts?: AgentOpts): Promise<unknown>;
  parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]>;
  pipeline(items: unknown[], ...stages: PipelineStage[]): Promise<unknown[]>;
  phase(title: string): void;
  log(message: string): void;
  args: unknown;
  budget: BudgetView;
  workflow(nameOrRef: string | { scriptPath: string }, args?: unknown): Promise<unknown>;
}

export type PipelineStage = (
  prevResult: unknown,
  originalItem: unknown,
  index: number,
) => unknown | Promise<unknown>;

export interface BudgetView {
  readonly total: number | null;
  spent(): number;
  remaining(): number;
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

/** Mirrors codex app-server TokenUsageBreakdown (fixtures/appserver/ts/v2). */
export interface Usage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export const ZERO_USAGE: Usage = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

// ---------------------------------------------------------------------------
// Executor interface (§3.2) — one per backend (codex, claude, fake)
// ---------------------------------------------------------------------------

export type ActivityKind = "exec" | "patch" | "tool" | "search" | "reasoning" | "status";
export type ActivityPhase = "running" | "verifying";

export interface ActivityEvent {
  kind: ActivityKind;
  text: string;
  /** "verifying" when a command matches the verification regex, else "running". */
  phase?: ActivityPhase;
}

export interface ExecutorRequest {
  prompt: string;
  /** Raw JSON Schema from the script (NOT strictified — executor strictifies). */
  schema?: Record<string, unknown>;
  /** Workflow-level tier name (opus/sonnet/haiku/fable/...) — executor maps via config. */
  model?: string;
  /** Workflow-level effort — executor maps via config (max → xhigh for codex). */
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
  run(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult>;
}

// ---------------------------------------------------------------------------
// Journal events (§4) — THE SPINE. TUI/CLI render from these only.
// ---------------------------------------------------------------------------

export type AgentStatus = "ok" | "failed" | "skipped";
export type RunStatus = "ok" | "failed" | "stopped";

export interface RunStartEvent {
  t: "run_start";
  ts: number;
  runId: string;
  meta: WorkflowMeta;
  scriptSha: string;
  /** Relative path to args snapshot within the run dir (null if no args). */
  argsRef: string | null;
  budgetTotal: number | null;
  concurrency: number;
}

export interface PhaseEvent {
  t: "phase";
  ts: number;
  title: string;
}

export interface AgentStartEvent {
  t: "agent_start";
  ts: number;
  /** 1-based agent ordinal within the run. */
  n: number;
  label: string;
  phase: string | null;
  backend: string;
  /** Resolved backend model (e.g. gpt-5.4), not the tier name. */
  model: string | null;
  effort: string | null;
  promptSha: string;
  /** Relative path to the prompt snapshot within the run dir. */
  promptRef: string;
  hasSchema: boolean;
}

/** Emitted once per agent when the backend thread/session id becomes known. */
export interface AgentThreadEvent {
  t: "agent_thread";
  ts: number;
  n: number;
  threadId: string;
}

export interface AgentActivityEvent {
  t: "agent_activity";
  ts: number;
  n: number;
  kind: ActivityKind;
  /** Truncated to ACTIVITY_TEXT_MAX; raw stream goes to agents/<n>/events.jsonl. */
  text: string;
  phase?: ActivityPhase;
}

export interface AgentUsageEvent {
  t: "agent_usage";
  ts: number;
  n: number;
  usage: Usage;
}

export interface AgentEndEvent {
  t: "agent_end";
  ts: number;
  n: number;
  status: AgentStatus;
  ms: number;
  usage: Usage;
  /** Relative path to output snapshot (output.txt or output.json) or null. */
  resultRef: string | null;
  error: string | null;
  /** Kept dirty worktree path, when isolation left changes behind. */
  worktreePath?: string;
}

export interface LogEvent {
  t: "log";
  ts: number;
  text: string;
}

export interface WarnEvent {
  t: "warn";
  ts: number;
  text: string;
}

export interface PausedEvent {
  t: "paused";
  ts: number;
}

export interface ResumedEvent {
  t: "resumed";
  ts: number;
}

export interface RunEndEvent {
  t: "run_end";
  ts: number;
  status: RunStatus;
  /** Relative path to result.json, or null when failed/stopped before return. */
  resultRef: string | null;
  error: string | null;
  totals: RunTotals;
}

export interface RunTotals {
  agents: number;
  ok: number;
  failed: number;
  skipped: number;
  /** Per-backend usage ledgers. */
  usage: Record<string, Usage>;
  ms: number;
}

export type JournalEvent =
  | RunStartEvent
  | PhaseEvent
  | AgentStartEvent
  | AgentThreadEvent
  | AgentActivityEvent
  | AgentUsageEvent
  | AgentEndEvent
  | LogEvent
  | WarnEvent
  | PausedEvent
  | ResumedEvent
  | RunEndEvent;

// ---------------------------------------------------------------------------
// Control channel (§4a) — CLI/TUI append to control.jsonl; runner tails it
// ---------------------------------------------------------------------------

export type ControlCommand =
  | { cmd: "stop" }
  | { cmd: "pause" }
  | { cmd: "resume" }
  | { cmd: "skip"; n: number };

// ---------------------------------------------------------------------------
// Config (.ultracodex/config.toml, ~/.ultracodex/config.toml fallback)
// ---------------------------------------------------------------------------

export interface RouteRule {
  /** Glob pattern matched against agent label first, then phase. `*` matches all. */
  pattern: string;
  backend: string;
}

export interface CodexBackendConfig {
  /** Binary name/path, default "codex". Tests override to the fake. */
  binary: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** Model used when the script omits opts.model. */
  defaultModel: string;
  /** tier name → codex model id. */
  modelMap: Record<string, string>;
  /** workflow effort → codex effort (max → xhigh). */
  effortMap: Record<string, string>;
  /** Effort used when the script omits opts.effort (null → model default). */
  defaultEffort: string | null;
  /** codex service tier pinned per spawn; "standard" disables fast mode even
   *  when the user's ~/.codex/config.toml enables it. null → inherit. */
  serviceTier: string | null;
  /** Extra argv appended to every `codex app-server` spawn (e.g. -c overrides). */
  extraArgs: string[];
  /** ajv-validation repair attempts on the same thread. Default 3. */
  schemaRetries: number;
}

export interface ClaudeBackendConfig {
  binary: string;
  defaultModel: string;
  modelMap: Record<string, string>;
  schemaRetries: number;
  /** Extra argv appended to every `claude -p` spawn — headless claude needs
   *  explicit tool permissions (e.g. ["--allowedTools", "Read", "Grep"]) for
   *  agents that must read files; without them it degrades to context-free
   *  text prediction. */
  extraArgs: string[];
}

export interface AgentProfileConfig {
  /** Overrides backend sandbox for this profile (e.g. Explore → read-only). */
  sandbox?: string;
  /** Extra preamble prepended to the prompt for this profile. */
  preamble?: string;
}

export interface UltracodexConfig {
  /** Ordered; first match wins. Always ends with a catch-all. */
  route: RouteRule[];
  concurrency: number | null;
  codex: CodexBackendConfig;
  claude: ClaudeBackendConfig;
  profiles: Record<string, AgentProfileConfig>;
}

// ---------------------------------------------------------------------------
// Run directory + runner process contract
// ---------------------------------------------------------------------------

export interface RunOptions {
  runId: string;
  runDir: string;
  scriptPath: string; // snapshot inside runDir
  argsPath: string | null;
  budgetTotal: number | null;
  concurrency: number;
  strict: boolean;
  /** Project root the run executes against (agents' default cwd). */
  projectDir: string;
}

/** Row for `ultracodex ls` / TUI home, derived from journal + pidfile. */
export interface RunSummary {
  runId: string;
  runDir: string;
  name: string | null;
  status: RunStatus | "running" | "dead";
  startedAt: number | null;
  endedAt: number | null;
  agentsDone: number;
  agentsTotal: number;
  outputTokens: number;
  pid: number | null;
  pidAlive: boolean;
}
