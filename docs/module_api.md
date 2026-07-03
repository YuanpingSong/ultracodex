# ultracodex module API contract

Implementation agents: implement EXACTLY these exports (names + signatures).
All types come from `src/types.ts`; constants from `src/constants.ts`.
ESM + NodeNext: relative imports MUST use `.js` suffixes (`from "./types.js"`).
Do not invent additional cross-module dependencies beyond what is listed.

## src/ids.ts
```ts
export function newRunId(): string;              // "uc_" + base36(now) + base36 random, ~12 chars total
export function sha256Hex(text: string): string;
export function slugify(text: string): string;   // safe dir-name fragment, lowercase, [a-z0-9-]
```

## src/config.ts
Depends on: types, constants, smol-toml.
```ts
export function loadConfig(projectDir: string): UltracodexConfig;
// merge order: DEFAULT_CONFIG ← ~/.ultracodex/config.toml ← <projectDir>/.ultracodex/config.toml
// TOML shape mirrors docs/product_context.md §2: [route] table (key=pattern, value=backend,
// preserves file order; a "*" fallback appended if absent), [backends.codex], [backends.claude],
// [profiles.<name>]. Unknown keys ignored with no error. concurrency under top-level [run] table
// optional: run.concurrency.
export function matchGlob(pattern: string, value: string): boolean; // '*' wildcard segments only
export function routeBackend(config: UltracodexConfig, label: string, phase: string | null): string;
// label matched first against every rule in order, then phase; first match wins; default "codex"
```

## src/loader.ts
Depends on: types, acorn, node:vm.
```ts
export interface LoadedScript {
  meta: WorkflowMeta;
  /** Compiled body — call with the injected globals. Return value = workflow result. */
  body: (globals: WorkflowGlobals) => Promise<unknown>;
  source: string;
}
export class ScriptError extends Error { line?: number }
export function parseMeta(source: string): { meta: WorkflowMeta; metaStart: number; metaEnd: number };
// acorn parse (ecmaVersion: "latest", sourceType: "module"). First statement MUST be
// `export const meta = {...}` with a PURE object literal (only literals, arrays, objects,
// template strings WITHOUT expressions). Statically evaluate to WorkflowMeta. Throw ScriptError
// on: missing meta, impure expression, missing name/description.
export function loadScript(source: string, opts: { strict: boolean }): LoadedScript;
// Strip the meta statement (replace with whitespace of equal length to preserve line numbers).
// Wrap: `(async ({agent, parallel, pipeline, phase, log, args, budget, workflow}) => {\n<body>\n})`
// Compile with new vm.Script(...).runInNewContext(context) where context has console (forwarding
// to process.stderr), setTimeout/clearTimeout, URL, structuredClone, JSON/Math/Date etc. come from
// the vm's own intrinsics. Body may use top-level await + return (the async wrapper provides both).
// strict: true → in-context Date.now, Math.random throw; `new Date()` with no args throws
// (subclass shim); non-strict → leave intrinsics alone.
// The vm context is accident-prevention, not security: no require/process/fs exposed.
```

## src/journal.ts
Depends on: types, constants, node:fs.
```ts
export class JournalWriter {
  constructor(runDir: string);          // opens append fd to journal.jsonl
  append(ev: JournalEvent): void;       // JSON.stringify + "\n", synchronous write (durability > speed)
  close(): void;
}
export function readJournal(runDir: string): JournalEvent[];   // tolerate trailing partial line
export function tailJournal(
  runDir: string,
  onEvent: (ev: JournalEvent) => void,
  opts?: { signal?: AbortSignal; pollMs?: number },
): () => void;
// Replays existing events, then follows appends: fs.watch on the file plus a slow poll fallback
// (pollMs default 500) reading from a byte offset. Returns a stop function. Must handle the file
// not existing yet (wait for it).
```

## src/rundir.ts
Depends on: types, constants, ids, journal(readJournal), node:fs/path/os.
```ts
export function stateDir(projectDir: string): string;                    // <projectDir>/.ultracodex
export function runsDir(projectDir: string): string;
export function createRunDir(projectDir: string, runId: string): string; // mkdir -p runs/<runId>/agents
export function writePidFile(runDir: string, pid: number): void;
export function readPid(runDir: string): number | null;
export function pidAlive(pid: number): boolean;                          // process.kill(pid, 0)
export function agentDir(runDir: string, n: number, label: string): string; // agents/<n>-<slug> (mkdir)
export function listRuns(projectDir: string): RunSummary[];              // newest first; folds journal
export function resolveRunId(projectDir: string, ref: string): string;
// exact match, else unique-prefix; ambiguous → throw Error listing candidates; none → throw
```

