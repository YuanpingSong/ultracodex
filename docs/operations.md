# ultracodex operations

## Prerequisites

- Node ≥ 20, pnpm.
- OpenAI Codex CLI installed and authenticated (`codex login` or
  `OPENAI_API_KEY`). Pinned against codex 0.142.4.
- Optional: Claude Code CLI for the `claude` backend routes.
- Optional: [OpenCode](https://opencode.ai) for the `opencode` backend routes
  (tested against 1.16.2; any provider/model configured in your opencode,
  local models included).

Run `ultracodex doctor` to check all of the above with actionable next steps.
Beyond pass/fail checks it also prints (as `ℹ` info lines, never affecting the
exit code): the resolved execution profile your agents actually run with
(model · effort · sandbox · network · service tier · approvals); where that
**diverges from your interactive codex** (`~/.codex/config.toml` — e.g. a
`service_tier = "fast"` or approval policy the fleet does not inherit); and
any MCP servers your interactive config loads into every agent thread (a
common source of hidden per-agent startup latency).

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
ultracodex sync-skills                      # static skills + workflows/ → .claude/skills/*
ultracodex schedule add digest --every 30m -- run digest.js
ultracodex schedule ls                      # schedules for this project
ultracodex schedule pause digest            # pause | resume | rm <name>
ultracodex org init                         # scaffold an org from coverage.toml
ultracodex org tick                         # run due org wakes
ultracodex org audit --sample 25 --json     # audit sampled BRIEF/THESIS claims
ultracodex org replay --from 2026-07-01 --to 2026-07-07
```

Any `<runId>` accepts a unique prefix. Quitting the TUI never kills a run;
runs are owned by their own detached runner process (pidfile in the run dir).
Schedules are manager-owned crontab lines, not resident ultracodex daemons; see
[Scheduling runs](schedule.md).
Org commands manage filesystem-routed agent trees; see [Org runtime](org.md).

TUI home keys: `tab` cycles Runs → Loops → Schedules. Runs keeps `n` for a new
workflow run, `r` for re-run, and `S` on a workflow to schedule it. Schedules
uses `enter` for detail, `e` for exec-now, `p` for pause/resume, and `x` for
remove with confirmation.

## State layout

```
.ultracodex/
  config.toml          # [route] label/phase globs → backend; [backends.*] maps
  workflows/<name>.js  # saved workflows (meta.name must match filename)
  runs/<runId>/        # journal.jsonl (spine), control.jsonl, pid, agents/<n>/,
                       # script.js + args.json snapshots, result.json
  org/state/           # last-wake.json, audit-history.jsonl
```

Everything is inspectable text; `journal.jsonl` is append-only and replayable.

## Routing example

Zero config is required — everything below except the `"critique:*"` route
and `[run] concurrency` matches the shipped defaults (see
`DEFAULT_CONFIG`/`DEFAULT_CODEX_CONFIG` in `src/constants.ts`; `ultracodex
doctor` prints the resolved profile). Config files exist to override:
global `~/.ultracodex/config.toml` first, then project
`.ultracodex/config.toml` on top.

```toml
[route]
"impl:*"     = "opencode" # mixed routing: implementation on one vendor…
"critique:*" = "claude"   # …judgment on another. ADVANCED: usually unneeded —
                          # results return to your Claude session, which verifies free
"*"          = "codex"    # everything else goes to Codex

[backends.codex]
sandbox        = "workspace-write"
default_model  = "gpt-5.5"
default_effort = "xhigh"
service_tier   = "standard"    # never inherit fast mode from ~/.codex
model_map      = { opus = "gpt-5.5", sonnet = "gpt-5.4", haiku = "gpt-5.4-mini" }

[backends.opencode]
model       = "deepseek/deepseek-chat"  # "provider/model" as your opencode names them
binary      = "opencode"                # override for a pinned install
model_map   = { sonnet = "deepseek/deepseek-chat" }   # script tier → provider/model
variant_map = { high = "high" }         # script effort → provider variant (omit = none)

[run]
concurrency = 6                # default: min(16, cores-2)
```

Route in-run judges to the claude backend only when judgment must happen
INSIDE the run — per-round loop verifiers, per-item gates, or unattended
(cron/CI) workflows where no parent session is waiting. Routing lives in
config, never in scripts — that is what keeps scripts portable across
runtimes and backends.

Mixed routing is the cross-vendor story in one table: label your script's
agents by role (`impl:*`, `gate:*`, `review:*`) and route each role to the
backend best cast for it — implementation on the cheap/open vendor, gates on
Codex, adversarial review on Claude, one journal for all of it.

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

**The opencode backend has no OS sandbox at all** — treat every opencode
route as tier 2. Headless opencode executes tools including shell with no
approval gate, has network, and inherits the MCP servers from your opencode
user config into every agent session. The engine journals a warning when a
profile requests a sandbox opencode cannot honor, and `ultracodex doctor`
prints the full posture whenever a route targets opencode. Route
implementation work you'd be comfortable running as yourself; keep
untrusted-content ingestion on the codex backend's sandbox.

## Failure playbook

- Running ultracodex from INSIDE a sandboxed agent (nested fleets): the
  inner codex app-server needs a writable state home. Export
  `CODEX_HOME="$PWD/.codex-home"` (and copy `~/.codex/auth.json` into it)
  so state lands inside the workspace; the sandbox blocks `~/.codex`.
- `ls` shows `dead`: the runner exited without `run_end` — inspect
  `runs/<id>/runner.log`, re-run (`r` in the TUI re-runs with the same args).
- Wedged runner: `ultracodex kill <id>` escalates control-file → SIGTERM →
  SIGKILL via the pidfile.
- Schema failures: agents get up to 3 repair turns on the same codex thread;
  persistent failures resolve that agent to `null` (scripts must null-check,
  same as upstream).
- Any agent's codex session can be continued interactively:
  `codex resume <threadId>` (shown in agent detail and `show`).
