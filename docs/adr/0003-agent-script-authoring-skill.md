# ADR-0003: Agent Script as a model-agnostic authoring skill (v0.3.0 program)

**Status:** Accepted 2026-07-06 · in progress (Phase A partially done).

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

- **A. Tool-description ↔ fixture diff** (must be done by the main-loop
  Claude — requires the live system-prompt Workflow description in context).
  Interim findings recorded below; REMAINING: complete the clause-by-clause
  diff, then re-capture the fixture as STRICT JSON.
- **B. Excavate past workflows.** Claude Code persists every Workflow
  invocation's script. Known cache locations:
  - `~/.claude/projects/<project-slug>/<session-id>/workflows/scripts/*.js`
    (glob across ALL projects/sessions — expect dozens)
  - `/tmp/bunny-chatgpt-pass/workflows/*.js` (9 real scripts from a prior
    session — **contain PHI context in prompts; generalize with care**)
  - this repo's session dir + `~/Desktop/repos/loop-research/`
  Inventory → categorize into shapes (fan-out/synthesize, staged build with
  gates, review→verify→fix, actor–critic loop, until-dry sweep, judge panel…).
- **C. Generalize 4–5 representative shapes** into examples: strip all
  personal specifics (PHI hard requirement), keep the problem SHAPE; write
  problem statement + the Claude reference script for each.
- **D. Authoring skill + parity test.** Update `docs/agent_script_spec.md`
  (fold in Phase A findings), distill the AUTHORING skill (distinct from the
  existing run-oriented `sync-skills` output), then: codex agents (+
  opencode if installed — check `which opencode`) get skill + problem
  statement only → author scripts → `validate --strict` → compare shape vs
  references (phases/labels/schemas/null-handling/budget rails). This is
  dogfooding/debugging for the skill text; iterate until parity.
- **E. Publishing.** Decide packaging (repo `skills/` dir + npm, gallery in
  docs, awesome-list PR per ADR-0001 item 6) once parity is proven.

## Phase A interim findings (fixture vs live tool description)

1. **`fixtures/workflow_schema.json` is NOT valid JSON** — raw control
   characters / pretty-printed prose wrapping. It cannot be machine-parsed.
   Action: re-capture as strict JSON (single-line description string), keep
   the old file until the diff completes.
2. **`script` parameter description is truncated** in the fixture: ends at
   "…using agent()/parallel()/pipeline()/phase()." — the live description
   also names `log()`.
3. Verified present and consistent so far: params (args/name/script/
   scriptPath/resumeFromRunId/title/description-ignored), budget semantics
   (output tokens, hard ceiling), caps (min(16, cores−2), 1000, 4096),
   loop-until-dry & quality patterns, Ultracode section, isolation,
   agentType, Date.now/Math.random bans, whenToUse.
4. Note: the model-tier enum (`sonnet|opus|haiku|fable`) lives on the AGENT
   tool schema, not the Workflow description — its absence from the fixture
   is not a discrepancy; but the authoring skill SHOULD document tier names
   as advisory (engines map them; ultracodex maps `fable` → strongest).
5. REMAINING: full pass over the live description for clauses the fixture
   wrapped/mangled; then regenerate the fixture verbatim-faithful.

## Constraints carried forward

- Byte-compatibility unchanged: the skill teaches the UPSTREAM format;
  nothing script-visible may be ultracodex-specific (spec §3.5).
- The existing spec (`docs/agent_script_spec.md` v0.1) is engine/implementer
  oriented; the skill is a separate, shorter, writer-oriented artifact —
  don't merge them, cross-link them.
- Related: ADR-0001 (loop patterns feed the example gallery), ADR-0002.