## src/control.ts
Depends on: types, constants, node:fs.
```ts
export function appendControl(runDir: string, cmd: ControlCommand): void;
export function tailControl(
  runDir: string,
  onCommand: (cmd: ControlCommand) => void,
  opts?: { signal?: AbortSignal; pollMs?: number },
): () => void;
// Follows appends only (does NOT replay commands from before attach... actually it MUST process
// commands appended at any time after the runner starts; runner calls this at startup so replay
// from byte 0 is correct). Handle file not existing yet.
```

## src/appserver/client.ts
Depends on: node:child_process, node:readline. No project deps beyond types.
```ts
export interface AppServerClientOptions {
  binary: string;               // "codex" or the fake
  cwd: string;
  env?: NodeJS.ProcessEnv;
}
export class RpcError extends Error { code?: number; data?: unknown }
export class AppServerClient {
  static start(opts: AppServerClientOptions): Promise<AppServerClient>;
  // spawn(binary, ["app-server"], {stdio: pipe*3}); JSONL over stdin/stdout; perform
  // initialize handshake (clientInfo name "ultracodex", opt out of delta notifications:
  // item/agentMessage/delta, item/reasoning/summaryTextDelta, item/reasoning/summaryPartAdded,
  // item/reasoning/textDelta) then send `initialized` notification.
  request<T = unknown>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params: unknown): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  // Server→client REQUESTS (messages with id + method, e.g. approval asks): respond
  // automatically with {decision: "denied"} and surface via onNotification too.
  close(): Promise<void>;      // end stdin, wait exit w/ 2s timeout, then SIGKILL process tree
  kill(): void;                // immediate SIGKILL process tree
  readonly pid: number | null;
  readonly exited: Promise<number | null>;
}
```

## src/appserver/turn.ts
Depends on: client, types, constants.
```ts
export interface RunTurnOptions {
  client: AppServerClient;
  threadId: string;
  prompt: string;
  model: string | null;          // codex model id, already mapped
  effort: string | null;         // codex effort, already mapped
  outputSchema?: Record<string, unknown> | null;
  signal: AbortSignal;           // abort → turn/interrupt, then resolve status "interrupted"
  onActivity(ev: ActivityEvent): void;
  onUsage(usage: Usage): void;   // cumulative per-agent-call usage ticks
}
export interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  finalText: string | null;      // last agentMessage with phase "final_answer" (fallback: last agentMessage)
  turnId: string | null;
  usage: Usage;                  // total for THIS turn (from thread/tokenUsage/updated `last`)
  error: string | null;
}
export function runTurn(opts: RunTurnOptions): Promise<TurnResult>;
// The captureTurn state machine (see docs/product_context.md §3.3 and the codex plugin):
// - send turn/start {threadId, input: [{type:"text", text: prompt, text_elements: []}], model,
//   effort, outputSchema}; response carries turn id — but notifications may arrive first: buffer
//   notifications until turnId known, then route by threadId+turnId (accept subagent thread events).
// - item/started + item/completed → describeItem → onActivity (kind mapping: commandExecution→exec
//   w/ VERIFICATION_COMMAND_RE phase, fileChange→patch, mcpToolCall/dynamicToolCall/
//   collabAgentToolCall→tool, webSearch→search, reasoning→reasoning, others→status).
// - agentMessage item/completed with phase "final_answer" → record text, mark finalAnswerSeen.
// - collabAgentToolCall started/completed tracked as pendingCollabs; turn/started on OTHER threadIds
//   tracked as activeSubagentTurns, removed on their turn/completed.
// - thread/tokenUsage/updated for threadId → usage = last (per-turn); emit onUsage.
// - turn/completed for main turn → resolve. If finalAnswerSeen and pendingCollabs+subagent turns
//   empty but no turn/completed after INFER_COMPLETION_MS → resolve as completed (inferred).
// - `error` notification → resolve failed with message.
// - abort signal → request turn/interrupt {threadId, turnId}; if no turn/completed within
//   INTERRUPT_GRACE_MS resolve "interrupted" anyway (caller kills client).
```

