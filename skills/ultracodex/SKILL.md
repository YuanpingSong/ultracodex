---
name: ultracodex
description: Author and run multi-agent Agent Script workflows on the OpenAI Codex CLI via the ultracodex runner. Use when the user asks to run a workflow with ultracodex, orchestrate parallel agents, fan-outs, pipelines, or actor-critic / builder-verifier loops, or to offload multi-agent execution from Claude to Codex.
---

ultracodex executes Claude Code Workflow-tool scripts unmodified, routing each `agent()` call to an OpenAI Codex session. This file is the complete contract — assume the `ultracodex` binary is installed and authenticated; do NOT explore the CLI with --help, inspect the repo, or run doctor first (only run `ultracodex doctor` if a command fails unexpectedly).

## Authoring

Write the script EXACTLY as you would for the Workflow tool — same format, byte for byte: `export const meta = {name, description, phases?}` as a pure literal, then a plain-JS async body over the injected globals `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` / `budget` / `workflow`. Loops are ordinary JavaScript (null-check every agent result; guard unbounded loops on `budget`). No imports, no TypeScript. Save it to a file. If the Workflow tool schema is not in your context, learn the format from the **agent-script-authoring** skill (installed alongside this one; also at `skills/agent-script-authoring/SKILL.md` in the ultracodex package).

## Running

```bash
ultracodex run <file> --json [--budget 500k] [--args '<json>']
```

- Blocks until the run completes; stdout is the result JSON (the script body's return value). Non-zero exit = the run failed.
- `--budget` is an output-token ceiling (integer, k/m suffixes).
- Model/backend routing lives in `.ultracodex/config.toml`, never in the script.
- Optional pre-check: `ultracodex validate <file> --strict`. Fix ERRORS; WARNINGS are non-blocking — do not rewrite a working script just to silence a warning.
- The human can watch live with `ultracodex ls` / `attach <runId>` — you do not need to poll.

## Results

Relay the run's stdout verbatim (then you may summarize it). If the run failed, report the failure as-is and stop — do NOT substitute your own answer for the workflow's work.
