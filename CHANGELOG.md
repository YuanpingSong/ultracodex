# Changelog

All notable changes to **ultracodex**. Full history: <https://github.com/YuanpingSong/ultracodex/releases>

## v0.5.0 — Workflow · Loop · Scheduler · Org (2026-07-10)

The agent is the unit of programming: `agent()` is a call with a typed, validated
return, plain JavaScript composes it, and the Executor Contract keeps it portable
across Codex, Claude, and OpenCode. v0.5.0 completes the picture — the same unit
now **runs once** (Workflow), **runs until it's good** (Loop), **runs on a clock**
(Scheduler), and **remembers** (Org).

### Loops

- **`goal`**, packaged in the box: builder rounds against explicit criteria, gated
  by a skeptical verifier — and the criteria carry the stop condition, so
  completion goals ("the backlog is empty") work too. Strict-valid portable Agent
  Script; returns `{ done }` so it composes with scheduling.
- `run <name>` resolves packaged workflows after project-saved ones; nested
  `workflow('<name>')` too.
- **Loop observability** — agents tagged with the round grammar
  (`<loop>:<role>-r<N>`, bare `-r<N>`, or `Round N` phases) fold into trajectory
  dashboards: verdict strip, converged-after-N, per-round token cost. New LoopView,
  a **Loops** home tab, and a LOOPS section in `show`.

### Scheduler

- `ultracodex schedule add|ls|pause|resume|rm` — recurring runs via **one tagged
  crontab line per schedule**, fully owned (installed, rewritten, and removed
  without touching the rest of your crontab). There is no daemon.
- `--until-done` retires a schedule when its run returns `{ done: true }`;
  `--max-runs` caps repetition; `--budget` caps every scheduled run, and scheduling
  an unbudgeted run warns loudly.
- Missed-run nudges at startup, a `doctor` section for crontab drift, and a
  **Schedules** home tab (exec-history strips, next-fire countdowns, exec-now,
  pause/resume/remove, schedule-from-TUI with `S`). `ULTRACODEX_CRONTAB_FILE` makes
  every schedule operation testable against a file instead of your real crontab.

### Orgs (experimental)

- `ultracodex org init|tick|wake|send|ask|tickets|lint|status|audit|replay` —
  filesystem-routed agent organizations. Each agent is a directory (role contract,
  memory files, inbox), woken by triggers (time, inbox, severity, dependency) and
  executed from inside its own directory so the sandbox enforces the single-writer
  rule. Superiors read one ≤80-line **BRIEF** per seat.
- Messages are routed contracts: NOTIFY never travels up your own chain, REQUEST
  opens tickets ancestor-to-descendant, replies ride the ticket. Violations are
  ledgered, the sender gets feedback, and one failed wake never aborts a tick.
- `org audit` verifies cited claims against their sources and delivers findings as
  inbox notifies (agents self-correct next tick); `org replay` re-lives ingested
  history with fault injection (`--pristine` for true counterfactuals).
- The **org-creation skill** designs an org with you — coverage, role templates,
  fetcher contract, audit cadence — and an **Org** home tab renders the live tree,
  an ops board, and a briefs reader.
- Ships **experimental**: the runtime is tested end to end, but the discipline is
  young — supervise early cycles; don't schedule them unattended yet.

### Engine & TUI

- **GPT-5.6 lineup**, pinned against **codex-cli 0.144.0**: fable/opus →
  gpt-5.6-sol, sonnet → gpt-5.6-terra, haiku → gpt-5.6-luna; reasoning efforts
  `max` and `ultra` pass through natively.
- The TUI home is now **four tabs — Runs · Loops · Schedules · Org** — all pure
  folds over plain files, with a lightweight status line (default backend · model ·
  routed backends), contextual empty-state onboarding, and consistent keyboard nav.
- **603 hermetic tests** (all three backends faked; no API keys in CI), plus a live
  pre-release gate that runs a real workflow against Codex and asserts the journal,
  not just the final JSON.

### Receipts

Every number in the README traces to a committed artifact — a
[four-model controlled comparison](https://github.com/YuanpingSong/ultracodex/blob/v0.5.0/docs/internal/research/cmp-build/README.md)
(same script, one `[route]` line apart, raw journals included) and the
[v0.5.0 fleet ledger](https://github.com/YuanpingSong/ultracodex/blob/v0.5.0/docs/internal/research/v050-fleet-usage.md)
(14 runs, 72 agents, 1.26M output tokens, all on Codex). Every feature in this
release was built by ultracodex fleets running on ultracodex.

### Compatibility & upgrading

```bash
npm install -g ultracodex && ultracodex doctor
```

- Agent Scripts are unchanged and remain **byte-compatible with Claude Code's
  Workflow tool** (`validate --strict` checks the portable subset).
- Shipped defaults moved to **gpt-5.6 / codex-cli 0.144.0**. On older codex
  binaries, `doctor` reports the drift; pin models via config if needed.
- A project `.ultracodex/workflows/<name>.js` now shadows a packaged workflow of
  the same name (`goal`, `org-audit`, `org-lint-repair`).

---

### Earlier releases

- **v0.4.0** (2026-07-06) — *the multi-vendor release*: the OpenCode backend, the
  Executor Contract v1 + a 10-assertion conformance kit, mixed per-`[route]`
  routing, and a `doctor` OpenCode section.
- **v0.3.0** (2026-07-06) — *the authoring release*: packaged skills, a Claude Code
  plugin, an examples gallery, and the docs split.
- **v0.2.0** (2026-07-06): phase navigation, a height-responsive run view, an
  upgraded `doctor`, journaled resolved model/effort, `network_access`, `extra_args`.
- **v0.1.0 / v0.1.1** (2026-07-03): first public release — runs Claude Code
  workflow scripts, unmodified, on the Codex app-server.
