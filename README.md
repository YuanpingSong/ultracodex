<p align="center">
  <a href="#workflows"><b>Workflow</b></a> 🌟
  <a href="#loops"><b>Loop</b></a> 🌟
  <a href="#scheduler"><b>Scheduler</b></a> 🌟
  <a href="#orgs"><b>Org</b></a>
</p>

# ultracodex

[![ci](https://github.com/YuanpingSong/ultracodex/actions/workflows/ci.yml/badge.svg)](https://github.com/YuanpingSong/ultracodex/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ultracodex)](https://www.npmjs.com/package/ultracodex)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**Run Claude Code workflow scripts, unmodified, on your Codex subscription — and on OpenCode.** Your Claude session writes the script and reads the verified result; the heavy lifting lands on the subscription you aren't rationing.

Measured on this repo: the same review workflow cost **~58k Claude tokens** run natively and **~82k Codex tokens with zero Claude quota** run through ultracodex ([the comparison](docs/internal/acceptance-comparison.md)). The fleets that built v0.5.0 ran 118 agents across 22 runs — 1.7M output tokens, all on Codex.

## Quickstart

Prerequisites: Node ≥ 20 and the [Codex CLI](https://github.com/openai/codex) installed and authenticated (`codex login`; tested against codex-cli 0.144.0). [OpenCode](https://opencode.ai) is optional (tested against 1.16.2) — one `[route]` line turns it on.

```bash
npm install -g ultracodex      # or: pnpm add -g ultracodex
ultracodex doctor              # checks node, codex, auth, config — with actionable next steps
ultracodex sync-skills         # teaches Claude Code (and opencode) the whole contract
```

Then, in Claude Code, the prompt is just the task:

> Write a haiku that survives three rounds of adversarial critique. Run it with ultracodex.

Claude authors the workflow, the fleet executes on Codex (watch it live with `ultracodex ls` / `attach <runId>`, or bare `ultracodex` for the TUI), and the verified result lands back in your Claude session.

Driving from the CLI works the same way — the examples ship with the package:

```bash
ultracodex run examples/actor-critic-loop/workflow.js --watch --budget 200k
```

For real work, run from **your project's root** — agents work in your cwd. `--json` blocks and prints the result (the machine path a driving LLM calls); `--watch` streams events; `--detach` prints the runId and exits; `--budget` takes output tokens (`500k`, `1m`). Runs are detached processes over plain files: quit the terminal, nothing dies.

## Workflows

**Workflows scale what agents can take on.** One script fans a task out to a fleet — parallel reviewers, pipelined stages, phased builds — and returns one verified result to whoever asked.

https://github.com/user-attachments/assets/4a7366cd-429c-4581-9703-7c28a9605c0e

*The workflow pillar, live. One prompt — "Write an essay on the meaning of life — actor–critic loop, 3 rounds. Run it with ultracodex." — Claude (left) authors the script, Codex executes it, the TUI (right) watches, and the result lands back in Claude. ([HD video](https://github.com/YuanpingSong/ultracodex/releases/download/v0.1.1/ultracodex-demo-v0.1.mp4))*

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
| `pipeline(items, ...stages)` | per-item stage chains, no cross-item barrier; stages get `(prev, item, index)` |
| `phase(title)` | progress grouping for subsequent agents |
| `log(msg)` | narrator line in the TUI / `--watch` output |
| `args` | the run's `--args` input, verbatim |
| `budget` | `{ total, spent(), remaining() }` — output-token ceiling; exceeding it makes further `agent()` calls throw |
| `workflow(name, args?)` | run a saved workflow inline (one nesting level) |

`agent()` opts: `label` (display + routing), `phase`, `schema` (JSON Schema), `model` / `effort` (advisory tiers, mapped in config), `isolation: 'worktree'`, `agentType` (config profile, e.g. read-only explorer). `parallel()` is breadth, `pipeline()` is flow, and plain-JS `while`/`for` is depth. The full normative definition is [docs/agent-script-spec.md](docs/agent-script-spec.md); `ultracodex validate --strict` checks that a script stays in the portable subset that runs identically under Claude Code's Workflow tool and ultracodex.

Everything needed to author these — or to teach **any** model to author them — ships in the box: the [authoring skill](skills/agent-script-authoring/SKILL.md) (one self-contained document, hardened against three model families; GPT-5.5 given only this file authored scripts judged comparable-or-stronger than Claude-written references on 7/7 problems) and the [examples gallery](examples/) (nine orchestration shapes ordered as a complexity ladder, distilled from a census of 58 real production workflows). Installing the skills into Claude Code, codex, opencode, or a raw prompt: [docs/skills.md](docs/skills.md).

## Loops

**Loops scale how long agents keep at it.** The stop condition moves out of your code and into a judgment: keep going until a skeptical verifier approves, until discovery runs dry, until a scheduled run reports done.

```bash
ultracodex run goal --args '{
  "task": "Implement the CSV import endpoint",
  "criteria": "Build passes. Tests pass. Malformed rows are rejected with row-level errors."
}'
```

The builder works in rounds; a separate verifier checks every criterion against the work itself and rejects until it holds. The TUI folds the rounds into a trajectory — `✖ ✖ ✔ · converged after 3 rounds` — with per-round token cost, so convergence is something you watch. Loops are plain JavaScript `while`/`for` in any script; two packaged loops ship (`goal` builds until approved, `loop` discovers until dry); `budget` is the governor and pause/skip/stop work live. → [docs/loops.md](docs/loops.md)

## Scheduler

**The scheduler runs workflows on your clock.**

```bash
ultracodex schedule add digest --every 30m --budget 200k -- run digest.js
ultracodex schedule add nightly --daily 18:30 --until-done --budget 500k -- run goal --args '…'
```

`schedule add` writes one tagged crontab line and owns it completely; there is no daemon. `--until-done` retires a schedule the day its workflow returns `{ done: true }`. `--budget` caps every scheduled run — and scheduling a run without one gets a loud warning, because an unattended loop with no ceiling can drain a quota overnight. The Schedules tab shows exec-history strips, next-fire countdowns, and a run-now key. → [docs/schedule.md](docs/schedule.md)

## Orgs

**Orgs scale what agents remember.**

One analyst can't cover five hundred stocks. A research desk can: one analyst per name, each keeping their own notes, each writing a one-page brief their lead actually reads. An org is that desk, built from agents.

An org is a directory tree. Each agent is a directory — a role contract, its own memory files, an inbox — and a tick wakes the agents whose triggers fire (time, inbox depth, severity, dependency). Every wake runs from inside the agent's own directory, so the sandbox enforces who writes what. Memory compounds between wakes, and each level distills upward into a brief of at most 80 lines for the level above. Cross-model audits verify cited claims against their sources line by line; replay re-lives ingested history with fault injection so thresholds get tuned on evidence.

This repo ships a live example: an org watching ultracodex's own dependency tree — one seat per package, group leads for runtime and toolchain, one root brief for the maintainer.

```bash
ultracodex org init      # scaffold the agent tree from coverage.toml
ultracodex org tick      # wake whoever is due, deliver messages, lint
```

The shipped org-creation skill designs the whole structure with you — coverage, role templates, fetchers, audit cadence. → [docs/org.md](docs/org.md)

## Configuration & routing

**Zero config required** — the values below are the shipped defaults (`ultracodex doctor` prints the resolved profile). Create `.ultracodex/config.toml` (project) or `~/.ultracodex/config.toml` (global) only to override:

```toml
[route]                        # first match wins: label, then phase
"*"          = "codex"         # default: everything runs on Codex
# "impl:*"   = "opencode"      # mixed routing: implementation on OpenCode…
# "review:*" = "claude"        # …adversarial review on a third vendor

[backends.codex]
sandbox        = "workspace-write"
default_model  = "gpt-5.6-sol"
default_effort = "xhigh"

[backends.opencode]
model = "deepseek/deepseek-chat"   # any provider/model your opencode knows
```

Routing lives in config, and that is what keeps scripts portable across runtimes and backends. Full reference (backends, model maps, sandbox/network escalation ladder, concurrency): [docs/operations.md](docs/operations.md).

## CLI

```
ultracodex                        TUI home: Runs | Loops | Schedules | Org
ultracodex run <script|name>      [--args JSON] [--budget 500k] [--watch|--json|--detach] [--strict]
ultracodex ls | show <ref> | attach <ref>       inspect runs (ref = unique runId prefix)
ultracodex pause|resume|skip|kill <ref>         live controls
ultracodex logs <ref> [n]         raw runner / per-agent event logs
ultracodex validate <script>      dual-runnability lint (--strict = portable subset)
ultracodex schedule add|ls|pause|resume|rm      recurring runs via owned crontab lines
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

The agent is the unit of programming here: `agent()` is a call with a typed, validated return, Agent Script is the format, and the [Executor Contract](docs/executor-contract.md) is what keeps the unit portable — a capability descriptor plus a 10-assertion conformance kit that all three adapters pass. Structured output is belt-and-suspenders: schemas ride the wire where the backend supports it (Codex strict mode, OpenCode `json_schema`), degrade to a prompt contract mid-call when a provider rejects them, and are always enforced on our side (ajv validation + repair turns on the same session). The entire test suite runs hermetically against scripted fakes of all three harnesses — no API keys in CI.

Deeper reading: [docs/loops.md](docs/loops.md) · [docs/schedule.md](docs/schedule.md) · [docs/org.md](docs/org.md) · [docs/architecture.md](docs/architecture.md) · [docs/operations.md](docs/operations.md) · [docs/skills.md](docs/skills.md) · [docs/agent-script-spec.md](docs/agent-script-spec.md) · [docs/executor-contract.md](docs/executor-contract.md) (write your own backend).

## Status

Current release: **v0.5.0** — workflows, loops, the scheduler, and orgs, in one package. 581 hermetic tests; pinned against codex-cli 0.144.0 (gpt-5.6) and opencode 1.16.2; `ultracodex doctor` reports drift with next steps.

The project builds itself, and the evidence lives in this repo:

- Same workflow, both engines: ~58k Claude tokens natively, ~82k Codex tokens and zero Claude quota through ultracodex ([acceptance comparison](docs/internal/acceptance-comparison.md)).
- The fleets that built v0.5.0: 22 runs, 118 agents, 1.7M output tokens — all on Codex, with the driving Claude session doing planning and review.
- A clean-room rebuild of this project by Codex agents, orchestrated through ultracodex, passed an independent verifier at 125/125 tests.
- One three-vendor run shipped a real feature on this repo: OpenCode implemented it, Codex gated it, Claude adversarially reviewed it — one journal.
- The org runtime's acceptance test ran here too: the dependency-watching org above completed its first full live cycle on the shipped runtime, briefs and audits included.

## License

[Apache-2.0](LICENSE). The app-server turn state machine adapts patterns from OpenAI's Codex plugin for Claude Code (Apache-2.0) — see [NOTICE](NOTICE).
