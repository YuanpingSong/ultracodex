# ultracodex

[![ci](https://github.com/YuanpingSong/ultracodex/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/ultracodex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ultracodex)](https://www.npmjs.com/package/ultracodex)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Run Claude Code workflow scripts, unmodified, on the OpenAI Codex CLI and OpenCode.** Then go further than running them: **loop** them until a skeptical verifier approves, **schedule** them with cron doing the waking, or stand up a permanent **organization** of agents that remembers.

> **Fable plans, Codex executes, Fable verifies**

Your best model plans and judges; the subscription you're not rationing does the work. Verified results land back in the session that asked. Quit the terminal — runs are detached processes over plain files, nothing dies. And any model can write these workflows: the [authoring skill](skills/agent-script-authoring/SKILL.md) and a [nine-shape example gallery](examples/) ship in the box.



https://github.com/user-attachments/assets/4a7366cd-429c-4581-9703-7c28a9605c0e


*One prompt: "Write an essay on the meaning of life — actor–critic loop, 3 rounds. Run it with ultracodex." Claude (left) authors the workflow, Codex executes it, the TUI (right) watches live, and the result lands back in Claude. ([HD video](https://github.com/YuanpingSong/ultracodex/releases/download/v0.1.1/ultracodex-demo-v0.1.mp4))*

## Run once. Run until good. Run forever.

Software has always been programmed around someone else's units — functions, modules, services. ultracodex makes the **agent** the unit of programming: `await agent(prompt, { schema })` is a call with a typed, validated return; plain JavaScript is the composition language; the [Executor Contract](docs/executor-contract.md) is the ABI that keeps the unit portable across vendors. And once the agent is a unit, there are exactly three axes on which to scale it:

| shape | pillar | scales |
|---|---|---|
| Run once | **Workflows** | **what agents can take on** — space: the structure one run spans (`parallel` breadth, `pipeline` flow, phased fleets) |
| Run until good | **Loops** | **how long agents keep at it** — time: rounds within a run, schedules across runs; the stop condition moves from code to judgment |
| Run forever | **Orgs** | **what agents remember** — state: memory that survives runs and compounds |

These are axes, not buckets: an actor–critic script is one run scaling along time, and the Loops tab is a lens that finds that axis inside any run. Every axis gets its lens — **Runs** for space, **Loops** for time, **Org** for state, with **Schedules** managing the clock that drives them.

**Loops** are plain JavaScript — no loop primitive, no new syntax. Two reference loops ship in the package (`goal` and `loop`), the TUI folds round-labeled agents into trajectory dashboards (`✖ ✖ ✔ · converged after 3 rounds`, cost per round trending down), and `ultracodex schedule` makes any workflow recurring with a tagged crontab line it fully owns — `--until-done` retires the schedule the day the script returns `{ done: true }`. No daemon, ever. → [docs/loops.md](docs/loops.md) · [docs/schedule.md](docs/schedule.md)

**Orgs** are for domains a single run can't hold. Each agent is a directory — a role contract, memory files divided by update trigger, an inbox — woken by triggers (time, inbox depth, severity, dependency) and executed from inside its own directory, so the sandbox itself enforces who writes what. Superiors read one ≤80-line BRIEF per seat. Messages are routed contracts the runtime actually enforces; cross-model audits verify cited claims line by line; replay re-lives history with fault injection before you trust a threshold. Stand one up from a `coverage.toml` with `org init` — or let the shipped org-creation skill design it with you. → [docs/org.md](docs/org.md)

The TUI ties it together: **Runs | Loops | Schedules | Org** — four tabs, all pure folds over plain files.

## Quickstart

Prerequisites: Node ≥ 20 and the [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`; tested against codex-cli 0.142.4). [OpenCode](https://opencode.ai) is optional (tested against 1.16.2) — one `[route]` line turns it on.

```bash
npm install -g ultracodex      # or: pnpm add -g ultracodex
ultracodex doctor              # checks node, codex, auth, config — with actionable next steps
ultracodex sync-skills         # teaches Claude Code (and opencode) the whole contract
```

Then, in Claude Code, the prompt is just the task:

> Write a haiku that survives three rounds of adversarial critique. Run it with ultracodex.

Claude authors the workflow, the loop executes on Codex (watch it live with `ultracodex ls` / `attach <runId>`, or bare `ultracodex` for the TUI), and the verified result lands back in your Claude session. That's the demo video, reproduced at haiku prices.

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

Three axes, one format: `parallel()` is breadth, `pipeline()` is flow, **loops are depth** — plain-JS `while`/`for` that iterate until verified good, with `budget` as the governor and live pause/skip/stop as the brakes. The canonical loop, its three safety rails, and the verifier-calibration lesson live in [examples/actor-critic-loop/](examples/actor-critic-loop/). The full normative definition is [docs/agent-script-spec.md](docs/agent-script-spec.md); `ultracodex validate --strict` checks a script stays in the portable subset that runs identically under Claude Code's Workflow tool and ultracodex.

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
# "impl:*"   = "opencode"      # mixed routing: implementation on OpenCode…
# "review:*" = "claude"        # …adversarial review on a third vendor

[backends.codex]
sandbox        = "workspace-write"
default_model  = "gpt-5.5"
default_effort = "xhigh"

[backends.opencode]
model = "deepseek/deepseek-chat"   # any provider/model your opencode knows
```

Routing lives in config, never in scripts — that's what keeps scripts portable across runtimes and backends. Full reference (backends, model maps, sandbox/network escalation ladder, concurrency): [docs/operations.md](docs/operations.md).

## CLI

```
ultracodex                        TUI home: saved workflows + recent runs
ultracodex run <script|name>      [--args JSON] [--budget 500k] [--watch|--json|--detach] [--strict]
ultracodex ls | show <ref> | attach <ref>       inspect runs (ref = unique runId prefix)
ultracodex pause|resume|skip|kill <ref>         live controls
ultracodex logs <ref> [n]         raw runner / per-agent event logs
ultracodex validate <script>      dual-runnability lint (--strict = portable subset)
ultracodex schedule add|ls|pause|resume|rm      recurring runs via owned crontab lines (--until-done)
ultracodex org init|tick|status|send|ask|audit|replay|lint   the org runtime
ultracodex sync-skills            static + per-workflow skills → .claude/skills/
ultracodex doctor                 env, auth, execution profile, schedules, interactive-config divergences
```

Every run directory (`.ultracodex/runs/<runId>/`) is plain files — journal, per-agent events, `result.json` — and any agent's Codex session can be resumed interactively (`codex resume <threadId>`, surfaced in the TUI).

## How it works

```
script.js ──▶ loader (acorn meta parse + vm) ──▶ runtime (semantics, caps,
              budget, semaphore) ──▶ executors per [route]:
                codex    → `codex app-server` JSON-RPC, one process per slot
                opencode → `opencode serve` HTTP + SSE, one server per call
                claude   → headless `claude -p`
              journal.jsonl ◀── every event        control.jsonl ◀── pause/stop/skip
              TUI / show / --json = pure folds over the journal
```

Every backend implements one documented seam — the [Executor Contract](docs/executor-contract.md): a capability descriptor (schema/resume/interrupt/usage/activity/sandbox) plus a 10-assertion conformance kit that all three adapters pass. Structured output is belt-and-suspenders: schemas ride the wire where the backend supports it (Codex strict mode, OpenCode `json_schema`), degrade to a prompt contract mid-call when a provider rejects them, and are always enforced on our side (ajv validation + repair turns on the same session). The entire test suite (460+ tests) runs hermetically against scripted fakes of all three harnesses — no API keys in CI.

Deeper reading: [docs/loops.md](docs/loops.md) · [docs/schedule.md](docs/schedule.md) · [docs/org.md](docs/org.md) · [docs/architecture.md](docs/architecture.md) · [docs/operations.md](docs/operations.md) · [docs/skills.md](docs/skills.md) · [docs/agent-script-spec.md](docs/agent-script-spec.md) · [docs/executor-contract.md](docs/executor-contract.md) (write your own backend).

## Status

M1–M3 shipped: runner core, app-server executor, TUI, CLI, claude backend, validate, sync-skills. Validated end-to-end on live Codex, including a clean-room rebuild of this project by Codex agents orchestrated through ultracodex itself.

M4 shipped (v0.4.0): the executor seam is a versioned contract with a conformance kit, and OpenCode is the third backend to pass it. The acceptance test was recursive — one run on this repo where OpenCode implemented a feature, Codex gated it, and Claude adversarially reviewed it, green in a single journal. Every build wave of M4 was itself executed by ultracodex fleets.

v0.5.0 is the trifecta: the loops pillar (packaged `goal`/`loop`, the schedule manager, trajectory-dashboard observability, Schedules tab) and the org pillar (`ultracodex org`, the org-creation skill, audits, replay, the Org tab) — every piece fleet-built by ultracodex running on itself, and the org runtime's acceptance test was an org of analyst agents watching this repo's own dependency tree.

## License

[Apache-2.0](LICENSE). The app-server turn state machine adapts patterns from OpenAI's Codex plugin for Claude Code (Apache-2.0) — see [NOTICE](NOTICE).
