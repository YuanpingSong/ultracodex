# ultracodex — Context Handoff (v3)

**Goal:** a runner + CLI + TUI that executes Claude Code *workflow scripts* unmodified,
but backed by the OpenAI Codex CLI (via `codex app-server`) instead of Claude subagents.
Motivation: conserve Claude quota — "fable plans, codex executes, fable verifies."

**v3 delta:** executor switched from `codex exec --json` to the `codex app-server`
JSON-RPC protocol, plus steals from the official codex plugin for Claude Code
(`/Users/user/Desktop/repos/codex-plugin-cc`, Apache-2.0 — our reference
implementation for protocol handling). All protocol claims below were verified
against that source and against the installed codex 0.142.4.

**Build decisions (locked 2026-07-02):**
- ultracodex source: **TypeScript** (tsc build, bin entry). User scripts stay plain JS.
- Live codex calls during development: **allowed freely**.
- Cadence: build **straight through M1–M3** before user review.
- `budget.spent()` counts **output tokens only** (upstream parity); ledgers record
  input+output for display.
- Pins: codex CLI **0.142.4**, Node v22.

**Design principles (locked):**
1. Simple product shape; simple, reliable execution; ship value fast.
2. **No transpilation.** Scripts are plain JS + injected globals; we implement a
   compatible runtime, not a translator. One script must stay **dual-runnable**
   (Claude's Workflow tool or ultracodex) byte-identically.
3. **State is files.** No daemon, no server. Every run is a detached process + a
   directory. The TUI is a launcher and viewer, never an owner.
4. **The journal is the spine.** Runner writes it; CLI/TUI are pure consumers.
5. Defer anything speculative (MCP, resume) with explicit re-entry conditions.

---

## 1. The script format we must be compatible with

Scripts are ESM-shaped files: `export const meta = {...}` (a PURE literal — no
variables/spreads/calls) followed by a plain-JS async body (NOT TypeScript).

```js
export const meta = {
  name: 'kebab-case-id',          // required
  description: 'one-liner',       // required
  whenToUse: '...',               // optional
  phases: [                       // optional; titles string-match phase() calls
    { title: 'Draft', detail: '...' },
    { title: 'Critique', detail: '...', model: 'opus' },  // per-phase model override
  ],
}
// body: top-level await allowed; return value = workflow result
```

### Injected globals (exact semantics to replicate)

- `agent(prompt, opts?) → Promise<any>`
  - opts: `{label?, phase?, schema?, model?, effort?, isolation?: 'worktree', agentType?}`
  - No schema → returns final text (string). With schema (JSON Schema) → returns
    the **validated parsed object**; validation retried at our layer.
  - Returns **`null`** (never throws) when the agent fails terminally or is
    skipped by the user. Only exception: budget-exceeded **throws**.
  - `effort`: 'low'|'medium'|'high'|'xhigh'|'max'. `model`: advisory tier name.
  - Every subagent prompt is prefixed with: *"Your final text IS the return
    value consumed by a program — return raw data, not a chatty summary."*
- `parallel(thunks: Array<() => Promise<any>>) → Promise<any[]>` — a **barrier**.
  A thunk that throws resolves to `null` in the array; the call never rejects.
- `pipeline(items, ...stages) → Promise<any[]>` — **no barrier between stages**;
  item A may be in stage 3 while item B is in stage 1. Each stage callback gets
  `(prevResult, originalItem, index)`. A stage that throws → that item becomes
  `null` and its remaining stages are skipped.
- `phase(title)` — sets current progress group (mutable global; per-agent
  `opts.phase` overrides to avoid races inside concurrent stages).
- `log(msg)` — narrator line.
- `args` — the run's input value, verbatim (undefined if absent).
- `budget` — `{ total: number|null, spent(): number, remaining(): number }`.
  Hard ceiling: once `spent() >= total`, further `agent()` calls **throw**.
  `remaining()` is `Infinity` when total is null.
- `workflow(nameOrRef, args?)` — run a saved workflow inline; shares concurrency
  cap, agent counter, abort, budget. **One level of nesting only** (child calling
  workflow() throws). Throws on unknown name / unreadable path / child syntax error.

### Caps & rules
- Concurrency: default `min(16, cores - 2)` per run (make configurable; codex is
  network-bound so users may raise it). Excess calls queue.
- Lifetime cap: 1000 agents/run. Single parallel/pipeline call: ≤4096 items (hard error).
- Upstream bans `Date.now()`, `Math.random()`, argless `new Date()` (resume
  determinism). **We allow them at runtime** (no resume in v1) but `validate`
  warns and `--strict` throws — required for dual-runnability.

---

## 2. Product shape (locked decisions)

- **IS:** one executable `ultracodex` (runner library underneath) + TUI. The TUI
  can **start, attach to, pause, resume, skip within, and stop** runs — it does
  this without a daemon (see §4a/§6).
- **IS NOT (v1):** no MCP server (re-entry condition: a shell-less host — Claude
  Desktop/cowork/Cursor — actually matters; then it's a thin adapter over the
  library). No daemon. No resume-after-process-death / prefix-cache (journal is
  designed so it can be added later; agents must be restartable from scratch).
  No transpiler.
- **Claude Code integration:** `ultracodex sync-skills` generates
  `.claude/skills/<name>/SKILL.md` per saved workflow (name/description from
  `meta`; body instructs Claude to run `ultracodex run <name> --args ... --json`
  via Bash). This mirrors upstream's workflows-register-as-skills behavior and
  gives fable spontaneous triggering with zero server code. Generated SKILL.md
  bodies must include the codex plugin's **verbatim-relay discipline**: return
  the command's stdout as-is; if the run failed, report the failure and stop —
  never substitute a Claude-side answer (see codex-result-handling/SKILL.md in
  the plugin for the exact language).
- **Durability divergence (deliberate):** the codex plugin's jobs are
  session-scoped (a SessionEnd hook kills them) and its state lives in
  tmpdir/plugin-data keyed by workspace hash. Ours are the opposite by design:
  runs are durable, state is project-local and inspectable. Do not import their
  lifecycle model.
- **Backend routing lives in config, never in scripts** (keeps scripts portable):

```toml
# .ultracodex/config.toml
[route]                       # matched against agent label, then phase
"critique:*" = "claude"       # fable verifies
"*"          = "codex"        # codex executes

[backends.codex]
sandbox = "workspace-write"
model_map = { opus = "gpt-5.2-codex", sonnet = "gpt-5.2-codex", haiku = "gpt-5.2-codex-mini" }  # placeholder — decide at build time
effort_map = { low = "low", medium = "medium", high = "high", xhigh = "xhigh", max = "xhigh" }

[backends.claude]             # M3: shells to `claude -p --output-format json`
```

---

## 3. Architecture

### 3.1 Script loader
- Do NOT `import()` the script (body would execute before globals exist).
- Parse `meta` statically with acorn (guaranteed pure literal → safe AST eval).
- Strip the meta statement; wrap the remainder:
  `new AsyncFunction / vm.Script` of
  `(async ({agent,parallel,pipeline,phase,log,args,budget,workflow}) => { <body> })`
  run in a `node:vm` context (not a security boundary — just accident prevention:
  no require/fs/process visible). `--strict` shims Date/Math to throw per upstream.
- Body return value → `result.json` + `run_end` event.

### 3.2 Executor interface
```ts
interface Executor {
  run(req: { prompt, schema?, effort?, model?, cwd, label, agentProfile? },
      ctx: { signal, onActivity(ev), onUsage(u) }): Promise
    { ok: true, text?: string, object?: any, usage, sessionId? } |
    { ok: false, error }>
}
```
`agent()` wraps this: routes via config → acquires semaphore slot → emits journal
events → maps failure to `null` → enforces budget/caps.

### 3.3 Codex executor — app-server protocol (v3)
The official plugin never shells to `codex exec`; it speaks JSON-RPC (JSONL over
stdio) to `codex app-server`. We do the same. **One app-server process per agent
slot**, pooled by our semaphore (the plugin's "direct" mode). Do NOT build their
broker: it busy-locks one active stream per server (rpc code -32001 on contention)
precisely because multiplexing concurrent turns over one app-server is dicey —
our calls are parallel, so isolation-per-slot is the simple correct shape.

Per agent call:
```
spawn: codex app-server            (stdio pipes; cwd = agent cwd)
rpc:   initialize
       thread/start                → threadId
       turn/start {threadId, input, model, effort, outputSchema}
       … notifications …          → turn/completed
```
- **Notifications:** `thread/started`, `turn/started`, `item/started`,
  `item/completed`, `error`, `turn/completed`. Item types (all verified):
  `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`,
  `collabAgentToolCall`, `webSearch`, `reasoning`, `agentMessage`,
  `enteredReviewMode`/`exitedReviewMode`. Map to `onActivity`; handle unknown
  types gracefully (forward as `status`).
- **Final message:** `agentMessage` with `phase: "final_answer"` (lifecycle
  `completed`) — not "last text on stdout".
- **Completion inference:** codex can spawn its own subagents mid-turn
  (`collabAgentToolCall` items + `turn/started` on other threadIds). Copy the
  plugin's `captureTurn` state machine (codex.mjs:559 — Apache-2.0): complete
  only when final_answer seen ∧ no pending collabs ∧ no active subagent turns,
  with a 250ms inference timer for a missing `turn/completed`. Buffer
  notifications until turnId is known; route by `belongsToTurn()`.
- **Protocol types:** generate from the pinned binary —
  `codex app-server generate-ts` / `generate-json-schema` (verified in 0.142.4).
  Don't hand-write the protocol layer's types.
- **Effort:** valid values `none|minimal|low|medium|high|xhigh` → workflow map
  gains `max → xhigh`. Model aliases are a config table (plugin ships
  `spark → gpt-5.3-codex-spark`; re-derive our model_map from the live lineup).
- **Compat:** tolerate older servers via the plugin's degradation check
  (error message contains "unknown variant"/"unknown method" → feature off).
- **Fallback transport:** `codex exec --json` behind the same Executor
  interface, for environments where app-server misbehaves. Note for 0.142.4:
  `codex exec` has NO `--ask-for-approval` flag (it's inherently non-interactive);
  `-o/--output-last-message <FILE>` exists and is the robust final-message path.
- `agentType` → config-defined profiles (e.g. `Explore` = sandbox read-only
  + read-only preamble). Auth is ambient (`codex login` / `OPENAI_API_KEY`);
  check via `account/read` + `config/read` RPCs (what the plugin's setup does).
- **Test harness (day one):** steal the plugin's fake-codex fixture pattern —
  a scripted fake `codex` binary implementing app-server, selected by PATH
  prepend, driven by behavior flags (theirs has 17: `slow-task`, `invalid-json`,
  `with-subagent`, `interruptible-slow-task`, `logged-out`,
  `with-subagent-no-main-turn-completed`, …). Hermetic CI for the whole runtime
  without touching the real API.

### 3.4 Schema pipeline (belt AND suspenders)
`turn/start` takes `outputSchema` directly — first-class, use it. But keep our
own validation layer: the plugin itself does NO shape-validation (its
`parseStructuredOutput` is a bare `JSON.parse` with error catch), and the CLI
layer has known schema bugs (openai/codex #15451, #19816, #4181). Therefore:
1. `strictify(schema)`: recursively add `additionalProperties: false`, make all
   properties required — upstream schemas must work unmodified.
2. Pass strictified schema as `outputSchema` on `turn/start` AND append a
   JSON-only instruction + inlined schema to the prompt (via the
   `<structured_output_contract>` block, §3.7).
3. Validate the final message with **ajv**. On failure: repair turn on the SAME
   thread (`turn/start` again with the validation errors — "emit ONLY corrected
   JSON"; the thread keeps context in-process), up to N=3, then `null`.
4. Fallback config flag: two-call mode (agentic run writes JSON to a file;
   tool-less run reformats) for stubborn cases.

Lighter-weight alternative for gate-style endcaps (steal from the plugin's
stop-review-gate): a first-line `ALLOW: <reason>` / `BLOCK: <reason>` contract
parsed by prefix — cheaper than full JSON schema when the answer is a verdict.

### 3.5 Budget
Meter real token usage from codex events into **per-backend ledgers**.
`budget.spent()` counts **output tokens only** (locked — matches upstream, so
budget-guarded loops behave identically in both runtimes); ledgers record
input+output for display. `--budget 500k` sets `budget.total` (interpreted
against the codex ledger by default; configurable). Exceeded → subsequent
`agent()` calls throw (upstream semantics). Totals surface in journal, TUI
header, `show`, and `--json` output.
**Verify at build time:** where token usage arrives in the app-server stream
(the plugin never meters tokens, so this is unverified — check `turn/completed`
payload / item payloads / generated protocol schema; if absent, the
`codex exec --json` fallback transport has usage events).

### 3.6 Worktree isolation
`isolation: 'worktree'` → `git worktree add <runDir>/wt/<n> HEAD`, run codex
with cwd there. Teardown: `git status --porcelain` → clean: `worktree remove
--force` + `prune`; dirty: **keep and report the path** in agent_end (v1 policy;
merge-back strategies deferred).

### 3.7 Prompt assembly (steal: gpt-5-4-prompting blocks)
Build the executor's prompt preamble from the plugin's XML prompt-contract
blocks (skills/gpt-5-4-prompting/references/prompt-blocks.md — 14 blocks
available). Ship as per-profile templates in config; defaults:
- `<task>` — the workflow agent prompt itself.
- `<structured_output_contract>` — carries our "your final text IS the return
  value consumed by a program — return raw data, not a chatty summary"
  instruction (+ inlined schema when present); `<compact_output_contract>` for
  schema-less calls.
- `<default_follow_through_policy>` — essential headless: never stop to ask
  questions, act on the stated defaults.
- `<action_safety>` — for write-capable profiles; keep changes tightly scoped.
- `<grounding_rules>` — for read/research profiles.
Others (`<verification_loop>`, `<tool_persistence_rules>`, `<completeness_contract>`,
`<missing_context_gating>`, …) opt-in per profile.

---

## 4. On-disk state (no daemon — everything lives here)

```
.ultracodex/                  # project-local; ~/.ultracodex global fallback
  config.toml
  workflows/<name>.js         # saved workflows (meta.name must match filename)
  runs/<runId>/               # runId: uc_<base36>
    pid                       # liveness + kill target (runner writes its own)
    script.js  args.json      # snapshots
    journal.jsonl             # THE SPINE — append-only, single file
    control.jsonl             # TUI/CLI → runner commands (runner tails it)
    agents/<n>-<label>/       # prompt.md, events.jsonl (raw codex), output.{txt,json}, session-id
    result.json
```

### Journal event schema (TUI renders from these ONLY)
```jsonc
{"t":"run_start","ts":…,"runId":…,"meta":{…},"scriptSha":…,"argsRef":…}
{"t":"phase","ts":…,"title":"Critique"}
{"t":"agent_start","ts":…,"n":4,"label":"critique","phase":"Critique",
 "backend":"codex","model":"gpt-5.2-codex","effort":"high","promptSha":…,"promptRef":…}
{"t":"agent_activity","ts":…,"n":4,"kind":"exec|patch|reasoning|status","text":"$ rg -n …"}
   // throttled: coalesce to ≥250ms per agent, text ≤200 chars; raw goes to agents/<n>/events.jsonl
{"t":"agent_usage","ts":…,"n":4,"inTok":…,"outTok":…}      // periodic ticks
{"t":"agent_end","ts":…,"n":4,"status":"ok|failed|skipped","ms":…,"usage":{…},
 "resultRef":…,"error":null}
{"t":"log","ts":…,"text":"…"}          // narrator (log())
{"t":"warn","ts":…,"text":"…"}         // caps hit, items dropped, schema retries
{"t":"paused","ts":…} {"t":"resumed","ts":…}   // ack of control commands
{"t":"run_end","ts":…,"status":"ok|failed|stopped","resultRef":…,"totals":{…}}
```

### 4a. Run control (no daemon)
Control channel: append commands to `control.jsonl`; the runner tails it and
acks via journal events.
```jsonc
{"cmd":"stop"}            // graceful: cancel queued agents, terminate children, run_end: stopped
{"cmd":"pause"}           // SOFT pause: stop launching new agents; in-flight codex
                          // processes run to completion. This is the only pause in v1.
{"cmd":"resume"}
{"cmd":"skip","n":4}      // resolve agent n to null (kills its process)
```
- **Graceful tier first:** `skip`/`stop` on a live agent issue
  `turn/interrupt {threadId, turnId}` over the agent's app-server connection,
  then escalate to `terminateProcessTree` (SIGTERM → SIGKILL) on timeout. (The
  plugin exposes both pieces — interrupt as an RPC, terminateProcessTree for
  teardown; the interrupt→kill escalation policy is ours.)
- **Hard pause (SIGSTOP on child process groups) is deliberately excluded:** a
  frozen codex process holds a streaming API connection that times out within
  ~a minute, killing the agent. Soft pause covers the real use case (stop
  burning quota).
- **Pause is not checkpointing:** a soft-paused run holds its place, but if the
  runner *process* dies while paused, v1 restarts from scratch (accepted when we
  dropped the prefix cache; the journal keeps the door open).
- Escalation path for a wedged runner: `kill <runId>` tries control.jsonl,
  then SIGTERM via pidfile, then SIGKILL.
- All consumers must check pid liveness before offering controls: commands
  against a dead runner should render "runner exited," never silently no-op.

---

## 5. CLI surface

```
ultracodex                           # no args: open TUI home view (see §6)
ultracodex run <script.js|name> [--args '<json>'] [--budget 500k]
              [--watch] [--detach] [--strict] [--json] [--concurrency N]
ultracodex ls                        # runs + statuses (pid-liveness checked)
ultracodex show <runId> [--json] [--wait [--timeout-ms N]]
                                     # replay journal → static render / machine output;
                                     # --wait blocks until run_end (fable's clean poll)
ultracodex attach <runId>            # TUI onto a live run
ultracodex pause <runId> | resume <runId>
ultracodex kill <runId> | skip <runId> <n>
ultracodex logs <runId> [<n>]        # raw agent events
ultracodex validate <script.js>      # compat lint (see §8)
ultracodex sync-skills               # generate .claude/skills/* from workflows/
ultracodex doctor                    # node/codex-version/auth checks via
                                     # account/read + config/read; actionable next-steps
```
Every `<runId>` accepts a unique **prefix** (`uc_ab`); ambiguous → error listing
matches, never a guess (plugin's `matchJobReference` pattern).
`run` default: launch a **detached runner process** (`setsid`, stdio to files),
print runId, attach TUI if TTY; `--watch` in a non-TTY (CI, or fable calling via
Bash) = plain line-per-event output; `--json` = suppress decoration, print final
result JSON to stdout (this is fable's path). **Quitting the TUI never kills the
run** — the runner owns itself via its pidfile.

---

## 6. TUI spec

Tech: **Ink** (React for terminals). The TUI is a **pure fold over
journal.jsonl** (event-sourced): attach mid-run, replay finished runs, and
`show` all use the same reducer. Tail via fs.watch + byte offset. Throttle
re-render to ~10fps.

**Design stance:** optimize for 1–8 agents. Agents are the hero; phases are a
horizontal breadcrumb, not a sidebar. No cavernous empty panels.

### Home view (launcher — the TUI as control center)
Opened by bare `ultracodex`. Two lists: saved workflows (from `workflows/`,
showing meta.name + description + whenToUse) and recent runs (status, elapsed,
tokens; pid-liveness checked). Keys: `enter` on a run = attach; `enter`/`n` on a
workflow = prompt for args + budget → spawn detached runner → attach; `r` on a
finished run = re-run with same script + args (new runId). The TUI *spawns*
runs but never owns them — closing it affects nothing.

### Run view
1. Header: name · runId · elapsed · agents done/total · total tokens ·
   budget bar (when set) · paused indicator.
2. Phase strip: `✔ Summarize 3/3 ── ✔ Synthesize 1/1 ── ● Critique 0/1`.
3. Agent cards (full width). Running: line 1 = spinner, label, backend·model,
   tokens (ticking), tool count, elapsed; line 2 = **live activity line** (latest
   agent_activity, truncated). Completed: collapse to one dim ✔ line (grouped
   "(N more ✔)" beyond the last few). Failed: red, error snippet inline, sticky.
   Activity lines follow the plugin's `describeStartedItem` style ("Running
   command: …", "Applying 3 file change(s).", "Calling <server>/<tool>.") with
   its **verification-phase inference**: a command matching
   `/\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i`
   renders as *verifying* (distinct accent) instead of *running*.
4. Narrator strip: recent log() lines, timestamped.
5. Footer keybinds.

Density tiers: ≤8 visible agents → cards; 9–30 → single-line rows; >30 →
per-phase aggregate counts + only running agents listed. (The conservative
mock is the degraded tier, not the default.)

Views & keys: `↑↓` select · `enter` agent detail (prompt / live event stream /
output; `o` opens output in $EDITOR; `c` copies `codex resume <threadId>` —
any agent's session becomes interactively continuable by the human) · `t`
timeline (Gantt lanes per agent — makes pipeline() overlap visible) · `p`
pause/resume (soft; header shows PAUSED, queued agents dimmed) · `x` stop
(confirm) · `k` skip selected · `s` export result · `esc` back to home view ·
`q` **detach/quit** (run continues) · run-end renders the returned result as
markdown in a result pane. (Requires storing each agent's threadId — journal
agent_start gains a `threadId` field once known, and `show`/agent detail print
the resume command, mirroring the plugin.)

Fun, cheaply: braille spinners, per-phase accent colors, token tickers,
tokens/sec heartbeat in header, brief flash on phase completion. Respect
NO_COLOR; degrade gracefully below ~80 cols.

---

## 7. Claude backend (M3)

Executor shelling to `claude -p "<prompt>" --output-format json` (verify current
headless flags at build time). Schema handled by the same ajv+retry pipeline
(Claude headless doesn't enforce schemas either). Purpose: route judgment-heavy
calls (critique/verify) to Claude per the `[route]` table — the
fable-plan / codex-execute / fable-verify pattern. Claude tokens go to a
separate budget ledger.

---

## 8. Compatibility contract (`ultracodex validate`)

Lint a script for dual-runnability; all rules mirror upstream:
- meta present, pure literal, name/description required; phases titles match phase() calls.
- No TypeScript syntax. No Date.now()/Math.random()/argless new Date() (warn; --strict = error).
- Warn on: unguarded `await agent()` used without null-check; parallel() where a
  pipeline() would do (heuristic, informational); budget loops missing
  `budget.total` guard; >4096-item fan-outs.

---

## 9. Milestones

- **M1 — runner core (target: end-to-end in days):** loader, codex executor
  (app-server client: generate-ts bindings, captureTurn state machine,
  activity/usage forwarding, one server per slot), **fake-codex fixture +
  hermetic runtime tests (day one)**, agent/parallel/pipeline/phase/log/
  args/caps, journal + run dirs + control.jsonl (stop/pause/resume/skip with
  turn/interrupt tier), detached spawn, `run --watch` plain output,
  `ls/show/kill/pause/resume`.
  Exit criterion: a real 3-phase demo script (fan-out → synthesize → critique
  with schema) runs end-to-end and `show --json` returns the validated object.
  (Note: `fixtures/sample_workflow_scripts/demo-doc-digest.js` references docs
  that don't exist in this repo — add them or parameterize paths via `args`.)
- **M2 — TUI + hardening:** Ink TUI (home view + launcher, run view, agent
  detail, timeline, density tiers, detach), schema strictify+ajv+resume-retry,
  budget ledgers, worktrees.
- **M3 — integration:** sync-skills, claude backend + routing, validate, logs.
- **M4 — deferred backlog:** resume/prefix-cache (journal already keys
  agent_start by promptSha+opts), MCP adapter (re-entry condition: shell-less
  host), worktree merge-back, hard pause (only if a use case survives the
  API-timeout objection), nested-workflow UI grouping polish.

## 10. Risks / open questions

- app-server protocol stability (subcommand is marked experimental) → pin 0.142.4;
  generate protocol types/schema from the binary; fake-codex fixture for hermetic
  tests; adapt layer isolated in the executor; `codex exec --json` as fallback transport.
- **Token usage in the app-server stream is unverified** (the plugin doesn't meter
  tokens) → verify at build time; budget metering depends on it (§3.5).
- Rate limits under fan-out → per-backend semaphore + exponential backoff on 429; surface as `warn` events.
- Model/effort mapping defaults → decide against current codex model lineup at
  build time (plugin evidence: `gpt-5.3-codex-spark` exists; effort enum is
  `none|minimal|low|medium|high|xhigh`, so map `max → xhigh`).
- Zombie runs → pidfile + liveness check in `ls`/TUI; `run` cleans stale dirs.
- Windows: untested; worktrees, setsid, signals need care. Defer.
- Multiple simultaneous runs: covered by the home view; per-run attach only (no split-screen multi-run in v1).

## 11. Origin notes (context for the builder)

The full Workflow tool description (source of the semantics in §1) is upstream
Claude Code's; the user has it saved from a prior session. Semantics in §1 were
transcribed from it and are authoritative for compatibility. First real
workload: `chatgpt-corpus-synthesis` — a 3-agent Draft→Critique script (two
parallel report writers + one schema'd adversarial critique) over files in
/tmp/corpus-dir; treat it as the acceptance test after the demo script.