# Agent Script examples

Two collections live here.

## Quickstart scripts

Small, runnable demos — start here to see the engine work:

| script | shows |
|---|---|
| [`01-hello.js`](01-hello.js) | one agent, streamed events |
| [`02-fanout-critique.js`](02-fanout-critique.js) | fan-out + schemas |
| [`03-builder-verifier.js`](03-builder-verifier.js) | the convergence loop (spec §5.9) |

```bash
ultracodex run examples/01-hello.js --watch
```

## Shape gallery

Each directory is one orchestration **shape**, distilled from a census of 58
real production workflow scripts (ADR-0003). Every entry has a `README.md`
— whose **Problem** section is a self-contained exercise: hand it, plus the
[authoring skill](../skills/agent-script-authoring/SKILL.md), to any capable
model and it should produce a comparable script — and a reference
`workflow.js` that passes `ultracodex validate --strict`.

| shape | problem it solves |
|---|---|
| [`research-sweep`](research-sweep/) | broad read-only investigation, parallel facets, structured findings |
| [`map-over-corpus`](map-over-corpus/) | same judgment per item over a big catalog — sharded, wave-throttled, resumable, budget-aware |
| [`pilot-then-full`](pilot-then-full/) | prove an unproven enrichment on a stratified sample before paying for the full corpus |
| [`review-verify-fix`](review-verify-fix/) | code review where false positives are costly: two refute-by-default skeptics gate every finding |
| [`verify-sweep`](review-verify-fix/README.md) | (covered as a variant in review-verify-fix: pure QA with no fix stage) |
| [`staged-build-gates`](staged-build-gates/) | multi-module build in dependency-ordered waves with gate agents and a contract doc as arbiter |
| [`design-exploration`](design-exploration/) | divergent creative options via assigned lenses, merged by a rubric judge |
| [`actor-critic-loop`](actor-critic-loop/) | one artifact iterated against an exacting critic until it passes |

The scripts are engine-portable: they run unmodified on Claude Code's
Workflow tool and on ultracodex. Format reference for writers:
[the authoring skill](../skills/agent-script-authoring/SKILL.md); for
engine implementers: [the spec](../docs/agent_script_spec.md).