## src/executor/schema.ts
Depends on: ajv, types.
```ts
export function strictify(schema: Record<string, unknown>): Record<string, unknown>;
// deep clone; on every object node with type "object"/properties: add additionalProperties: false
// ONLY when the key is absent (preserve an explicit boolean; preserve AND recurse into a map-style
// sub-schema so map objects stay satisfiable). Leave `required` exactly as authored — upstream
// schemas are validated as written; do NOT promote optional properties to required.
// Recurse into properties/items/anyOf/oneOf/allOf/$defs/definitions.
export function schemaInstruction(schema: Record<string, unknown>): string;
// "<structured_output_contract>...respond ONLY with a single JSON object valid against this
//  JSON Schema (no markdown fences, no commentary): <inlined schema>...</structured_output_contract>"
export function extractJson(text: string): string;
// tolerate markdown fences / leading prose: prefer whole-string parse, else first balanced {...}
// or [...] block. Return the JSON substring (throws if none found).
export function createValidator(schema: Record<string, unknown>): (text: string) =>
  | { ok: true; object: unknown }
  | { ok: false; errors: string };  // ajv errors, compact human-readable, for the repair prompt
```

## src/executor/prompt.ts
Depends on: types, constants.
```ts
export function assemblePrompt(args: {
  prompt: string;
  schema?: Record<string, unknown>;
  profilePreamble?: string;
}): string;
// XML-ish blocks (codex plugin's gpt-5-4 prompting):
// <task>{prompt}</task>
// output contract block: RETURN_VALUE_CONTRACT + (schema ? schemaInstruction : plain-text contract)
// <default_follow_through_policy>: never stop to ask questions; act on stated defaults; finish.
// profilePreamble (if any) prepended as its own paragraph.
```

## src/executor/codex.ts
Depends on: appserver/client, appserver/turn, executor/schema, executor/prompt, types, constants.
```ts
export class CodexExecutor implements Executor {
  readonly backend = "codex";
  constructor(cfg: CodexBackendConfig, profiles: Record<string, AgentProfileConfig>);
  run(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult>;
}
// Per call: AppServerClient.start (one process per call; the runtime semaphore bounds slots).
// thread/start {cwd: req.cwd, approvalPolicy: "never", sandbox: profile.sandbox ?? cfg.sandbox,
// ephemeral: false} → threadId → ctx.onThread. Map model tier via cfg.modelMap
// (unknown tier: pass through as-is; undefined → cfg.defaultModel). effort via cfg.effortMap.
// runTurn with assembled prompt (+ strictified outputSchema when schema present).
// Schema path: validate finalText via createValidator; invalid → repair turn ON THE SAME THREAD:
// prompt = "Your previous reply was not valid JSON for the required schema. Errors: <errors>.
// Respond with ONLY the corrected JSON object." (no outputSchema needed on repair; keep it anyway);
// up to cfg.schemaRetries repairs, then {ok: false}.
// interrupted → {ok: false, error: "interrupted"} (runtime maps skip-abort to skipped itself).
// Always close the client in finally. Accumulate usage across repair turns.
```

## src/executor/claude.ts
Depends on: executor/schema, executor/prompt, types, node:child_process.
```ts
export class ClaudeExecutor implements Executor {
  readonly backend = "claude";
  constructor(cfg: ClaudeBackendConfig, profiles: Record<string, AgentProfileConfig>);
  run(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult>;
}
// spawn(cfg.binary, ["-p", "--output-format", "json", ...(model ? ["--model", model] : [])], prompt
// via stdin, cwd: req.cwd). Parse stdout JSON: {result: string, usage?: {input_tokens, output_tokens},
// session_id}. Schema path: same ajv validate; repair via ["--resume", sessionId] when available,
// else fresh call embedding the errors. Map usage into Usage (fill unknown fields with 0).
// Abort signal → SIGTERM the child.
```

## src/executor/router.ts
Depends on: config, codex, claude, types.
```ts
export function createExecutors(config: UltracodexConfig): Record<string, Executor>;
export function pickExecutor(
  executors: Record<string, Executor>,
  config: UltracodexConfig,
  label: string,
  phase: string | null,
): Executor;  // routeBackend + lookup; unknown backend → throw
```

## src/worktree.ts
Depends on: node:child_process (execFile git), node:fs/path.
```ts
export function createWorktree(projectDir: string, runDir: string, n: number): Promise<string>;
// git worktree add <runDir>/wt/<n> HEAD (detached); returns absolute path
export function cleanupWorktree(projectDir: string, wtPath: string): Promise<{ kept: boolean }>;
// git -C wtPath status --porcelain → clean: worktree remove --force + prune → {kept:false};
// dirty → {kept:true}
```

