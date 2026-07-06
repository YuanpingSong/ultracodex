# ultracodex

[![ci](https://github.com/YuanpingSong/ultracodex/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/ultracodex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ultracodex)](https://www.npmjs.com/package/ultracodex)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Run Claude Code workflow scripts, unmodified, on the OpenAI Codex CLI.**

Claude Code's Workflow tool has a great orchestration format: plain-JS
scripts that fan agents out in parallel, pipeline work through stages,
enforce token budgets, and adversarially verify results. But running them
upstream — under Claude Code itself — spends Claude quota on
execution-grade work.

ultracodex is a compatible runtime for those same scripts — byte-identical,
no transpilation — that routes each `agent()` call to
[Codex](https://github.com/openai/codex) instead (or to any configured
backend, per label). The pattern it exists for:

> **fable plans, codex executes, fable verifies**
> *(fable = Claude's frontier model; substitute your planner of choice)*

Your most capable model authors and judges the work; cheaper/faster coding
agents do the bulk of it; one script, one journal, one budget.

![Claude Code authors an actor-critic workflow and runs it through ultracodex; the TUI shows the rounds executing on Codex, then the result lands back in Claude](https://raw.githubusercontent.com/YuanpingSong/ultracodex/main/assets/demo.gif)

*Claude Code (right) is asked: "Write an essay on the meaning of life — actor–critic loop, 3 rounds. Run it with ultracodex." It authors the workflow, kicks it off, the TUI (left) watches Codex agents execute the loop, and the result JSON lands back in Claude. Sped up 1.3×. ([HD video](https://github.com/YuanpingSong/ultracodex/releases/download/v0.1.1/ultracodex-demo-v0.1.mp4))*

## Why

- **Quota arbitrage.** Offload execution to Codex (or another backend);
  keep Claude for judgment. Zero Claude tokens spent on implementation.
- **Verification comes free.** The workflow's result JSON lands back in
  your Claude session — where the model that *asked* for the work judges
  it with the full original intent in context. No configuration; the
  round trip is the verify step. (Advanced: routing puts a judge *inside*
  the run too — see below.)
- **Durable, inspectable runs.** No daemon. A run is a detached process and
  a directory of plain files; an append-only journal is the single source of
  truth for the TUI, the CLI, and machine consumers alike. Close your
  terminal; the run doesn't care.

## Agent Script in 60 seconds

A script is an ES module: a pure-literal `meta` export, then a plain-JS
async body over eight injected globals. No imports, no TypeScript.

```js
export const meta = {
  name: 'review-files',
  description: 'Fan out reviewers, verify findings, report',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const FILES = args?.files ?? ['src/auth.ts', 'src/api.ts']

phase('Review')
const findings = (await parallel(FILES.map(f => () =>
  agent(`Review ${f} for bugs. Return via the schema.`, {
    label: `review:${f}`,
    schema: { type: 'object', properties: { bugs: { type: 'array', items: { type: 'string' } } }, required: ['bugs'] },
  })
))).filter(Boolean)                    // failed agents are null, never throws

phase('Verify')
const verified = await pipeline(       // no barrier — each item flows independently
  findings.flatMap(f => f.bugs),
  (bug) => agent(`Try to refute: ${bug}`, { label: 'verify' }),
  (verdict, bug) => ({ bug, verdict }), // verdict may be null (failed verifier) — check it
)

return { verified: verified.filter(v => v && v.verdict) }
```

| global | what it does |
|---|---|
| `agent(prompt, opts?)` | run one agent; resolves final text, a schema-validated object, or `null` on failure (never rejects — except budget/caps, which throw) |
| `parallel(thunks)` | barrier over concurrent thunks; a thrown thunk becomes `null` |
| `pipeline(items, ...stages)` | per-item stage chains, no cross-item barrier; stages get `(prev, item, index)`; the first stage's `prev` is the item itself. A stage that **throws** drops its item to `null`; a stage that **resolves `null`** (e.g. a failed agent) flows onward — later stages must null-check `prev` |
| `phase(title)` | progress grouping for subsequent agents |
| `log(msg)` | narrator line in the TUI / `--watch` output |
| `args` | the run's `--args` input, verbatim |
| `budget` | `{ total, spent(), remaining() }` — output-token ceiling; exceeding it makes further `agent()` calls throw |
| `workflow(name, args?)` | run a saved workflow inline (one nesting level) |

`agent()` opts: `label` (display + routing), `phase`, `schema` (JSON Schema),
`model` / `effort` (advisory tiers, mapped in config), `isolation: 'worktree'`
(fresh git worktree, auto-removed only if pristine), `agentType` (config
profile, e.g. read-only explorer).

### Loops are the point

Scripts are plain JavaScript, so **loops are native** — and builder→verifier
loops are the pattern this tool is built to make easy. The runtime gives
loops their guardrails: a hard output-token `budget` (further `agent()`
calls throw once it's spent), a 1000-agent lifetime cap, and live
pause/skip/stop controls on every run.

```js
let attempt = null, feedback = 'none — first attempt'
while (budget.remaining() > 20_000) {                    // rail 1: budget governor
  attempt = await agent(`Build X. Reviewer feedback: ${feedback}`, { label: 'build' })
  if (attempt === null) continue                          // rail 2: builders can fail
  const verdict = await agent(`Try to refute this: ${attempt}`, {
    label: 'verify:attempt',                              // route to another vendor in config
    schema: { type: 'object', properties: { pass: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } }, required: ['pass', 'issues'] },
  })
  if (verdict?.pass) break                                // rail 2 again: judge can fail too
  feedback = verdict ? verdict.issues.join('; ') : 'verifier unavailable'
}
return { attempt }
```

Three axes, one format: `parallel()` is breadth, `pipeline()` is flow,
**loops are depth** — iterate until verified good, with `budget` as the
governor and the run's live controls (pause/skip/stop) as the brakes. The
full pattern — max rounds, feedback threading, cross-vendor judging — is
[examples/03-builder-verifier.js](examples/03-builder-verifier.js).
(Advanced: route `"verify:*" = "claude"` in config and the builder's
in-run judge becomes a different model family; the loop doesn't change.)

The full normative definition — grammar, semantics, loop patterns,
conformance — is in [docs/agent_script_spec.md](docs/agent_script_spec.md).
The same file runs under Claude Code's Workflow tool and ultracodex;
`ultracodex validate --strict` checks a script stays in the portable subset.

## Quickstart

Prerequisites: Node ≥ 20, [pnpm](https://pnpm.io), and the
[Codex CLI](https://github.com/openai/codex) installed and authenticated
(`codex login`). Developed and tested against **codex-cli 0.142.4**
(`ultracodex doctor` prints your version). Optional: Claude Code for
claude-routed agents.

```bash
npm install -g ultracodex      # or: pnpm add -g ultracodex
ultracodex doctor              # node, codex, auth, config + execution profile & divergences
```

From source instead:

```bash
git clone https://github.com/YuanpingSong/ultracodex && cd ultracodex
pnpm install && pnpm build
pnpm link --global             # → `ultracodex` on PATH (or keep using node dist/cli.js)
```

The examples ship with the package — run them first (from the checkout, or
from the installed package via `$(npm root -g)/ultracodex/`):

```bash
ultracodex run examples/01-hello.js --watch          # one agent, streamed events
ultracodex run examples/02-fanout-critique.js        # fan-out + schemas, opens the TUI
ultracodex run examples/03-builder-verifier.js --watch --budget 200k   # the loop
ultracodex ls                                        # every run, pid-liveness checked
ultracodex show <runId> --json                       # machine-readable result
```

For real work, run from **your project's root** — agents work in your cwd.

`run` launches a **detached runner** — quitting the TUI never kills a run.
`--json` blocks and prints the result (this is what a driving LLM calls);
`--watch` streams events line-by-line; `--detach` just prints the runId and
exits; `--budget` takes output tokens as an integer with optional `k`/`m`
suffixes (`--budget 500k`).

### Driving ultracodex from Claude Code

That's what the demo above shows, and it needs one command of setup:

```bash
ultracodex sync-skills     # installs the `ultracodex` skill for Claude Code
```

The skill teaches Claude the whole contract — author the script exactly as
for the Workflow tool, execute with `ultracodex run <file> --json
[--budget 500k]`, relay the result verbatim. After that, the prompt is just
the task:

> Write an essay on the meaning of life — actor–critic loop, 3 rounds.
> Run it with ultracodex.

Without the skill, prompt it explicitly — two variants depending on what's
in the session's context:

**Option A — schema-native** (session has the Workflow tool, e.g. ultracode
mode; Claude already knows the format as that tool's schema):

> Author the workflow exactly as you would for the Workflow tool — same
> script, byte for byte — but instead of invoking the tool, save it to a
> file and run `ultracodex run <file> --json --budget 300k`. Relay the
> result JSON verbatim; if the run fails, report the failure.

**Option B — teach from the spec** (plain sessions, headless `claude -p`,
other agents entirely): as Option A, but point at the format docs —
"using the Agent Script format in docs/agent_script_spec.md" — and state
the task. (That's how this repo validated itself: a fresh headless Claude
authored staged build workflows from the spec and drove them through this
CLI to rebuild the project with Codex agents.)

### Saved workflows + skills

Drop scripts in `.ultracodex/workflows/<name>.js` and they become runnable
by name (`ultracodex run <name>`) and visible in the TUI launcher (bare
`ultracodex`). Then:

```bash
ultracodex sync-skills
```

generates a Claude Code skill per workflow, so Claude can trigger your
saved workflows by name without being asked — the fully-automatic tier of
the same integration.

### Routing & configuration

`.ultracodex/config.toml` (project) or `~/.ultracodex/config.toml` (global):

```toml
[route]                        # first match wins: label, then phase
"*"          = "codex"         # default: everything runs on Codex

# ADVANCED — in-run cross-vendor judging. You usually don't need this:
# results return to your Claude session, which verifies with full context.
# Route labels to the claude backend only when judgment must happen INSIDE
# the run — per-round loop verifiers, per-item gates, or unattended
# (cron/CI) workflows where no parent session is waiting.
# "critique:*" = "claude"
# "verify:*"   = "claude"

[backends.codex]
sandbox        = "workspace-write"
default_model  = "gpt-5.5"
default_effort = "xhigh"
service_tier   = "standard"    # never inherit fast mode from ~/.codex
model_map      = { opus = "gpt-5.5", sonnet = "gpt-5.4", haiku = "gpt-5.4-mini" }

[run]
concurrency = 6                # default: min(16, cores-2)
```

Routing lives in config, never in scripts — that's what keeps scripts
portable across runtimes and backends.

## CLI

```
ultracodex                        TUI home: saved workflows + recent runs
ultracodex run <script|name>      [--args JSON] [--budget 500k] [--watch|--json|--detach] [--strict]
ultracodex ls                     runs with liveness-checked status
ultracodex show <ref>             [--json] [--wait [--timeout-ms N]]   (ref = unique runId prefix)
ultracodex attach <ref>           TUI onto a live run
ultracodex pause|resume <ref>     soft pause: stop launching new agents
ultracodex skip <ref> <n>         resolve agent n to null
ultracodex kill <ref>             graceful stop → SIGTERM → SIGKILL
ultracodex logs <ref> [n]         raw runner / per-agent event logs
ultracodex validate <script>      dual-runnability lint (--strict = portable subset)
ultracodex sync-skills            workflows/ → .claude/skills/
ultracodex doctor                 env, auth, execution profile, interactive-config divergences
```

Every run directory (`.ultracodex/runs/<runId>/`) is plain files: the
journal, per-agent prompts/events/outputs, `result.json`, a pidfile. Any
agent's Codex session can be continued interactively — the TUI's agent
detail view (and `show`) surface `codex resume <threadId>`.

## How it works

```
script.js ──▶ loader (acorn meta parse + vm) ──▶ runtime (semantics, caps,
              budget, semaphore) ──▶ executors per [route]:
                codex  → `codex app-server` JSON-RPC, one process per slot
                claude → headless `claude -p`
              journal.jsonl ◀── every event        control.jsonl ◀── pause/stop/skip
              TUI / show / --json = pure folds over the journal
```

Structured output is belt-and-suspenders: schemas ride the wire where the
backend supports it (Codex strict mode), and are always enforced on our side
(prompt contract + ajv validation + repair turns on the same session). The
entire test suite (340+ tests) runs hermetically against a scripted fake of
the codex app-server — no API keys in CI.

Deeper reading: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/OPERATIONS.md](docs/OPERATIONS.md) ·
[docs/agent_script_spec.md](docs/agent_script_spec.md) ·
[docs/agent-script-plan.md](docs/agent-script-plan.md) (roadmap: pluggable
backends, OpenCode adapter, packaged loop workflows, loop-aware
convergence display).

## Status

M1–M3 shipped: runner core, app-server executor, TUI, CLI, claude backend,
validate, sync-skills. Validated end-to-end on live Codex, including a
clean-room rebuild of this project by Codex agents orchestrated through
ultracodex itself. See [docs/PROGRESS.md](docs/PROGRESS.md).

## License

[Apache-2.0](LICENSE). The app-server turn state machine adapts patterns
from OpenAI's Codex plugin for Claude Code (Apache-2.0) — see
[NOTICE](NOTICE).