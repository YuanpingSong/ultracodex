# Contributing

## Setup

```bash
pnpm install
pnpm typecheck && pnpm build && pnpm test
```

The whole suite is **hermetic**: it runs against `tests/fake-codex/codex`, a
scriptable fake of the codex app-server (behavior directives like
`[[reply:...]]`, `[[slow:ms]]`, `[[usage:in,out]]` are embedded in prompts).
No API keys needed. Please keep it that way:

- **Fake fidelity is a spec concern.** If your change depends on a live-API
  behavior (especially a rejection class — e.g. OpenAI strict-schema 400s),
  mirror that behavior in the fake and add a regression test. Bugs that only
  reproduce live are bugs the suite can't protect.
- Live verification against real codex is encouraged before merging executor
  changes (`node dist/cli.js run examples/01-hello.js --watch`), but must
  never be required by CI.

## Ground rules

- **Upstream compatibility is the product.** Behavior of the script surface
  (the seven globals, null-vs-throw semantics, caps) must match the upstream
  Workflow tool; `docs/agent_script_spec.md` is the contract and
  `fixtures/workflow_schema.json` is the upstream snapshot. Anything we add
  must be config-side, never script-visible.
- `docs/module_api.md` defines internal module contracts — change the doc
  and the code together.
- ESM + NodeNext: relative imports carry `.js` suffixes.
- Never weaken a test to make it pass.

## Layout

- `src/` — loader, runtime, executors (`codex`, `claude`), journal/control,
  runner, CLI, Ink TUI.
- `tests/` — vitest suite + the fake-codex fixture.
- `fixtures/appserver/` — generated protocol types + a real (scrubbed) wire
  capture from codex 0.142.4; regenerate with
  `codex app-server generate-ts --out fixtures/appserver/ts`.
- `docs/` — spec, architecture, operations, roadmap.