## src/runtime.ts — the heart
Depends on: types, constants, journal, ids, rundir(agentDir), worktree, executor/router, loader (types only).
```ts
export interface RuntimeDeps {
  journal: JournalWriter;
  executors: Record<string, Executor>;
  config: UltracodexConfig;
  options: RunOptions;
  meta: WorkflowMeta;
  /** Resolve + load a saved workflow or scriptPath for the workflow() global. */
  loadChildWorkflow(nameOrRef: string | { scriptPath: string }): { meta: WorkflowMeta; body: (g: WorkflowGlobals) => Promise<unknown> };
}
export interface Runtime {
  globals: WorkflowGlobals;
  controller: RunController;
}
export interface RunController {
  pause(): void;                  // journal paused; new agent launches gate
  resume(): void;                 // journal resumed
  stop(): void;                   // abort all in-flight (interrupt), queued resolve null; scripts see nulls; runner ends run "stopped"
  skip(n: number): void;          // abort agent n → resolves null, status skipped
  readonly stopped: boolean;
  totals(): RunTotals;
}
export function createRuntime(deps: RuntimeDeps): Runtime;
```
Behavioral requirements (upstream semantics — the compatibility bar):
- `agent()`: increments global ordinal (across nested workflow() too); >LIFETIME_AGENT_CAP → throw.
  Budget check BEFORE dispatch: budget.total !== null && spent() >= total → throw Error("budget exceeded").
  Acquire semaphore slot (respect pause gate: paused → wait). Emit agent_start (+ prompt snapshot
  file in agentDir: prompt.md; promptSha over ORIGINAL prompt). Route executor. isolation:'worktree'
  → createWorktree, cwd = wt; cleanup after; kept → include worktreePath in agent_end + warn event.
  Executor result: ok+text → return text; ok+object → return object; !ok → agent_end failed + return null.
  Skip → abort that agent's AbortController; agent_end skipped; return null. NEVER throw from
  agent() except: budget exceeded, lifetime cap, fan-out cap (those THROW).
  Write output snapshot: output.txt (text) or output.json (object). agent_usage events throttled ≥250ms.
- `parallel(thunks)`: barrier; each thunk error → null in results; never rejects. Not an agent-cap
  item itself. >FANOUT_ITEM_CAP thunks → throw.
- `pipeline(items, ...stages)`: per-item chain, no cross-item barrier; stage callback
  (prev, originalItem, index); stage throw → item null + remaining stages skipped; >FANOUT_ITEM_CAP → throw.
- `phase(title)`: set current phase (mutable), emit phase event. opts.phase on agent overrides.
- `log(msg)`: log event. String() coerce.
- `budget`: {total, spent: () => outputTokens across ALL backends this run, remaining}.
- `workflow(nameOrRef, args)`: depth 1 only (child calling workflow() → throw). Child shares
  ordinal counter, semaphore, budget, journal (its phase events prefixed "<child-name> ▸ <phase>").
  Runs child body with child globals (its own `args`), returns its return value. Errors propagate
  as throws (script may catch).
- Pause: soft — semaphore admission gate only. Stop: gate + abort in-flight.

## src/runner.ts
Depends on: everything above.
```ts
export async function runnerMain(runDir: string): Promise<void>;
// read options.json (RunOptions), script.js, args.json; loadScript (strict per options);
// JournalWriter; run_start; tailControl → controller; writePidFile(process.pid);
// SIGTERM/SIGINT → controller.stop() then finalize "stopped".
// await body(globals) → result: write result.json, run_end ok (resultRef).
// body throws → run_end failed (error message). stop → run_end stopped.
// Always: close journal, exit 0 (status is in the journal, not the exit code).
```
CLI entry contract: `node dist/runner.js <runDir>` (a `main` block calls runnerMain(argv[2])).

## src/tui/reducer.ts — pure fold, shared by TUI + `show`
```ts
export interface AgentView {
  n: number; label: string; phase: string | null; backend: string; model: string | null;
  status: "running" | "ok" | "failed" | "skipped"; startTs: number; endTs: number | null;
  activity: { kind: string; text: string; phase?: string } | null;
  usage: Usage; threadId: string | null; error: string | null; resultRef: string | null;
  activityCount: number;
}
export interface PhaseView { title: string; done: number; running: number; failed: number; total: number }
export interface TuiState {
  runId: string | null; meta: WorkflowMeta | null; startTs: number | null; endTs: number | null;
  status: "running" | "ok" | "failed" | "stopped"; paused: boolean;
  budgetTotal: number | null; outputTokens: number; usageByBackend: Record<string, Usage>;
  currentPhase: string | null; phases: PhaseView[]; agents: Map<number, AgentView>;
  narrator: Array<{ ts: number; text: string; warn?: boolean }>;   // last 50
  resultRef: string | null; error: string | null; totals: RunTotals | null;
}
export function initialState(): TuiState;
export function reduce(state: TuiState, ev: JournalEvent): TuiState;  // immutable-ish; cheap
```

