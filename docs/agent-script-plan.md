# Agent Script — post-validation roadmap (M4)

**Status:** parked until ultracodex validation completes (the clean-room
second build reaching its M1 exit criterion + acceptance). Do not start M4
work before that gate.

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

1. Promote `docs/agent_script_spec.md` v0.1 → v1.0: resolve every
   [CLARIFICATION]/[EXTENSION] flag, freeze the portable subset.
2. **Conformance corpus** — dual-run scripts (upstream Workflow tool vs
   ultracodex) asserting the semantic invariants, in CI. `cmp-doc-digest`
   is corpus entry #1.
3. Per-backend capability matrix doc (generated from descriptors).
4. Naming/positioning: the format is "Agent Script"; engine naming decision
   (keep `ultracodex` vs generalize) deferred to here. README repositioning,
   npm publish decision.

## Loop engineering (future work, decided 2026-07-03)

Loops (builder–verifier convergence) are a first-class positioning pillar —
docs, `examples/03-builder-verifier.js`, and spec §5.9 shipped with the
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
