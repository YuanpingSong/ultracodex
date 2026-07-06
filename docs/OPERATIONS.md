# ultracodex operations

## Prerequisites

- Node ≥ 20, pnpm.
- OpenAI Codex CLI installed and authenticated (`codex login` or
  `OPENAI_API_KEY`). Pinned against codex 0.142.4.
- Optional: Claude Code CLI for the `claude` backend routes.

Run `ultracodex doctor` to check all of the above with actionable next steps.

## Everyday commands

```
ultracodex                       # TUI home: saved workflows + recent runs
ultracodex run wf.js --args '{"q":"..."}' --budget 500k
ultracodex run <saved-name> --json          # machine path (what Claude calls)
ultracodex ls                               # runs with pid-liveness
ultracodex show uc_ab --wait --timeout-ms 600000
ultracodex attach uc_ab                     # TUI onto a live run
ultracodex pause uc_ab | resume uc_ab       # soft pause (stops new launches)
ultracodex skip uc_ab 4                     # resolve agent 4 to null
ultracodex kill uc_ab                       # control-stop → SIGTERM → SIGKILL
ultracodex logs uc_ab 4                     # raw codex events for agent 4
ultracodex validate wf.js --strict          # dual-runnability lint
ultracodex sync-skills                      # workflows/ → .claude/skills/*
```

Any `<runId>` accepts a unique prefix. Quitting the TUI never kills a run;
runs are owned by their own detached runner process (pidfile in the run dir).

## State layout

```
.ultracodex/
  config.toml          # [route] label/phase globs → backend; [backends.*] maps
  workflows/<name>.js  # saved workflows (meta.name must match filename)
  runs/<runId>/        # journal.jsonl (spine), control.jsonl, pid, agents/<n>/,
                       # script.js + args.json snapshots, result.json
```

Everything is inspectable text; `journal.jsonl` is append-only and replayable.

## Routing example

```toml
[route]
"critique:*" = "claude"   # ADVANCED: in-run judge; usually unneeded — results
                          # return to your Claude session, which verifies free
"*"          = "codex"    # execution goes to Codex

[backends.codex]
sandbox        = "workspace-write"
default_model  = "gpt-5.5"
default_effort = "xhigh"
service_tier   = "standard"    # never inherit fast mode from ~/.codex
model_map      = { opus = "gpt-5.5", sonnet = "gpt-5.4", haiku = "gpt-5.4-mini" }
```

## Sandbox & network: the escalation ladder

Workflow agents default to **`workspace-write` + no network + approvals
auto-denied**: file writes confined to the project dir, reads unrestricted,
no egress. This is deliberate — unattended fleets often process untrusted
content (fetched docs, third-party repos), and no-egress is what makes that
safe by default.

Escalate deliberately, per project, in `.ultracodex/config.toml`:

```toml
[backends.codex]
network_access = true            # 1. egress inside the sandbox (pnpm install,
                                 #    APIs, web) — file WRITES stay confined

# sandbox = "danger-full-access" # 2. no sandbox at all: writes anywhere your
                                 #    user can, network on

[profiles.Networked]             # 3. per-agent: only agents the script marks
network_access = true            #    with agentType escalate
```

Treat tier 1 as already aggressive: the sandbox never restricted READS, so
network + read-anywhere is an exfiltration-capable combination — an agent
that ingests untrusted content on tier 1 can be prompt-injected into leaking
anything your user account can read. Escalate per task, not as a standing
default, and never combine tier 1 with untrusted inputs. Tier 2 is for
sessions a human is actively watching — never for unattended fleet runs.
Default posture for anything that reads fetched/third-party content: stock
defaults (no network) and pre-fetch inputs into the project dir.

## Failure playbook

- `ls` shows `dead`: the runner exited without `run_end` — inspect
  `runs/<id>/runner.log`, re-run (`r` in the TUI re-runs with the same args).
- Wedged runner: `ultracodex kill <id>` escalates control-file → SIGTERM →
  SIGKILL via the pidfile.
- Schema failures: agents get up to 3 repair turns on the same codex thread;
  persistent failures resolve that agent to `null` (scripts must null-check,
  same as upstream).
- Any agent's codex session can be continued interactively:
  `codex resume <threadId>` (shown in agent detail and `show`).
