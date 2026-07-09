# ultracodex docs

User-facing documentation:

| doc | what it's for |
|---|---|
| [skills.md](skills.md) | installing the run + authoring skills into Claude Code, codex, opencode, or a raw prompt |
| [operations.md](operations.md) | CLI reference, configuration & routing, state layout, the sandbox/network escalation ladder |
| [schedule.md](schedule.md) | cron-backed schedule management for unattended runs without an ultracodex daemon |
| [loops.md](loops.md) | packaged goal and until-dry loops, args, round labels, and schedule-friendly convergence |
| [org.md](org.md) | filesystem-routed org runtime: scaffold, tick, routing, lint, audit, replay, and fetcher ledger contract |
| [architecture.md](architecture.md) | how the runtime works: loader, journal-as-spine, executors, TUI |
| [agent-script-spec.md](agent-script-spec.md) | the Agent Script language & runtime specification — for engine implementers (script *writers* want the [authoring skill](../skills/agent-script-authoring/SKILL.md) instead) |
| [executor-contract.md](executor-contract.md) | Executor Contract v1 — the complete contract for writing a backend adapter (interface, invariants, capability descriptor, conformance kit) |

The nine-shape example gallery lives in [examples/](../examples/), and the skills themselves in [skills/](../skills/).

[internal/](internal/) holds the project's working papers — product spec, roadmap, decision records, build logs, research — kept public for transparency but written for ourselves.
