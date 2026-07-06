# Adversarial codebase review with two-skeptic verification

**Shape:** parallel fan-out → in-script dedupe → per-finding two-verifier unanimous gate → conditional single fixer

## Problem

I have a working codebase — typecheck, tests, and build are all green — and I want a real defect hunt across it, along five distinct dimensions: core logic correctness, error and failure paths, public API contract adherence, documentation drift, and test-suite quality (tests that pass without protecting anything). Each dimension takes a different kind of reading; a single reviewer asked to cover all five skims all of them.

The binding constraint is precision, not recall. LLM reviewers overcall: they report documented, intended behavior as bugs, invent call sequences no real caller can produce, and rediscover the same defect in different words across reviewers. The surviving findings will be handed to an agent with write access to my repo, so a false positive is not just noise — it becomes a plausible-looking "fix" for a bug that does not exist. My policy is therefore: no finding may be fixed unless it has been independently verified by two separate skeptics using different strategies — one that tries to actually reproduce or trace the failure, one that checks the claim against what the project actually documents and promises — and both must start from "this is refuted" and be convinced otherwise by evidence. Anything either skeptic refutes is dropped, and I want the refutation reasons in the final report.

Duplicate findings must be collapsed before verification so I do not pay to verify the same claim twice. Fixing must be conservative: minimal surgical changes, a regression test per fix where feasible, and the project's typecheck, tests, and build must all be green afterwards — never achieved by weakening or deleting existing tests. Nothing gets committed. If nothing survives verification, the repo must not be touched at all. The repo path and its check commands should be run parameters, not hardcoded.

## Reference solution

The shape is a three-phase trust pipeline: **wide, then skeptical, then narrow**. Recall is bought cheaply up front with a parallel fan-out; precision is bought in the middle with an adversarial gate; write access is granted only at the end, to a single agent, under a hard invariant.

- **Review** — five dimension reviewers run in one `parallel()` call, each getting the same shared context prelude (`CTX`) plus a dimension-specific hunt list, and each returning findings through a shared `FINDINGS_SCHEMA` (file, line, title, concrete scenario, severity enum). A crashed or schema-exhausted reviewer resolves `null`; the `.then((r) => r ? … : [])` inside each thunk plus `.filter(Boolean).flat()` after the barrier turn that into an empty contribution rather than a failed run.
- **Dedupe** — plain JavaScript between phases: a `Map` keyed on `file + normalized-title-prefix` collapses reviewers rediscovering the same defect in different words. No agent is spent on this, and `log()` narrates the before/after counts so nothing is silently dropped.
- **Verify** — a nested fan-out: for each deduped finding, an inner `parallel()` launches two verifiers with different lenses — REPRODUCE (run a minimal repro or trace the exact triggering call path) and CONTRACT (check the claim against what the project documents and promises). Both prompts open with *your DEFAULT verdict is refuted=true*, which is the calibration that makes the gate work: the asymmetric cost (a false positive reaching the fixer is worse than a dropped maybe) is stated to the model outright. Both verifiers carry `effort: 'high'` — this gate decides the precision of the whole run, so it gets the strongest reasoning tier. Confirmation is unanimous and fail-closed: `vs.filter(Boolean).filter((v) => !v.refuted).length === 2`, so a verifier that fails (`null`) blocks the finding instead of waving it through.
- **Fix** — conditional: if zero findings survive, the body `return`s early and no agent with write intent ever starts. Otherwise a single fixer receives the confirmed findings *with the verifiers' evidence attached*, fixes them smallest-change-first with regression tests, and must finish with the project's typecheck, tests, and build all green — explicitly forbidden from weakening existing tests to get there — reporting through a schema with per-check booleans (`typecheckOk`, `testsOk`, `buildOk`).

> **Isolation sidebar.** This example runs exactly **one** fixer, so it works directly in the target repo's working tree — there is nothing to race. If you scale the Fix phase to multiple fixers mutating files in parallel (say, one fixer per confirmed finding), give each of them `isolation: 'worktree'`: every fixer then operates in its own fresh detached git worktree instead of trampling the others' edits, and the engine removes any worktree left pristine while keeping (and reporting) the ones with changes. A single fixer does not need it.

The final result is a full audit trail: confirmed findings with severities, rejected findings with the skeptics' refutation reasons joined together, and the fixer's structured report.

## Techniques

- Dimension-sharded parallel fan-out: one shared context prelude + per-dimension hunt lists, one `parallel()` call
- Schema-constrained findings with a severity enum and required concrete failure scenarios
- `.filter(Boolean)` degradation after `parallel()` — a failed reviewer contributes nothing instead of failing the run
- Cheap-key dedup in plain JS between phases (`Map` keyed on file + normalized title prefix), with narrated counts
- Two-skeptic unanimous verification gate via nested `parallel()` per finding
- Refuted-by-default prompt framing — stating the asymmetric error cost to calibrate adversarial verifiers
- Fail-closed `null` handling: a crashed verifier blocks confirmation rather than passing it
- `effort: 'high'` reserved for the precision-critical tier of the pipeline
- Conditional phase via early `return` — no write-capable agent starts when nothing is confirmed
- Green-suite invariant on the fixer: fix fallout, never weaken tests, report per-check booleans
- No-silent-caps `log()` narration at every funnel stage (raw → deduped → confirmed)
- Args-driven target: repo path and check commands as run inputs, not hardcoded paths
