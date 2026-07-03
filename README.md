# ultracodex

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

```
fanout-critique · uc_mr47ssor917j6 · ok · 3m04s · 5/5 agents · 3.3k out tok
✔ Read 3/3 ── ✔ Synthesize 1/1 ── ✔ Critique 1/1

  ✔ 1 read:README.md            · codex · 48s · 132 tok
  ✔ 2 read:docs/ARCHITECTURE.md · codex · 37s · 110 tok
  ✔ 3 read:docs/OPERATIONS.md   · codex · 39s · 147 tok
  ✔ 4 synthesize                · codex · 1m00s · 248 tok
  ✔ 5 critique:synthesis        · codex · 1m15s · 2.6k tok

result: result.json
```

## Why

- **Quota arbitrage.** Offload execution to Codex (or another backend);
  keep Claude for judgment. Zero Claude tokens spent on implementation.
- **Cross-vendor verification.** Route `critique:*` to a different model
  family than the one that did the work. Same-vendor self-review tends to
  rubber-stamp; making the judge a different model family is one config
  line here.
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
[examples/03-builder-verifier.js](examples/03-builder-verifier.js). Route
`"verify:*" = "claude"` in config and the builder's judge is a different
model family; the loop doesn't change.

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
git clone <this-repo> && cd ultracodex
pnpm install && pnpm build
node dist/cli.js doctor        # checks node, codex, auth, config
pnpm link --global             # → `ultracodex` on PATH (or keep using node dist/cli.js)
```

Run the bundled examples **from the ultracodex checkout** first:

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

The "fable plans" half of the loop runs in the other direction too: **Claude
authors the workflow and runs it** — no setup, no skill, just prompting,
because Claude Code can already write files and run commands. Two prompting
approaches, depending on what's in your session's context:

**Option A — schema-native (Workflow tool in context).** If your Claude
session has the Workflow tool available (e.g. ultracode mode), Claude
carries the complete script format natively as that tool's schema — it is
already a fluent Agent Script author, because Agent Script *is* that format.
The prompt is a one-line redirection:

> Author the workflow exactly as you would for the Workflow tool — same
> script, byte for byte — but instead of invoking the tool, save it to a
> file and run `ultracodex run <file> --json --budget 300k`. Relay the
> result JSON verbatim; if the run fails, report the failure.

Scripts authored this way are upstream-idiomatic by construction, and
execution moves off Claude quota. The override is deliberate: ultracode's
default is to call the Workflow tool, so you're telling Claude to keep the
authoring habit and swap the executor.

**Option B — teach from the spec.** In sessions without the Workflow tool
(plain sessions, headless `claude -p`, other agents entirely), point Claude
at the format docs:

> Using the Agent Script format (docs/agent_script_spec.md — `export const
> meta = {...}` + a plain-JS body over the eight injected globals), write a
> workflow that reviews every file in src/ for bugs in parallel and
> adversarially verifies each finding. Save it to /tmp/review.js, check it
> with `ultracodex validate /tmp/review.js --strict`, run it with
> `ultracodex run /tmp/review.js --json --budget 300k`, and relay the result
> JSON verbatim. If the run fails, report the failure — don't do the review
> yourself.

(That's how this repo validated itself: a fresh headless Claude authored
staged build workflows from the spec and drove them through this CLI to
rebuild the project with Codex agents.)

To make either a standing habit, paste this into your project's `CLAUDE.md`
so Claude reaches for ultracodex on its own:

```markdown
## ultracodex
For multi-agent work (parallel fan-outs, pipelines, builder–verifier loops),
prefer ultracodex over the Workflow tool for execution. If the Workflow tool
schema is in context, author scripts exactly as you would for it; otherwise
learn the format from docs/agent_script_spec.md (`export const meta = {...}`
+ plain-JS body over agent/parallel/pipeline/phase/log/args/budget/workflow).
Execute with:
    ultracodex validate <script.js> --strict     # then:
    ultracodex run <script.js> --json [--budget 500k]
`run --json` blocks until the run ends and prints the result JSON. Relay it
verbatim; if the run failed, report the failure instead of doing the work
yourself. Recurring workflows: save to .ultracodex/workflows/<name>.js and
run by name.
```

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
"critique:*" = "claude"        # judgment goes to Claude
"verify:*"   = "claude"        # loop verifiers too, if you want cross-vendor judging
"*"          = "codex"         # execution goes to Codex

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
ultracodex doctor                 environment + auth checks
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