# ultracodex

[![ci](https://github.com/YuanpingSong/ultracodex/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/ultracodex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ultracodex)](https://www.npmjs.com/package/ultracodex)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Run Claude Code workflow scripts, unmodified, on the OpenAI Codex CLI.**

Ultracode too expensive? **ultracodex** is ultracode — Claude Code's one-prompt-becomes-a-fleet-of-agents mode — on Codex: the same workflow scripts, running on your Codex subscription, or on OpenCode (coming soon).

> **Fable plans, Codex executes, Fable verifies**

Your best model plans and judges; the subscription you're not rationing does the work. Verified results land back in the session that asked. Quit the terminal — runs are detached processes over plain files, nothing dies. And any model can write these workflows: the [authoring skill](skills/agent-script-authoring/SKILL.md) and a [nine-shape example gallery](examples/) ship in the box.



https://github.com/user-attachments/assets/4a7366cd-429c-4581-9703-7c28a9605c0e


*One prompt: "Write an essay on the meaning of life — actor–critic loop, 3 rounds. Run it with ultracodex." Claude (left) authors the workflow, Codex executes it, the TUI (right) watches live, and the result lands back in Claude. ([HD video](https://github.com/YuanpingSong/ultracodex/releases/download/v0.1.1/ultracodex-demo-v0.1.mp4))*

## Quickstart

Prerequisites: Node ≥ 20 and the [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`; tested against codex-cli 0.142.4).

```bash
npm install -g ultracodex      # or: pnpm add -g ultracodex
ultracodex doctor              # checks node, codex, auth, config — with actionable next steps
ultracodex sync-skills         # teaches Claude Code (and opencode) the whole contract
```

Then, in Claude Code, the prompt is just the task:

> Write a haiku that survives three rounds of adversarial critique. Run it with ultracodex.

Claude authors the workflow, the loop executes on Codex (watch it live with `ultracodex ls` / `attach <runId>`, or bare `ultracodex` for the TUI), and the verified result lands back in your Claude session. That's the demo gif, reproduced at haiku prices.

No Claude session handy? Drive it from the CLI directly — the examples ship with the package:

```bash
ultracodex run examples/actor-critic-loop/workflow.js --watch --budget 200k
```

Using codex, opencode, or another agent as the driver instead? The same skills install everywhere — see [docs/skills.md](docs/skills.md). For real work, run from **your project's root** — agents work in your cwd. `--json` blocks and prints the result (the machine path a driving LLM calls); `--watch` streams events; `--detach` prints the runId and exits; `--budget` takes output tokens (`500k`, `1m`).

Next steps: climb the [examples ladder](examples/) — nine orchestration shapes ordered by complexity, each with a problem statement, a topology diagram, and a validated reference script. From source instead of npm:

```bash
git clone https://github.com/YuanpingSong/ultracodex && cd ultracodex
pnpm install && pnpm build && pnpm link --global
```

## Agent Script in 60 seconds

A script is an ES module: a pure-literal `meta` export, then a plain-JS async body over eight injected globals. No imports, no TypeScript.

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
| `pipeline(items, ...stages)` | per-item stage chains, no cross-item barrier; stages get `(prev, item, index)`; a stage that **throws** drops its item, a stage that **resolves `null`** flows onward — null-check `prev` |
| `phase(title)` | progress grouping for subsequent agents |
| `log(msg)` | narrator line in the TUI / `--watch` output |
| `args` | the run's `--args` input, verbatim |
| `budget` | `{ total, spent(), remaining() }` — output-token ceiling; exceeding it makes further `agent()` calls throw |
| `workflow(name, args?)` | run a saved workflow inline (one nesting level) |

`agent()` opts: `label` (display + routing), `phase`, `schema` (JSON Schema), `model` / `effort` (advisory tiers, mapped in config), `isolation: 'worktree'`, `agentType` (config profile, e.g. read-only explorer).

Three axes, one format: `parallel()` is breadth, `pipeline()` is flow, **loops are depth** — plain-JS `while`/`for` that iterate until verified good, with `budget` as the governor and live pause/skip/stop as the brakes. The canonical loop, its three safety rails, and the verifier-calibration lesson live in [examples/actor-critic-loop/](examples/actor-critic-loop/). The full normative definition is [docs/agent_script_spec.md](docs/agent_script_spec.md); `ultracodex validate --strict` checks a script stays in the portable subset that runs identically under Claude Code's Workflow tool and ultracodex.

## Write your own workflows

Everything needed to author Agent Scripts — or to teach **any** model to author them — ships with the package:

- **[skills/agent-script-authoring/SKILL.md](skills/agent-script-authoring/SKILL.md)** — the authoring skill: one self-contained document (~4.7k tokens; core contract up front, craft reference behind), hardened across three evidence rounds against three model families. Given only this file plus a problem statement, GPT-5.5 authored scripts judged comparable-or-stronger than the Claude-written references on 7/7 problems; a 31B open model reached parity after one strengthening round.
- **[examples/](examples/)** — the shape gallery: nine orchestration shapes ordered as a complexity ladder, distilled from a census of 58 real production workflows. Each entry is a self-contained problem statement, a mermaid diagram of the topology, and a reference script that passes `validate --strict`.

Installing the skills into Claude Code, codex, opencode, or a raw prompt: [docs/skills.md](docs/skills.md). Whatever authors the script, gate it mechanically: `ultracodex validate --strict workflow.js` must print `ok: no issues`.

## Configuration & routing

**Zero config required** — the values below are the shipped defaults (`ultracodex doctor` prints the resolved profile). Create `.ultracodex/config.toml` (project) or `~/.ultracodex/config.toml` (global) only to override:

```toml
[route]                        # first match wins: label, then phase
"*"          = "codex"         # default: everything runs on Codex
# "verify:*" = "claude"        # advanced: in-run cross-vendor judging

[backends.codex]
sandbox        = "workspace-write"
default_model  = "gpt-5.5"
default_effort = "xhigh"
```

Routing lives in config, never in scripts — that's what keeps scripts portable across runtimes and backends. Full reference (backends, model maps, sandbox/network escalation ladder, concurrency): [docs/OPERATIONS.md](docs/OPERATIONS.md).

## CLI

```
ultracodex                        TUI home: saved workflows + recent runs
ultracodex run <script|name>      [--args JSON] [--budget 500k] [--watch|--json|--detach] [--strict]
ultracodex ls | show <ref> | attach <ref>       inspect runs (ref = unique runId prefix)
ultracodex pause|resume|skip|kill <ref>         live controls
ultracodex logs <ref> [n]         raw runner / per-agent event logs
ultracodex validate <script>      dual-runnability lint (--strict = portable subset)
ultracodex sync-skills            static + per-workflow skills → .claude/skills/
ultracodex doctor                 env, auth, execution profile, interactive-config divergences
```

Every run directory (`.ultracodex/runs/<runId>/`) is plain files — journal, per-agent events, `result.json` — and any agent's Codex session can be resumed interactively (`codex resume <threadId>`, surfaced in the TUI).

## How it works

```
script.js ──▶ loader (acorn meta parse + vm) ──▶ runtime (semantics, caps,
              budget, semaphore) ──▶ executors per [route]:
                codex  → `codex app-server` JSON-RPC, one process per slot
                claude → headless `claude -p`
              journal.jsonl ◀── every event        control.jsonl ◀── pause/stop/skip
              TUI / show / --json = pure folds over the journal
```

Structured output is belt-and-suspenders: schemas ride the wire where the backend supports it (Codex strict mode), and are always enforced on our side (prompt contract + ajv validation + repair turns on the same session). The entire test suite (380+ tests) runs hermetically against a scripted fake of the codex app-server — no API keys in CI.

Deeper reading: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/OPERATIONS.md](docs/OPERATIONS.md) · [docs/skills.md](docs/skills.md) · [docs/agent_script_spec.md](docs/agent_script_spec.md) · [docs/agent-script-plan.md](docs/agent-script-plan.md) (roadmap: pluggable backends, OpenCode adapter, packaged loop workflows).

## Status

M1–M3 shipped: runner core, app-server executor, TUI, CLI, claude backend, validate, sync-skills. Validated end-to-end on live Codex, including a clean-room rebuild of this project by Codex agents orchestrated through ultracodex itself. See [docs/PROGRESS.md](docs/PROGRESS.md).

## License

[Apache-2.0](LICENSE). The app-server turn state machine adapts patterns from OpenAI's Codex plugin for Claude Code (Apache-2.0) — see [NOTICE](NOTICE).
