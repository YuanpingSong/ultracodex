# Agent Script — post-validation roadmap (M4)

**Status (2026-07-06):** gate cleared long since (clean-room ACCEPT-WITH-NOTES,
v0.3.0 shipped); **M4a/M4b ACTIVE as the dogfood-the-engine arc.** Decided
with the user: Claude (main loop) defines the contracts; **ultracodex runs
the build-out** — the fleet work IS the dogfooding, and every friction point
is journaled as cookbook raw material (ADR-0001 item 3 falls out for free).
- Step 1 DONE: **Executor Contract v1 drafted → `docs/executor-contract.md`**
  (interface + invariants incl. settle-don't-reject / abort-grace / usage
  monotonicity, capability descriptor + written degradation rules, schema
  discipline, fake-fidelity rule, 10-assertion conformance-kit definition).
  Contract is FROZEN for fleet purposes — gate agents use it as arbiter.
- Step 2 DONE (2026-07-06, fleet run `uc_mr9v4ql893ynu`: 11 agents, 1h15m,
  221k out tok, staged-build-gates, run under npm-installed 0.3.0):
  `src/executor/contract.ts` extracted (field-for-field vs the doc), both
  adapters declare capabilities, `createExecutors` → `{executors, warnings}`
  with a pure `executorDegradationWarnings()` (journaled as `warn` events),
  10-assertion kit at `tests/executor-kit/` green against BOTH adapters
  (338→417 tests; the 1 skip = claude #4, capability-declared). The kit
  caught three real adapter bugs: claude abort killed only the direct child
  (now process-group SIGTERM→SIGKILL escalation inside the grace window);
  both adapters validated against the strictified instead of authored schema
  (contract §4 violation); codex had no live wire-rejection fallback (now
  `turnWithWireFallback` degrades to prompt-only mid-call). Side effect:
  `runnerPidAlive` hardened for ps-less sandboxes (full-path match + child-
  handle fallback). Friction harvest (30 items) → cookbook clusters:
  (1) schema/prompt drift — the gate schema lacked a `decisions` field its
  prompt demanded, hit by every gate → rule: derive the schema FROM the
  RETURN clause; (2) shared-worktree hygiene — later gates saw earlier
  phases' diffs as out-of-scope noise, causing most of the kit-wave fix-loop
  churn → rule: gates need the CUMULATIVE allowlist, not their wave's;
  (3) codex sandbox blocks `ps` and `.git/index.lock` (no scoped restore).
  Contract v1.1 candidates (deferred, doc stays frozen): explicit
  `networkAccess` capability field (currently inferred from non-empty
  sandbox); a warning-observability channel so the kit can assert warn-once
  through the adapter itself; #4 wording (avoid-sending vs live-rejection —
  kit now proves both).
- Step 3: OpenCode probe → I freeze fixture contract → fleet builds fake +
  adapter. Step 4: recursive exit workload (mixed routing on this repo).
- Guardrails: fleet runs under the **globally installed ultracodex 0.3.0**,
  never repo dist (no self-modification races); probe-first discipline for
  opencode; contract doc frozen before any wave starts.

**Thesis.** Everything above the `Executor` interface — loader, runtime
semantics, journal, control, budget, TUI, CLI, validate, sync-skills — is
already backend-agnostic. The product's durable value is not the codex
adapter; it is (a) byte-compatibility with the workflow-script format Claude
Code users already generate, (b) the runtime/ops layer, and (c) heterogeneous
routing: one script, one journal, one budget view, with implementation on one
vendor and adversarial verification on another. Cross-vendor adversarialism
is the feature no single-vendor harness will build.

Tagline: **"fable plans, anyone executes, fable verifies."**

---

## M4a — extract the seam (mostly refactoring what exists)

Goal: turn the de facto internal `Executor` boundary into a documented plugin
interface with a conformance story. The claude backend becomes the proof the
abstraction generalizes (N=2 conforming adapters before any new code).

Deliverables:
1. **Plugin interface doc** — extract `Executor`/`ExecutorRequest`/
   `ExecutorContext`/`ExecutorResult` from `src/types.ts` into a documented,
   versioned contract (spec §9). Adapter authors implement one class.
2. **Capability descriptor** — adapters declare:
   ```
   { schema: "wire" | "prompt-only",
     resume: boolean,            // continuation turns for schema repair
     interrupt: "graceful" | "kill-only",
     usage: "per-turn" | "final" | "none",
     activity: boolean,          // streamed events for the TUI
     sandbox: string[] }         // supported profiles
   ```
   plus the engine's written **degradation rules** per capability (e.g.
   `schema: prompt-only` ⇒ prompt-contract + ajv + repair; `resume: false`
   ⇒ fresh-call repair embedding errors; `usage: none` ⇒ budget counts 0 and
   `--budget` warns).
3. **Conformance kit** — productize the fake-fixture pattern: a shared test
   suite that runs against any `Executor` (text call, schema call incl.
   optional-properties and map-style fallback, repair loop, abort, usage
   ticks, mid-turn crash), and the requirement that every adapter ships a
   scriptable fake of its harness. Fake-fidelity rule (learned live
   2026-07-02, `invalid_json_schema`): every rejection class of the live API
   that the adapter relies on MUST be mirrored in its fake.
4. Refactor codex + claude adapters to declare capabilities and pass the kit.

Exit criterion: both existing backends pass the conformance kit; a third
adapter could be written from docs alone without reading engine source.

## M4b — one OSS adapter: OpenCode

