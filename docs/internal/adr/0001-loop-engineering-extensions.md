# ADR-0001: Loop-engineering extensions

**Status:** Accepted 2026-07-06 · **implementation deferred** (~1 week; after
the current workflow-improvement arc). Nothing here is started until this
ADR is picked up deliberately.

## Context

We ran a research workflow (`uc_mr9f4j558lqog`, 8 agents, cross-vendor
critique via the claude backend) over the two resources representing the
community's state of the art on "loop engineering": the *Loop Engineering
Orange Book* and the *awesome-loop-engineering* corpus. Full community map:
[docs/internal/research/loop-engineering-community-map.md](../research/loop-engineering-community-map.md).

Key findings:

- **Vocabulary split.** The community's "loop" is a full lifecycle across
  recurring runs — *trigger → discover → delegate → act → verify → persist →
  decide* — a pattern language spanning shell loops, CI, and many agent
  harnesses. ultracodex loops are convergence engines *inside one bounded
  run*. Complementary, not competing: we are the strongest
  delegate/act/verify stage in their model, and say nothing today about
  their trigger/persist/decide stages.
- **The tooling gap is "no runtime", not "no tooling".** The community
  ships taxonomies, prompts, and simple runners, but nothing with verified
  convergence, budgets that throw, schema-gated verifiers, journals, or
  live controls.
- **Community concepts worth adopting** (in our idiom): deterministic
  checks before LLM judgment ("gate-first"); the stop-class taxonomy
  *goal-met / stalled / needs-human / budget*; anti-cheat discipline
  (makers weakening their own graders); review-bandwidth limits.
- **Cross-vendor critique earned its keep:** the fable judge caught the
  Codex analysts' top recommendation — a `check(command)` host primitive —
  violating our own spec (§3.5: no script-visible extensions), plus a
  per-run-vs-cross-run cap misreading and a budget-capability nuance.

## Decision

Adopt the following, **all config-side, docs-side, or engine-side — never
script-visible** (byte-compatibility is inviolable):

1. **Verifier profile convention** *(small/high)* — documented `verifier`
   agentType: read-only sandbox, cross-vendor route for `verify:*` labels,
   required `{pass, issues, evidence}` schema, default-reject framing.
2. **Loop-policy snippets** *(small/high)* — copy-paste inline JS (scripts
   cannot import) encoding the agreed stall design:
   - progress metric: deterministic (failing tests, lint count) when the
     task has an oracle; else the verifier's schema'd score;
   - **cycle detection**: fingerprint the verifier's sorted issues; keep a
     seen-set across ALL rounds (not consecutive-sameness — catches any
     oscillation period);
   - **stall**: best-so-far + epsilon margin + patience K (absorbs judge
     noise; subsumes slow thrash);
   - **keep-best**: return the argmax-round artifact, never the last round;
   - return `stopReason ∈ {pass, cycle, stalled, budget, max-rounds}` —
     the community's stop classes in our idiom.
   Known pathology to document alongside: an unanchored verifier invents
   new requirements every round and presents as permanent stall — anchor
   verifiers to stated requirements; route them cross-vendor; note our
   per-round agents are memoryless by construction (no judge drift).
3. **Operational loop cookbook** *(medium/high)* — the community's named
   use cases as tested saved workflows: CI repair, PR babysitting, docs
   drift, flaky-test hunt, dependency triage. Doubles as the dogfooding
   sprint vehicle (they are the maintainer's real recurring tasks).
4. **Trigger adapter templates** *(medium/high)* — cron and GitHub Actions
   wrappers around `run --detach` / `run --json`; triggers stay outside
   scripts, as the spec intends. Closes the community's biggest
   "ultracodex lacks" item without touching the format.
5. **Convergence view in the TUI** *(medium)* — pure journal fold: rounds
   detected from label patterns (`*:round-N`), per-round verifier issue
   counts, repeated-issue highlighting, budget burn-down, stop reason.
   Nobody in the ecosystem visualizes convergence.
6. **awesome-loop-engineering PR** *(small-medium)* — an Agent Script
   chapter alongside their Claude Code/Codex/Cursor/OpenCode coverage
   (contributions explicitly welcomed). Highest-intent distribution channel
   available; do this only after items 1–3 exist so the chapter shows
   runnable substance.

**Deferred** (need a real use case or their own design pass): standing
loop state (`run --state <name>` as an engine flag — spec-compliant
design sketched in the research); extended ledgers (wall-clock, retries,
dollar ceilings); human approval gates (see the approvals roadmap in
[agent-script-plan.md](../agent-script-plan.md) — Phase 1 aggregator is a
prerequisite); anti-cheat worktree guards.

**Rejected:** any new injected global (`check()`, `loop()`, etc.).
Spec §3.5 and the byte-compatibility promise are the product; a script
that runs only on ultracodex is a bug, not a feature.

## Consequences

- Positioning gains a concrete claim — *"loop engineering's missing
  runtime"* — backed by runnable cookbook entries in the community's own
  vocabulary, not assertions.
- The Agent Script spec stays frozen; every addition lands in config,
  docs, CLI, or TUI. Dual-runnability is preserved by construction.
- Items 1–2 are days of work; 3–5 are the substance of the next
  implementation arc; 6 gates on them.
- Risk accepted: LLM-score-based stall detection inherits verifier noise;
  mitigations (epsilon, patience, anchoring, cross-vendor judges) are
  documented in item 2 rather than solved in the engine.

## References

- Research run: `uc_mr9f4j558lqog` (loop-research project, 2026-07-06);
  community map vendored at `docs/internal/research/loop-engineering-community-map.md`.
- Sources: alchaincyf/loop-engineering-orange-book (v260615 PDF);
  invincible04/awesome-loop-engineering (README, docs/01–10, prompts, skill).
- Related: `docs/internal/agent-script-plan.md` (M4 + approvals roadmap),
  `docs/agent-script-spec.md` §5.9 (loops), §3.5 (no script-visible
  extensions), `examples/03-builder-verifier.js`.
