---
name: ultracodex
description: Author and run multi-agent Agent Script workflows on the OpenAI Codex CLI (and OpenCode) via the ultracodex runner. Use when the user asks to run a workflow with ultracodex, orchestrate parallel agents, fan-outs, pipelines, or builder-verifier loops, to schedule recurring agent runs, to stand up an agent org, or to offload multi-agent execution from Claude to Codex.
---

ultracodex executes Claude Code Workflow-tool scripts unmodified, routing each `agent()` call to an OpenAI Codex (or OpenCode) session. This file is the complete contract — assume the `ultracodex` binary is installed and authenticated; do NOT explore the CLI with --help, inspect the repo, or run doctor first (only run `ultracodex doctor` if a command fails unexpectedly).

## Choosing the shape

**Default to authoring a workflow.** The other shapes exist, and you should reach for them ONLY when the user's own words ask for what they do — recurrence, a packaged loop by intent, a standing org. When in doubt: a workflow.

| the user asks for | reach for |
|---|---|
| a task done — build, review, research, migrate | **author a workflow** (the default, including loop-shaped ones) |
| "keep iterating until it's good / until nothing is left", no bespoke roles | `ultracodex run goal` (packaged builder-verifier) |
| "every night / every 30m / keep it running on a schedule" | `ultracodex schedule add` wrapping a run |
| standing coverage of many subjects with memory that compounds | an org — **experimental**; only on explicit request |

If the request implies recurrence or standing coverage without saying so ("track X for me", "keep an eye on Y"), name the options — run once now, a budgeted schedule, or an experimental org — and let the user pick. Do not guess upward.

## Authoring

Write the script EXACTLY as you would for the Workflow tool — same format, byte for byte: `export const meta = {name, description, phases?}` as a pure literal, then a plain-JS async body over the injected globals `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` / `budget` / `workflow`. Loops are ordinary JavaScript (null-check every agent result; guard unbounded loops on `budget`). No imports, no TypeScript. Save it to a file.

Format reference, in priority order: if the **Workflow tool's definition is in your context** (the session has the tool), use that — it is the native, authoritative description and you already know the format. Otherwise, learn the format from the **agent-script-authoring** skill (installed alongside this one; also at `skills/agent-script-authoring/SKILL.md` in the ultracodex package).

## Running

```bash
ultracodex run <file-or-name> --json [--budget 500k] [--args '<json>']
```

- Blocks until the run completes; stdout is the result JSON (the script body's return value). Non-zero exit = the run failed.
- `--budget` is an output-token ceiling (integer, k/m suffixes).
- Model/backend routing lives in `.ultracodex/config.toml`, never in the script.
- Optional pre-check: `ultracodex validate <file> --strict`. Fix ERRORS; WARNINGS are non-blocking — do not rewrite a working script just to silence a warning.
- Inspect a finished run with `ultracodex show <runId>` — result, per-agent lines, and a round-by-round LOOPS trajectory for iterating runs. The human can watch live with `ultracodex ls` / `attach <runId>` — you do not need to poll.

## The packaged loop

One reference loop ships in the package and resolves by name:

```bash
ultracodex run goal --json --budget 300k --args '{"task":"...","criteria":"explicit, verifier-checkable"}'
```

`goal` runs builder rounds gated by a skeptical verifier until the criteria hold (also: `maxRounds`, `context`, `builderModel`/`verifierModel`). The criteria carry the stop condition — completion works too ("the backlog is empty", "a fresh search finds nothing unlisted"). It returns `{ done: ... }` — and any workflow that returns `{ done: true }` composes with scheduled `--until-done` runs.

## Scheduling

```bash
ultracodex schedule add <name> (--every 30m | --daily 18:30) --budget 200k -- run <workflow> [--args '<json>']
ultracodex schedule ls | pause <name> | resume <name> | rm <name>
```

One tagged crontab line per schedule, fully owned; there is no daemon. ALWAYS pass `--budget` on scheduled runs — an unattended loop with no ceiling can drain the user's quota (the CLI warns if you omit it). `--until-done` retires the schedule when the run returns `{ done: true }`; `--max-runs N` caps repetition.

## Orgs (experimental)

An org is a directory tree of agents with durable memory — one seat per subject, inboxes, tickets, briefs rolling up the tree — ticked by `ultracodex org tick`. Day-2 verbs, exactly these shapes: `org status --json` · `org ask <seat> "<question>"` (read-only fork) · `org tick --json` (no watch flag; it runs to completion) · `org lint --json` · `org audit` · `org replay`. To design one, use the **org-creation** skill (installed alongside this one). Treat the whole pillar as experimental — and SAY SO: whenever you set up or recommend an org, explicitly tell the user it is experimental, with young interfaces and disciplines, and that early cycles deserve supervision rather than unattended scheduling.

## Results

Relay the run's stdout verbatim (then you may summarize it). If the run failed, report the failure as-is and stop — do NOT substitute your own answer for the workflow's work.
