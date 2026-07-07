# ultracodex architecture

ultracodex executes Claude Code *workflow scripts* unmodified, but routes each
`agent()` call to the OpenAI Codex CLI instead of Claude subagents. One script
is dual-runnable: byte-identical under Claude Code's Workflow tool and under
ultracodex ("fable plans, codex executes, fable verifies").

## Layers

- **Loader** (`src/loader.ts`) — parses `export const meta = {...}` statically
  with acorn (pure-literal enforcement), strips it, and compiles the body as an
  async function inside a `node:vm` context with the injected globals
  (`agent, parallel, pipeline, phase, log, args, budget, workflow`). `--strict`
  shims `Date.now`/`Math.random`/argless `new Date()` to throw, mirroring
  upstream's resume-determinism ban.
- **Runtime** (`src/runtime.ts`) — implements upstream Workflow semantics:
  `agent()` returns final text (or an ajv-validated object with a schema) and
  resolves `null` on failure/skip instead of throwing; `parallel()` is a
  barrier that maps thrown thunks to `null`; `pipeline()` chains stages per
  item with no cross-item barrier; a counting semaphore (default
  `min(16, cores-2)`) with a soft-pause gate; caps (1000 agents/run, 4096
  items/fan-out); an output-token budget that makes further `agent()` calls
  throw once exhausted; `workflow()` runs a saved child workflow sharing
  counters, budget, and journal, one nesting level only.
- **Executors** (`src/executor/`) — backend adapters behind one documented
  seam, the [Executor Contract](executor-contract.md)
  (`src/executor/contract.ts`): every adapter declares a capability
  descriptor (schema wire/prompt-only, resume, interrupt, usage, activity,
  sandbox), the engine owns the degradation rules for whatever a backend
  lacks, and a shared 10-assertion conformance kit (`tests/executor-kit/`)
  runs against each adapter via a scripted fake of its harness.
  The codex executor speaks JSON-RPC (JSONL over stdio) to `codex app-server`,
  one server process per agent slot: `initialize` → `thread/start` →
  `turn/start {input, model, effort, outputSchema}` → streamed `item/*`
  notifications → `turn/completed`. The final message is the `agentMessage`
  item with `phase: "final_answer"`. The opencode executor spawns
  `opencode serve` per call and drives its HTTP API (`POST /session` →
  synchronous `POST /session/{id}/message`, SSE `/event` for activity + live
  usage ticks, `POST /abort` for graceful interrupt), with wire structured
  output (`format: json_schema`) that degrades to prompt-only mid-call when
  a provider rejects it. The claude executor shells to
  `claude -p --output-format json` for judgment-heavy routes. Structured
  output is belt-and-suspenders on every backend: wire schema where
  supported plus a prompt-inlined contract, ajv validation against the
  AUTHORED schema, and repair turns on the same session. Routing is
  config-only (`.ultracodex/config.toml` `[route]` table matching agent
  label, then phase) so scripts stay portable.
- **Journal** (`src/journal.ts`) — the spine. The runner appends one JSON
  event per line to `runs/<runId>/journal.jsonl` (`run_start`, `phase`,
  `agent_start/activity/usage/end`, `log`, `warn`, `paused/resumed`,
  `run_end`). Every consumer — TUI, `show`, `--json` — is a pure fold over
  this file. Control flows the other way through `control.jsonl`
  (stop/pause/resume/skip), which the runner tails.
- **Runner** (`src/runner.ts`) — a detached, self-owning process per run.
  No daemon: state is files, liveness is a pidfile. Soft pause only (stop
  launching agents; in-flight turns finish). Stop escalates gracefully:
  `turn/interrupt` → SIGTERM → SIGKILL.
- **TUI** (`src/tui/`) — Ink app that folds the journal: home view
  (workflows + runs launcher), run view (phase strip, agent cards with live
  activity lines, narrator), agent detail (prompt, raw events,
  `codex resume <threadId>` copy), timeline (Gantt lanes exposing pipeline
  overlap). Quitting never kills a run.

## Token accounting

`thread/tokenUsage/updated` notifications provide per-turn usage; the budget
ledger counts output tokens (upstream parity) and keeps per-backend totals for
display. Testing is hermetic via a fake `codex` binary implementing the
app-server protocol with scriptable behaviors.
