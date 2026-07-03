# ultracodex

**Run Claude Code workflow scripts, unmodified, on the OpenAI Codex CLI.**

Claude Code's Workflow tool has a great orchestration format: plain-JS
scripts that fan agents out in parallel, pipeline work through stages,
enforce token budgets, and adversarially verify results. But running them
upstream spends Claude quota on execution-grade work.

ultracodex is a compatible runtime for those same scripts — byte-identical,
no transpilation — that routes each `agent()` call to
[Codex](https://github.com/openai/codex) instead (or to any configured
backend, per label). The pattern it exists for:

> **fable plans, codex executes, fable verifies.**

Your most capable model authors and judges the work; cheaper/faster coding
agents do the bulk of it; one script, one journal, one budget.

```
fanout-critique · uc_mr47ssor917j6 · ok · 3m04s · 5/5 agents · 3.3k out tok
✔ Read 3/3 ── ✔ Synthesize 1/1 ── ✔ Critique 1/1

  ✔ 1 read:docs/ARCHITECTURE.md · codex · 48s · 132 tok
  ✔ 2 read:docs/PROGRESS.md     · codex · 37s · 110 tok
  ✔ 3 read:docs/OPERATIONS.md   · codex · 39s · 147 tok
  ✔ 4 synthesize                · codex · 1m00s · 248 tok
  ✔ 5 critique:synthesis        · codex · 1m15s · 2.6k tok

result: result.json
```

## Why

- **Quota arbitrage.** Offload execution to Codex (or another backend);
  keep Claude for judgment. Zero Claude tokens spent on implementation.
- **Cross-vendor verification.** Route `critique:*` to a different model
  family than the one that did the work. Different-vendor judges catch what
  self-review rubber-stamps — no single-vendor harness can offer this.
- **Durable, inspectable runs.** No daemon. A run is a detached process and
  a directory of plain files; an append-only journal is the single source of
  truth for the TUI, the CLI, and machine consumers alike. Close your
  terminal; the run doesn't care.

## Agent Script in 60 seconds

A script is an ES module: a pure-literal `meta` export, then a plain-JS
async body over seven injected globals. No imports, no TypeScript.

```js
export const meta = {
  name: 'review-prs',
  description: 'Fan out reviewers, verify findings, report',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

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
  (verdict, bug) => ({ bug, verdict }),
)

return { verified }
```

| global | what it does |
|---|---|
| `agent(prompt, opts?)` | run one agent; resolves final text, a schema-validated object, or `null` on failure (never rejects — except budget/caps, which throw) |
| `parallel(thunks)` | barrier over concurrent thunks; a thrown thunk becomes `null` |
| `pipeline(items, ...stages)` | per-item stage chains, no cross-item barrier; stages get `(prev, item, index)` |
| `phase(title)` | progress grouping for subsequent agents |
| `log(msg)` | narrator line in the TUI / `--watch` output |
| `args` | the run's `--args` input, verbatim |
| `budget` | `{ total, spent(), remaining() }` — output-token ceiling; exceeding it makes further `agent()` calls throw |
| `workflow(name, args?)` | run a saved workflow inline (one nesting level) |

`agent()` opts: `label` (display + routing), `phase`, `schema` (JSON Schema),
`model` / `effort` (advisory tiers, mapped in config), `isolation: 'worktree'`
(fresh git worktree, auto-removed only if pristine), `agentType` (config
profile, e.g. read-only explorer).

The full normative definition — grammar, semantics, conformance — is in
[docs/agent_script_spec.md](docs/agent_script_spec.md). The same file runs
under Claude Code's Workflow tool and ultracodex; `ultracodex validate
--strict` checks a script stays in the portable subset.

## Quickstart

Prerequisites: Node ≥ 20, [pnpm](https://pnpm.io), and the
[Codex CLI](https://github.com/openai/codex) installed and authenticated
(`codex login`). Optional: Claude Code for claude-routed agents.

```bash
git clone <this-repo> && cd ultracodex
pnpm install && pnpm build
node dist/cli.js doctor        # checks node, codex, auth, config
```

Add the binary to your PATH (or keep using `node dist/cli.js`):

```bash
pnpm link --global             # → `ultracodex` on PATH
```

Run your first script from your project's root (agents work in your cwd):

```bash
ultracodex run examples/01-hello.js --watch
```

Then the real shape — parallel fan-out, schemas, adversarial critique:

```bash
ultracodex run examples/02-fanout-critique.js        # opens the TUI
ultracodex ls                                        # every run, pid-checked
ultracodex show <runId> --json                       # machine-readable result
```

`run` launches a **detached runner** — quitting the TUI never kills a run.
`--json` blocks and prints the result (this is what a driving LLM calls);
`--watch` streams events line-by-line; `--budget 500k` sets a hard
output-token ceiling.

### Saved workflows + Claude Code integration

Drop scripts in `.ultracodex/workflows/<name>.js` and they become runnable
by name (`ultracodex run <name>`) and visible in the TUI launcher (bare
`ultracodex`). Then:

```bash
ultracodex sync-skills
```

generates a Claude Code skill per workflow, so Claude can trigger your
workflows itself via `ultracodex run <name> --json` and relay the results —
the "fable plans" half of the loop.

### Routing & configuration

`.ultracodex/config.toml` (project) or `~/.ultracodex/config.toml` (global):

```toml
[route]                        # first match wins: label, then phase
"critique:*" = "claude"        # judgment goes to Claude
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
entire test suite (330+ tests) runs hermetically against a scripted fake of
the codex app-server — no API keys in CI.

Deeper reading: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/OPERATIONS.md](docs/OPERATIONS.md) ·
[docs/agent_script_spec.md](docs/agent_script_spec.md) ·
[docs/agent-script-plan.md](docs/agent-script-plan.md) (roadmap: pluggable
backends, OpenCode adapter, the Agent Script positioning).

## Status

M1–M3 shipped: runner core, app-server executor, TUI, CLI, claude backend,
validate, sync-skills. Validated end-to-end on live Codex, including a
clean-room rebuild of this project by Codex agents orchestrated through
ultracodex itself. See [docs/PROGRESS.md](docs/PROGRESS.md).

## License

[Apache-2.0](LICENSE). The app-server turn state machine adapts patterns
from OpenAI's Codex plugin for Claude Code (Apache-2.0) — see
[NOTICE](NOTICE).
