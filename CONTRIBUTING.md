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

## Releasing

Before any release:

```bash
pnpm release:check
```

Builds, runs the full hermetic suite, then runs the demo-video task — a live
haiku actor–critic loop — through the real CLI against real codex, asserting
the run's **intermediate state** (journal agent events with resolved models,
per-agent prompt/output artifacts, schema'd critique outputs, token ledger),
not just the final JSON. The whole run is archived under `.release-checks/`
as provenance for that release. Requires an authenticated codex CLI and
costs a few cents — deliberately not in CI (`RELEASE_CHECK_FAST=1` uses
spark·medium while iterating; the real gate runs shipping defaults).

The full ship sequence is one command:

```bash
pnpm release <patch|minor|major>
```

— gate, version bump + tag, push (the tag triggers the publish workflow,
which releases to npm via trusted publishing with provenance), GitHub
release with generated notes, then polls the registry to confirm the
publish landed.

## Ground rules

- **Upstream compatibility is the product.** Behavior of the script surface
  (the seven globals, null-vs-throw semantics, caps) must match the upstream
  Workflow tool; `docs/agent-script-spec.md` is the contract and
  `fixtures/workflow_schema.json` is the upstream snapshot. Anything we add
  must be config-side, never script-visible.
- `docs/internal/module_api.md` defines internal module contracts — change the doc
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