Driven by a real workload, not speculation. One adapter only — two vendors
plus one OSS/local-model path forces the interface honest; more is redundancy
until demand shows up.

Why OpenCode: client/server architecture with a real API, provider-agnostic
including local models via Ollama — covers the "fully open, no vendor" story
in a single adapter. (Goose is the fallback candidate; aider exercises only
the degraded path and can wait.)

Known shape going in:
- `schema: "prompt-only"` — no structured output support; the engine's
  prompt-contract + ajv + repair path carries it (already proven on the
  claude backend and on codex's map-style fallback).
- Verify empirically at build time (same discipline as codex): headless/server
  protocol, session continuation (determines repair quality), usage
  reporting, interrupt story. Probe first, capture fixtures, build the fake,
  then write the adapter.
- Rate/latency expectations differ for local models; budget caps and
  schema-retry caps bound the prompt-only tax.

Exit criterion: a real mixed-routing workload (e.g. corpus synthesis or a
repo review) runs ONE script with `impl:* → opencode(local)`, `gate:* →
codex`, `review:* → claude`, green in one journal; the OpenCode fake passes
the conformance kit.

## M4c — rebrand the format: "Agent Script"

> **v0.3.0 program: see [ADR-0003](adr/0003-agent-script-authoring-skill.md)**
> — M4c matured into a model-agnostic AUTHORING skill + example gallery +
> cross-model parity testing (accepted 2026-07-06, in progress).

1. Promote `docs/agent-script-spec.md` v0.1 → v1.0: resolve every
   [CLARIFICATION]/[EXTENSION] flag, freeze the portable subset.
2. **Conformance corpus** — dual-run scripts (upstream Workflow tool vs
   ultracodex) asserting the semantic invariants, in CI. `cmp-doc-digest`
   is corpus entry #1.
3. Per-backend capability matrix doc (generated from descriptors).
4. Naming/positioning: the format is "Agent Script"; engine naming decision
   (keep `ultracodex` vs generalize) deferred to here. README repositioning,
   npm publish decision.

## Loop engineering (future work, decided 2026-07-03; superseded by ADR-0001)

> **See [docs/internal/adr/0001-loop-engineering-extensions.md](adr/0001-loop-engineering-extensions.md)**
> — the accepted, research-backed plan (2026-07-06). The two items below are
> retained inside it.

Loops (builder–verifier convergence) are a first-class positioning pillar —
docs, `examples/03-builder-verifier.js` (now `examples/actor-critic-loop/`), and spec §5.9 shipped with the
publish pass. Two follow-ups are deliberately deferred:

1. **Packaged loop workflows.** Ship builder–verifier (and until-dry) as
   saved workflows invocable via `workflow('builder-verifier', {requirements,
   maxRounds})` — a byte-compatible "loop library" using the existing
   `workflow()` global; no new script primitives (adding a `loop()` global
   would break dual-runnability and is permanently out of scope).
2. **Loop-aware observability** (engine-side EXTENSION — never touches the
   script surface). Today an N-round loop renders as N sequential agents;
   convergence is invisible. Add journal/TUI awareness: group iterations
   (e.g. by repeated label prefixes like `build:round-N`), show a verdict
   trend / "converged after 3 rounds" in the run view and `show`, and expose
   per-round token cost so loop tuning is data-driven.

## Approvals roadmap (decided 2026-07-06)

Today: `approvalPolicy: "never"` — anything outside the sandbox is
auto-denied, and the app-server client denies any server→client approval
request as a backstop. This stays the shipping default.

**Phase 1 — approval aggregator (minimal risk, ship first).** Surface
instead of decide: a config knob (`approval_policy = "on-request"`) makes
the runner forward codex approval requests into the journal as
`approval_request` events; the TUI shows a pending-approvals pane
(approve/deny keys) and the CLI gains `ultracodex approvals <ref>` /
`approve <ref> <id>`, answered over the control channel. Unanswered
requests **default-deny on a timeout**. Every decision is journaled with
the full request payload — the audit trail is the feature. Value framing:
a request aggregator across a whole fleet, something neither CLI offers.

**Phase 2 — judged auto-approval (careful security engineering, later).**
A cheap fast model classifies each surfaced request against a per-project
policy. Non-negotiables before this ships: default-deny on any judge
error/timeout/ambiguity; the judge is a different model/backend from the
requesting agent; policy lives in config (reviewable, versioned); every
decision + rationale journaled; per-run approval budget caps; and an
explicit allowlist floor (patterns the judge may approve — everything
else escalates to Phase-1 human flow). Pairs with, but is strictly
separate from, the sandbox ladder: approvals govern *escalations*, the
sandbox governs the *floor*.

## Discipline / non-goals

- Upstream Claude Code remains the **reference implementation**; ambiguities
  resolve in upstream's favor; we track `fixtures/workflow_schema.json`
  snapshots. Byte-compatibility direction: upstream-runnable ⇒
  ultracodex-runnable unconditionally; the reverse requires
  `validate --strict` (the portable subset).
- Anything we add must be config-side, never script-side, or the
  compatibility promise erodes.
- No speculative adapters beyond OpenCode; no MCP server (unchanged re-entry
  condition: a shell-less host that matters); no marketplace/registry ideas
  until the spec is v1.0.

## Risks

- Upstream format evolution → snapshot tracking + corpus catches drift.
- OpenCode API stability → pin version, generated fixtures, isolated adapter.
- Prompt-only schema tax on weak local models → bounded by retry cap +
  budget; capability matrix sets expectations.
