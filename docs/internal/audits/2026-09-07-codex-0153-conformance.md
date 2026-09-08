# codex 0.153.4 app-server conformance check (2026-09-07)

Context: repo was tested/pinned against codex 0.144.0 (docs said 0.142.4); the
installed binary is now **0.153.4**. Checked whether the newer binary breaks the
app-server protocol ultracodex codes against, before bumping `TESTED_CODEX_VERSION`.

## Method
Generated the current protocol schema from the installed binary
(`codex app-server generate-json-schema --experimental --out <dir>`) and compared
against the checked-in fixtures (`fixtures/appserver/schema/`), plus checked every
protocol surface ultracodex depends on.

## Result: no breaking change to depended-on surfaces
All present in 0.153.4: `turn/start`, `turn/completed`, `turn/interrupt`,
`thread/start`, `outputSchema`, `final_answer` (agentMessage phase), `tokenUsage`,
`requiresOpenaiAuth`. The aggregate v2 schema grew ~462KB → ~706KB, but the growth
is **additive** — new optional features (`ApprovalsReviewer`/`auto_review`, granular
`AskForApproval`, etc.), not removal/rename of what we use. Consistent with the
prior audit's F8 (no confirmed break vs official docs).

## Notable: sharpens F5 (approval-reply shape)
0.153.4 approval-decision enums are `allow` / `cancel` / `decline` / `deny` — the
value ultracodex hardcodes (`{decision:"denied"}`, `src/appserver/client.ts:194`) is
**not** among them. Feeds the #6 protocol-hardening ticket: dispatch contract-valid
responses per request method.

## Action taken
Bumped `TESTED_CODEX_VERSION` 0.144.0 → 0.153.4 and refreshed user-facing version
mentions (docs/operations.md, README prerequisites/caveat). No protocol-layer code
change required. The generated 0.153.4 schema bundle is available for refreshing
`fixtures/appserver/` if/when the #6 approval fix needs the exact new response types.
