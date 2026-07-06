# ADR-0002: Claude backend — shell-out over Agent SDK; positioned as an advanced feature

**Status:** Accepted 2026-07-06.

## Context

Two linked questions arose while planning the workflow-improvement arc:

1. Should the claude backend be built on the Claude **Agent SDK** instead of
   shelling to the user's installed `claude -p`?
2. Do we need an in-engine claude backend at all, given the product's
   primary pattern — *fable plans (parent session) → codex builds (workflow)
   → fable verifies (parent session)* — puts Claude on both sides of the
   run without any backend?

## Decision 1: shell-out (`claude -p`), not the Agent SDK

The Agent SDK's documentation directs third-party products to **API-key
authentication** — it does not permit products to offer claude.ai
login/subscription rate limits. The claude backend's purpose is judgment
**on the user's existing subscription**; `claude -p` preserves that
cleanly: ultracodex spawns the *user's own installed Claude Code* under
*their own login* — the same ambient-auth model as the codex backend
(`codex login`). We never touch Claude auth.

Secondary factors: the TS SDK bundles a native Claude Code binary
(vs. our 109 kB tarball with claude support free-if-on-PATH); shelling to
the user's binary avoids version skew with their interactive setup; and
adapter symmetry ("spawn the user's CLI, fake it in tests") is what the
M4a conformance kit is built on.

**Conceded costs** (recorded so the trade can be re-weighed): the SDK
offers streamed structured messages (richer TUI activity for
claude-routed agents — today they show one status line), typed
permissions/hooks (our `extra_args` is the stringly equivalent), and
first-class sessions (we use `--resume`).

**Revisit condition:** demand for a claude backend in **headless CI**,
where claude.ai login is unavailable and `ANTHROPIC_API_KEY` is the only
auth. For that mode the Agent SDK is the correct implementation — as a
second, config-selected adapter (`[backends.claude] auth = "subscription"
| "api-key"`), fitting the M4a capability-descriptor model. Also revisit
if the SDK slims its footprint or its auth guidance changes.

## Decision 2: keep the backend, market it as ADVANCED

The primary, documented, zero-config pattern is **parent-verify**: the
workflow runs all-codex; `run --json` returns the result into the parent
Claude session, where the model that *asked* for the work judges it with
the full original intent in context. This is the product's founding
design, and it means most users never configure routing at all.

The unifying insight (from the loop-engineering research): the community's
"outer lifecycle" stages we supposedly lack — trigger, decide, persist —
are provided by the **host Claude Code session itself**. Ultracodex builds
the inner run; Claude Code *is* the outer loop.

The claude backend remains for the three cases parent-verify cannot cover,
because the parent only sees the final result:

1. **In-run convergence judging** — per-round cross-vendor verifiers in
   builder–verifier loops (the ADR-0001 flagship; validated twice: the
   clean-room review gates and the loop-research critique that caught our
   own spec violation).
2. **Per-item gates** inside large fan-outs/pipelines.
3. **Unattended runs** (cron/CI trigger adapters) with no parent session.

Docs updated accordingly: README "Why" leads with parent-verify
("verification comes free"); the routing example ships with claude routes
commented out under an ADVANCED note; OPERATIONS matches.

## Consequences

- Product story simplifies to its original shape; new users need zero
  routing config to get the full plan→build→verify loop.
- The backend stays shipped, conformant, and config-compatible (~200 LOC
  + fake + tests); no removal churn.
- The SDK question loses urgency in proportion to the backend's demotion.
