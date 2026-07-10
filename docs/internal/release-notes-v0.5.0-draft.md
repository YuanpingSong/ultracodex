# v0.5.0 — Workflow · Loop · Scheduler · Org (DRAFT for the GitHub release)

The agent is the unit of programming: `agent()` is a call with a typed,
validated return, plain JavaScript composes it, and the Executor Contract
keeps it portable across vendors. v0.5.0 completes the picture — the same
unit now runs once, runs until good, and runs forever.

## Loops

- Two packaged workflows ship in the box: **`goal`** (builder rounds
  against explicit criteria, gated by a skeptical verifier) and **`loop`**
  (until-dry discovery with dedup and an optional adversarial verifier).
  Both are strict-valid portable Agent Scripts; both return `{ done }` so
  they compose with scheduling.
- `run <name>` resolves packaged workflows after project-saved ones;
  nested `workflow('<name>')` too.
- **Loop observability**: agents labeled with the round grammar
  (`<loop>:<role>-r<N>`, bare `-r<N>`, or `Round N` phases) fold into
  trajectory dashboards — verdict strip, converged-after-N, per-round
  token cost. New LoopView in the TUI, a Loops home tab, and a LOOPS
  section in `show`.

## Scheduler

- `ultracodex schedule add|ls|pause|resume|rm` — recurring runs via one
  tagged crontab line per schedule, fully owned (installed, rewritten,
  removed without touching anything else in your crontab). There is no
  daemon.
- `--until-done` retires a schedule when its run returns `{ done: true }`;
  `--max-runs` caps repetition; `--budget` caps every scheduled run, and
  scheduling an unbudgeted run warns loudly.
- Missed-run nudges at startup, a doctor section for crontab drift, and a
  Schedules home tab: exec-history strips, next-fire countdowns, exec-now,
  pause/resume/remove, and schedule-from-TUI (`S` on any workflow).
- `ULTRACODEX_CRONTAB_FILE` makes every schedule operation testable
  against a file instead of your real crontab.

## Orgs (experimental)

- `ultracodex org init|tick|wake|send|ask|tickets|lint|status|audit|replay`
  — filesystem-routed agent organizations. Each agent is a directory
  (role contract, memory files, inbox), woken by triggers (time, inbox,
  severity, dependency), executed from inside its own directory so the
  sandbox enforces the single-writer rule. Superiors read one ≤80-line
  BRIEF per seat.
- Messages are routed contracts: NOTIFY never travels up your own chain,
  REQUEST opens tickets ancestor-to-descendant, replies ride the ticket.
  Violations are ledgered, the sender gets feedback, the tick continues —
  and one failed wake never aborts a tick.
- `org audit` verifies cited claims against their sources and delivers
  findings as inbox notifies (agents self-correct next tick); `org replay`
  re-lives ingested history with fault injection (`--pristine` for true
  counterfactuals).
- Orgs ship as **experimental**: the runtime is tested end to end, and the
  discipline is young — supervise early cycles. The **org-creation skill**
  designs an org with you — coverage, role
  templates, fetcher contract, audit cadence. An Org home tab renders the
  live tree, an ops board, and a briefs reader.

## Engine

- **GPT-5.6 lineup**: pinned against codex-cli 0.144.0; shipped tier map
  is fable/opus → gpt-5.6-sol, sonnet → gpt-5.6-terra, haiku → gpt-5.6-luna;
  reasoning efforts `max` and `ultra` pass through natively.
- The TUI home is now four tabs: **Runs | Loops | Schedules | Org** — all
  pure folds over plain files.
- 581 hermetic tests (all three backends faked; no API keys in CI).

## Receipts

Every number in the README traces to a committed artifact:
[the four-model controlled comparison](docs/internal/research/cmp-build/README.md)
(same script, one `[route]` line apart — raw journals included) and
[the v0.5.0 fleet ledger](docs/internal/research/v050-fleet-usage.md)
(14 runs, 72 agents, 1.26M output tokens, all on Codex). Every feature in
this release was built by ultracodex fleets running on ultracodex.

## Compatibility

- Agent Scripts are unchanged and remain byte-compatible with Claude
  Code's Workflow tool (`validate --strict` checks the portable subset).
- Shipped defaults moved to gpt-5.6 / codex-cli 0.144.0. On older codex
  binaries, `doctor` reports the drift; pin models via config if needed.
- New reserved behavior: a project `.ultracodex/workflows/<name>.js`
  shadows a packaged workflow of the same name (`goal`, `loop`,
  `org-lint-repair`, `org-audit`).
