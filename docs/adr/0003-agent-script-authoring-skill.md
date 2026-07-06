# ADR-0003: Agent Script as a model-agnostic authoring skill (v0.3.0 program)

**Status:** Accepted 2026-07-06 · in progress (Phase A DONE 2026-07-06; B running).

## Decision

Agent Script is natively understood by Claude Code's Workflow tool, but it is
**not inherently coupled to Claude** — GPT, open-source models, any capable
agent should be able to author compatible scripts. v0.3.0 therefore ships the
format as an **independent artifact whose audience is agents that need to
WRITE these scripts**:

1. A self-contained **authoring skill/plugin** (spec distilled for script
   *writers*, not engine implementers), usable by any model given the text.
2. A gallery of **realistic examples** derived from actual Claude-authored
   workflows (problem statement + reference script per shape).
3. `ultracodex validate --strict` as the conformance checker in the loop.
4. **Education is part of the product's duty**: show users what workflows
   can do and put authoring in their hands easily.

Acceptance bar: **cross-model authoring parity** — given only the skill +
problem statement, Codex agents (and OpenCode agents if available) must
author scripts comparable to the Claude-authored references. Significant
deviations = the skill text needs strengthening, not the models.

## The phase program

- **A. Tool-description ↔ fixture diff** — DONE 2026-07-06 (main-loop
  Claude, live system-prompt description in context). Findings below;
  fixture re-captured as strict JSON.
- **B. Excavate past workflows.** DONE 2026-07-06. Claude Code persists
  every Workflow invocation's script under its session caches; a census
  workflow (58 unique scripts, one classifier per script → taxonomy
  synthesis → adversarial critic, corrections applied) grouped the corpus
  into 10 shape families: map-over-corpus/sharded-batch (15),
  review-verify-fix (8; two subshapes: audit-existing vs
  implement-verify-fix), research-sweep (8), fanout-synthesize incl.
  pilot-then-full (7), map-over-repos with in-worker gates (6),
  verify-sweep (5), staged-build-with-gates (5),
  design-exploration/diverge-then-judge (2), plan-critique-revise (1),
  judge-panel (1). Six representatives nominated — one per major family,
  all from non-sensitive sources, critic-verified disjoint.
  **Coverage gaps** (nothing in the corpus exercises these — the gallery
  must fold them in deliberately): budget rails, workflow() nesting,
  script-level until-dry/actor-critic convergence loops (the repo fixture
  `scripts/fixtures/haiku-actor-critic.js` is the one true loop exemplar),
  engine resume (scripts approximate it via args offsets instead);
  isolation/effort/agentType appear but sparsely.
  The full census (which cites private source paths) is deliberately a
  local session artifact, not a repo file; any privately-sourced example
  ships only after full de-identification (hard requirement).
- **C. Generalize 4–5 representative shapes** into examples: strip all
  personal specifics (PHI hard requirement), keep the problem SHAPE; write
  problem statement + the Claude reference script for each.
- **D. Authoring skill + parity test.** Skill shipped:
  `skills/agent-script-authoring/SKILL.md` (self-contained, writer-oriented,
  distilled from the live tool description by the main loop). **Round 1
  (2026-07-06):** codex (gpt-5.5) and opencode (default model:
  google/gemma-4-31b-it, 31B open-weights) each authored all 7 gallery
  problems from skill + problem statement alone; opus judges compared
  against the Claude references.
  - **codex: PARITY ACHIEVED** — 7/7 comparable-or-stronger (1 stronger),
    mean 8.8/10, every script `validate --strict` clean. Deviations were
    uniformly *supersets* of the reference topology (extra verifiers,
    budget rails, checkpointing) — over-building, never under-delivering.
  - **opencode/gemma-31B: not yet** — 5 weaker (6–6.5) + 2 parse failures,
    mean ≈5.5. Misses clustered into five SKILL-ADDRESSABLE gaps (nested
    fan-out closer punctuation; validate-first framing; parallel-fixers-
    need-isolation; fan-out-may-end-at-fan-out; resume-tuple emission +
    slice-scoped coverage) — all of which codex got right from the same
    text, proving them learnable. (Bookkeeping note: one judge mis-filled
    its `tool` field, making the synthesis report a phantom third tool;
    the corrected opencode line is 5 weaker + 2 failed of 7.)
  - **Strengthening round applied** to SKILL.md (5 must + 6 should + 4
    altitude edits): multi-line closer template + paren checklist item,
    validate-as-item-0, isolation hard rule, raw-fan-out rule, resume
    tuple/slice math, closed-set enums, terminal-producer strictest
    schema, real newlines, id-keyed joins, call-budget accounting,
    effort↔budget-rail link, phase granularity, try/catch policy,
    cross-iteration null guard.
  - **Round 2 (2026-07-06, strengthened skill, opencode/gemma-31B):
    PARITY ACHIEVED** — 6/7 comparable-or-stronger (5 comparable, 1
    stronger, 1 weaker at 7/10), zero parse failures, mean 8.36 (from
    5.5), all 7 improved. Every targeted round-1 failure class closed:
    id-keyed joins, real newlines, closed enums, strict terminal schemas,
    no-silent-drops accounting, the illegal synthesizer dropped, fixers
    serialized. The lone weaker verdict traces to a single defect (boolean
    where the reference used a 4-way enum on the headline dimension) —
    final text edits applied (headline-dimension enum rule, pilot
    three-way membership, index-range-shard pattern). Confirmatory round 3
    judged non-blocking; skipped. deepseek/others held in reserve as
    additional data points if wanted.
  - **Documented floor:** frontier models (gpt-5.5) reach parity from the
    skill alone, first try; a 31B-class open model reaches parity after
    one evidence-driven strengthening round. This is the acceptance bar
    met, with the corollary the Decision predicted: deviations were skill
    -text deficiencies, not model deficiencies.
  - Full reports: local session artifacts (`/tmp/parity-result.json`,
    `/tmp/parity-r2-result.json`); authored scripts under
    `/tmp/parity-test*/`.
