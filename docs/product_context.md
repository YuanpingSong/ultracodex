# ultracodex — Context Handoff (v2)

**Goal:** a runner + CLI + TUI that executes Claude Code *workflow scripts* unmodified,
but backed by the OpenAI Codex CLI (`codex exec`) instead of Claude subagents.
Motivation: conserve Claude quota — "fable plans, codex executes, fable verifies."

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
  gives fable spontaneous triggering with zero server code.
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

### 3.3 Codex executor
Spawn per call:
```
codex exec --json -C <cwd> --sandbox <profile> --ask-for-approval never \
  [-m <mapped-model>] [-c model_reasoning_effort=<mapped-effort>] "<prompt>"
```
- Parse the `--json` JSONL stream: forward command-exec / file-patch / reasoning
  events to `onActivity` (these power the TUI); token-usage events to `onUsage`;
  capture the final agent message and the session id.
- **Pin the codex CLI version and write an integration test against its event
  schema on day one** — exact event type names must be verified empirically at
  build time; do not trust docs or this handoff for field names.
- `agentType` → config-defined profiles (e.g. `Explore` = `--sandbox read-only`
  + read-only preamble). Auth is ambient (`codex login` / `OPENAI_API_KEY`).

### 3.4 Schema pipeline (do NOT trust `--output-schema`)
Known codex bugs: schema silently ignored when tools are active (openai/codex
#15451), schema applied to intermediate messages (#19816), model-family guard
skipping it (#4181). Therefore:
1. `strictify(schema)`: recursively add `additionalProperties: false`, make all
   properties required — upstream schemas must work unmodified.
2. Append a JSON-only instruction + inlined schema to the prompt; optionally
   also pass `--output-schema` (harmless when it works).
3. Validate the final message with **ajv**. On failure: retry via
   `codex exec resume <sessionId>` with the validation errors ("emit ONLY
   corrected JSON") — context-preserving repair, up to N=3, then `null`.
4. Fallback config flag: two-call mode (agentic run writes JSON to a file;
   tool-less run reformats) for stubborn cases.

### 3.5 Budget
Meter real token usage from codex events into **per-backend ledgers**.
`--budget 500k` sets `budget.total` (interpreted against the codex ledger by
default; configurable). Exceeded → subsequent `agent()` calls throw (upstream
semantics). Totals surface in journal, TUI header, `show`, and `--json` output.

### 3.6 Worktree isolation
`isolation: 'worktree'` → `git worktree add <runDir>/wt/<n> HEAD`, run codex
with `-C` there. Teardown: `git status --porcelain` → clean: `worktree remove
--force` + `prune`; dirty: **keep and report the path** in agent_end (v1 policy;
merge-back strategies deferred).

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
ultracodex show <runId> [--json]     # replay journal → static render / machine output
ultracodex attach <runId>            # TUI onto a live run
ultracodex pause <runId> | resume <runId>
ultracodex kill <runId> | skip <runId> <n>
ultracodex logs <runId> [<n>]        # raw agent events
ultracodex validate <script.js>      # compat lint (see §8)
ultracodex sync-skills               # generate .claude/skills/* from workflows/
```
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
4. Narrator strip: recent log() lines, timestamped.
5. Footer keybinds.

Density tiers: ≤8 visible agents → cards; 9–30 → single-line rows; >30 →
per-phase aggregate counts + only running agents listed. (The conservative
mock is the degraded tier, not the default.)

Views & keys: `↑↓` select · `enter` agent detail (prompt / live event stream /
output; `o` opens output in $EDITOR) · `t` timeline (Gantt lanes per agent —
makes pipeline() overlap visible) · `p` pause/resume (soft; header shows
PAUSED, queued agents dimmed) · `x` stop (confirm) · `k` skip selected ·
`s` export result · `esc` back to home view · `q` **detach/quit** (run
continues) · run-end renders the returned result as markdown in a result pane.

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
  (--json parsing, activity/usage forwarding), agent/parallel/pipeline/phase/log/
  args/caps, journal + run dirs + control.jsonl (stop/pause/resume/skip),
  detached spawn, `run --watch` plain output, `ls/show/kill/pause/resume`.
  Exit criterion: a real 3-phase demo script (fan-out → synthesize → critique
  with schema) runs end-to-end and `show --json` returns the validated object.
- **M2 — TUI + hardening:** Ink TUI (home view + launcher, run view, agent
  detail, timeline, density tiers, detach), schema strictify+ajv+resume-retry,
  budget ledgers, worktrees.
- **M3 — integration:** sync-skills, claude backend + routing, validate, logs.
- **M4 — deferred backlog:** resume/prefix-cache (journal already keys
  agent_start by promptSha+opts), MCP adapter (re-entry condition: shell-less
  host), worktree merge-back, hard pause (only if a use case survives the
  API-timeout objection), nested-workflow UI grouping polish.

## 10. Risks / open questions

- codex `--json` event schema stability → pin version; integration test; adapt layer isolated in the executor.
- Rate limits under fan-out → per-backend semaphore + exponential backoff on 429; surface as `warn` events.
- Model/effort mapping defaults (config placeholder above) → decide against current codex model lineup at build time.
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