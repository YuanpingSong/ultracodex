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