- **E. Publishing.** Parity proven; plan drafted 2026-07-06 (execution
  items marked [go] are done, the rest await user go-ahead):
  1. [go] npm tarball carries the artifacts: `skills/` added to
     package.json `files` (examples/, spec, README already shipped).
  2. Claude Code distribution: extend `sync-skills` to also install
     `agent-script-authoring` into the user's skills dir, and/or package
     the repo as a Claude Code plugin — v0.3.x feature work.
  3. README: a "Write your own workflows" section linking skill + gallery
     and citing the parity evidence (codex 7/7 first try; gemma-31B 6/7
     after one strengthening round; zero parse failures final).
  4. Education/announcement (user's call on venue): short write-up of the
     parity experiment as the story — "a model-agnostic authoring standard
     any capable model can learn from one document" — candidates: repo
     docs page, Show HN follow-up, r/LocalLLaMA (the open-model angle is
     the hook), awesome-loop-engineering PR (ADR-0001 item 6).
  5. Spec stays v0.1-draft until the portable subset freezes; the SKILL is
     the user-facing artifact, spec the implementer artifact.
  6. Ship vehicle: v0.3.0 (`pnpm release minor`) once the remaining M4
     items land; skill+gallery are already live on GitHub main meanwhile.

## Phase A final findings (fixture vs live tool description) — 2026-07-06

Method: transcribed the live description verbatim from a Fable 5 session's
system prompt, rebuilt the fixture as strict JSON, then whitespace-normalized
diff of old vs new. The old (2026-07-02) capture and the new transcription
are two independent captures; they agreed character-for-character except at
one point, which validates BOTH (any transcription typo would have surfaced
as an extra divergence).

1. **Fixed: fixture was not valid JSON** — the 2026-07-02 capture had raw
   newlines/indentation inserted inside JSON strings (pretty-print
   wrapping). Re-captured 2026-07-06 as strict JSON (18,780-char
   description, `JSON.parse`-clean, round-trip-verified). Old capture
   retrievable from git history.
2. **The one real content drift** (upstream edit between 2026-07-02 and
   2026-07-06): the `args` PARAMETER description tail shortened from
   "(e.g. a research question, target path, or config object)" to
   "(e.g. a research question)". The longer phrasing survives in the
   description body's `args` global bullet. No behavioral meaning.
3. **Interim finding #2 ("script param truncated, missing log()") was
   WRONG** — both captures end the `script` param at
   "…agent()/parallel()/pipeline()/phase()." verbatim. The `log()` mention
   is in the description body's meta-example comment ("// script body starts
   here — use agent()/parallel()/pipeline()/phase()/log()"), present in
   both. The two contexts were conflated.
4. Everything else verified consistent: all 7 params (args/description-
   ignored/name/resumeFromRunId `^wf_[a-z0-9-]{6,}$`/script maxLength
   524288/scriptPath/title), budget semantics (output tokens, hard ceiling,
   shared pool), caps (min(16, cores−2), 1000 lifetime, 4096 per call),
   agent opts incl. effort enum ('low'|'medium'|'high'|'xhigh'|'max'),
   isolation, agentType, workflow() nesting (one level), Ultracode section,
   all quality patterns, Date.now/Math.random/new Date() bans, Resume
   section, plain-JS-not-TS.
5. Standing note: the model-tier enum (`sonnet|opus|haiku|fable`) lives on
   the AGENT tool schema, not the Workflow description — the authoring
   skill SHOULD document tier names as advisory strings (engines map them;
   ultracodex maps `fable` → strongest configured codex model).
6. Capture provenance: 2026-07-06, Fable 5 session (claude-fable-5).
   Upstream evidently edits this description over time (finding 2), so the
   fixture records a dated snapshot; re-verify before each spec version
   bump.

## Constraints carried forward

- Byte-compatibility unchanged: the skill teaches the UPSTREAM format;
  nothing script-visible may be ultracodex-specific (spec §3.5).
- The existing spec (`docs/agent_script_spec.md` v0.1) is engine/implementer
  oriented; the skill is a separate, shorter, writer-oriented artifact —
  don't merge them, cross-link them.
- Related: ADR-0001 (loop patterns feed the example gallery), ADR-0002.