## src/tui/index.tsx (entry used by cli.ts)
```ts
export function runTui(opts: { projectDir: string; runDir?: string }): Promise<void>;
// runDir given → run view attached to that run; else home view (launcher).
// Resolves when the user quits (q). Quitting NEVER kills runs.
```

## src/tui/static.ts (used by `show`)
```ts
export function renderRunStatic(state: TuiState, opts?: { color?: boolean }): string;
// One-shot render of a finished/current journal fold: header, phase strip, agent lines
// (status, label, tokens, duration, error snippets), narrator tail, result summary + resume hints.
```

## src/validate.ts
```ts
export interface ValidationIssue { severity: "error" | "warn"; message: string; line?: number }
export function validateWorkflowScript(source: string, opts?: { strict?: boolean }): ValidationIssue[];
// errors: meta missing/impure/name/description missing; TypeScript syntax (acorn parse failure);
// phases[].title without matching phase() call literal and vice versa (warn only);
// Date.now()/Math.random()/argless new Date() → warn (error when strict);
// warn: parallel( where callback bodies chain agent() sequentially (heuristic: skip); budget loop
// `while` referencing budget.remaining() without budget.total guard; literal fan-outs > 4096.
// Keep heuristics simple; prefer fewer, correct warnings.
```

## src/skills.ts
```ts
export function syncSkills(projectDir: string): { written: string[] };
// For each .ultracodex/workflows/<name>.js: parseMeta → .claude/skills/ultracodex-<name>/SKILL.md
// frontmatter: name: ultracodex-<name>, description: meta.description + (whenToUse appended).
// Body: instructions to run via Bash: `ultracodex run <name> --args '<json>' --json --wait`,
// then the verbatim-relay policy (return stdout verbatim; on failure report failure, do NOT
// substitute your own answer).
```

## src/cli.ts (bin) — commander
Commands per docs/product_context.md §5. Highlights:
- `run <scriptOrName>`: resolve saved workflow name or path; validate (errors block; strict);
  create run dir; snapshot script/args/options; spawn detached
  `process.execPath dist/runner.js <runDir>` (detached: true, stdio → runner.log, unref);
  TTY → attach TUI; `--watch` → tail journal, line per event; `--json` → wait run_end, print
  result.json to stdout (exit 1 if failed); `--detach` → print runId and exit.
- `ls`, `show <ref> [--json] [--wait [--timeout-ms N]]`, `attach <ref>`, `pause/resume/kill/skip`,
  `logs <ref> [n]`, `validate <script>`, `sync-skills`, `doctor`.
- kill: control stop → wait 5s → SIGTERM pid → 5s → SIGKILL.
- doctor: node version, codex binary + `codex --version`, app-server probe (initialize +
  account/read), config summary, actionable next-steps.

## tests/fake-codex/ (fixture)
`tests/fake-codex/codex` — executable Node script (shebang `#!/usr/bin/env node`, chmod +x)
implementing enough of app-server: initialize/initialized, account/read, model/list, thread/start,
turn/start, turn/interrupt. JSONL stdio. Notification shapes MUST mirror
fixtures/appserver/probe-capture.jsonl exactly (field names).
Behavior directives embedded in the prompt text:
- `[[reply:TEXT]]` → final answer TEXT (default "ok"). `[[reply2:TEXT]]` → thread's 2nd turn
  answers TEXT (repair tests), similarly reply3.
- `[[slow:MS]]` → delay before final answer (interruptible via turn/interrupt →
  turn/completed status "interrupted").
- `[[fail:MSG]]` → turn/completed with status "failed", error {message: MSG}.
- `[[exec:CMD]]` → emit commandExecution item started(+completed) before answering.
- `[[collab]]` → emit collabAgentToolCall started + subagent thread turn/started, then complete
  them, then final answer (tests completion drain).
- `[[no-turn-completed]]` → emit final_answer item but suppress turn/completed (tests 250ms inference).
- `[[usage:IN,OUT]]` → thread/tokenUsage/updated with those numbers (default 100,10).
Env: FAKE_CODEX_LOGGED_OUT=1 → account/read returns {account: null, requiresOpenaiAuth: true};
FAKE_CODEX_CRASH_MID_TURN=1 → process.exit(1) after turn/started.
Also export `tests/helpers.ts`: `fakeCodexPath()` returning absolute path to the fixture binary.
