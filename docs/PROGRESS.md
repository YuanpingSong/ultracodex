# ultracodex progress

Status as of 2026-07-02.

## Done

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
- First real workload: `chatgpt-corpus-synthesis` over /tmp/corpus-dir.

## Deliberately deferred

Resume/prefix-cache after process death, MCP adapter, worktree merge-back,
hard pause (SIGSTOP), Windows support.
