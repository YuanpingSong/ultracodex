# Agent Script examples

One gallery, nine shapes, ordered by complexity. Every entry is a directory with a `README.md` — a self-contained **problem statement**, a **mermaid diagram** of the orchestration topology, and reference notes — plus a `workflow.js` that passes `ultracodex validate --strict` and runs unmodified on both Claude Code's Workflow tool and ultracodex.

The shapes were distilled from a census of 58 real production workflows (ADR-0003), and the problem statements double as authoring exercises: hand one, plus the [authoring skill](../skills/agent-script-authoring/SKILL.md), to any capable model and it should produce a comparable script.

## The ladder

Start at the top — the first three run in minutes with no setup and build confidence cheaply. Lower entries are reference implementations for real work; several need your own data.

| # | shape | problem it solves | runs as-is? | cost class |
|---|---|---|---|---|
| 1 | [`hello`](hello/) | one agent, one result — prove the toolchain works | yes | 1 agent, seconds |
| 2 | [`fanout-synthesize`](fanout-synthesize/) | many partial views → one artifact, adversarially checked | yes (reads this repo's docs) | ~5 agents |
| 3 | [`actor-critic-loop`](actor-critic-loop/) | one artifact iterated against an exacting critic until it passes | yes | ≤6 agents, bounded loop |
| 4 | [`research-sweep`](research-sweep/) | broad read-only investigation, parallel facets, structured findings | yes (probes your machine's disk) | ~8 agents |
| 5 | [`design-exploration`](design-exploration/) | divergent creative options via assigned lenses, merged by a rubric judge | yes (inline brief) | ~4 agents |
| 6 | [`map-over-corpus`](map-over-corpus/) | same judgment per item over a big catalog — sharded, wave-throttled, resumable, budget-aware | needs a catalog file | scales with N |
| 7 | [`review-verify-fix`](review-verify-fix/) | code review where false positives are costly: two refute-by-default skeptics gate every finding | needs a real repo | ~10+ agents |
| 8 | [`pilot-then-full`](pilot-then-full/) | prove an unproven enrichment on a stratified sample before paying for the full corpus | needs a database | pilot ~10, full scales |
| 9 | [`staged-build-gates`](staged-build-gates/) | multi-module build in dependency-ordered waves with gate agents and a contract doc as arbiter | needs a contract + skeleton | ~12+ agents |

```bash
ultracodex run examples/hello/workflow.js --watch
ultracodex run examples/fanout-synthesize/workflow.js
ultracodex run examples/actor-critic-loop/workflow.js --watch --budget 200k
```

Format reference for writers: [the authoring skill](../skills/agent-script-authoring/SKILL.md) — its shape catalog names two more shapes (verify-sweep, judge-panel) that compose from the pieces shown here. For engine implementers: [the spec](../docs/agent-script-spec.md).
