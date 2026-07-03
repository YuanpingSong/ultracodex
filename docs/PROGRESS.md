# ultracodex progress

Status as of 2026-07-02. **M1–M3 complete and shipped.**

## Shipped (M1–M3)

- Full runner: loader, app-server executor (JSON-RPC, `captureTurn` state
  machine, per-turn usage), runtime globals with upstream semantics, journal +
  control channel, detached runner, worktrees, budget ledgers.
- Ink TUI (home/run/detail/timeline), CLI surface (run/ls/show/attach/
  pause/resume/kill/skip/logs/validate/sync-skills/doctor), claude backend +
  config routing.
- 338 hermetic tests (fake-codex fixture) + live end-to-end on real codex.
- Adversarial review pass: 5-dimension review → dual-skeptic verification →
  27 confirmed findings fixed → re-verified green.
- Clean-room validation complete: Codex agents rebuilt the project from spec
  via ultracodex itself (3 stages, 22 agents, 125 tests); an independent
  fable verifier issued **ACCEPT-WITH-NOTES** against the M1 exit criterion,
  empirically confirming null-on-failure, parallel-barrier, and budget-throw
  semantics through the rebuilt product's own CLI.

## Earlier foundation work

- Product spec locked (`docs/product_context.md` v3): app-server executor
  architecture, files-as-state, journal-as-spine, no daemon, dual-runnable
  scripts, config-only routing.
- Empirical protocol pinning against codex 0.142.4: generated TypeScript
  bindings + JSON Schema from the binary (`fixtures/appserver/`), plus a live
  captured session (`probe-capture.jsonl`) confirming `turn/start` with
  `outputSchema`, `agentMessage` `phase: "final_answer"`, and per-turn token
  usage via `thread/tokenUsage/updated`.
- Model map decided from the live lineup: gpt-5.5 / gpt-5.4 / gpt-5.4-mini /
  gpt-5.3-codex-spark (efforts low–xhigh, workflow `max` → `xhigh`).
- Project scaffold: pnpm + TypeScript (NodeNext ESM), vitest, Ink 7;
  shared contracts in `src/types.ts` + `src/constants.ts`; module API
  contract in `docs/module_api.md`.

## In flight

- M1 runner core: loader, app-server client + turn state machine, runtime
  globals (agent/parallel/pipeline/phase/log/args/budget/workflow), journal +
  control channel, detached runner, fake-codex hermetic test fixture.
- M2: Ink TUI (home/run/detail/timeline), schema strictify + ajv + repair
  pipeline, budget ledgers, worktree isolation.
- M3: CLI surface, claude backend + routing, validate lint, sync-skills.

## Next

- Live end-to-end demo (`demo-doc-digest`) on real codex; `show --json`
  returns the validated result object.
- Acceptance: run the same workflow script under Claude Code's Workflow tool
  and under ultracodex; compare quality and cost.
- First real workload: `chatgpt-corpus-synthesis` over a prior session's corpus directory.

## Deliberately deferred

Resume/prefix-cache after process death, MCP adapter, worktree merge-back,
hard pause (SIGSTOP), Windows support.
