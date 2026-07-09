# Controlled fleet comparison: same script, one `[route]` line apart

**Date:** 2026-07-09 · **Headline pair:** gpt-5.6-sol (codex-cli 0.144.0)
vs claude-opus-4-8 (headless `claude -p`) — each side's frontier coding
model — with claude-sonnet-5 (balanced tier) and claude-fable-5
(deliberately overkill) as additional runs. **Everything in this folder is
the experiment**: the script, all raw journals, this write-up.

## Question

Same real task, same acceptance bar, same runtime and accounting — what do
the two backends actually spend, and whose meter runs?

## Methodology

One build script ([cmp-build.js](cmp-build.js)): implement a rate-limiter
module against a frozen spec with twelve named tests → an adversarial gate
reads the code and runs the suite → a conditional fix round on gate
rejection → a mechanical verifier counts passing tests. Throwaway project
directories whose configs differ by exactly one line:

```toml
"*" = "codex"    # run A
"*" = "claude"   # run B
```

All runs went through the same ultracodex runtime with identical journal
accounting; wall time measured externally with `/usr/bin/time`. The raw
journals are in this folder: [codex-journal.jsonl](codex-journal.jsonl),
[opus-journal.jsonl](opus-journal.jsonl),
[claude-journal.jsonl](claude-journal.jsonl) (sonnet-5),
[fable-journal.jsonl](fable-journal.jsonl).

## Results

| | codex → gpt-5.6-sol (xhigh) | claude → claude-opus-4-8 | claude → claude-sonnet-5 | claude → claude-fable-5 |
|---|---|---|---|---|
| Outcome | 12/12 tests | 12/12 tests | 12/12 tests | 12/12 tests |
| Agents run | 3 — gate passed first try | 4 — one fix round | 4 — one fix round | 4 — one fix round |
| Wall time | 107 s | 219 s | 237 s | 246 s |
| Output tokens | 4.7k (2.2k of it reasoning) | 14.2k | 21.6k | 14.9k |
| Input tokens | 181.7k (124.2k cache reads) | 19.5k + 430.1k cache reads | 20.1k + 747.8k cache reads | 19.4k + 423.8k cache reads |
| Quota meter | zero Claude | all Claude | all Claude | all Claude (premium tier) |

## Reading it honestly

All four runs converged to the same acceptance. Every Claude-side run
drew one fix round from the gate while the codex run passed first try —
consistent across three Claude models, though each configuration ran
once, so it stays an observation. One confound to name: builder and gate
share a route in each run, so a strict-gate explanation and a
rough-first-draft explanation are indistinguishable in this design;
separating them is a one-line mixed-routing config (`"gate:*" = "codex"`)
and a good follow-up. Opus and Fable wrote at nearly identical output
cost (14.2k / 14.9k) with sonnet chattier (21.6k) — and the Fable column
is the experiment's thesis stated as data: the most capable model on the
board produced the same 12/12 artifact, slowest, on the priciest meter.
Capability beyond the task simply runs a more expensive meter — routing
exists so that spending it is a per-role choice. The adapters report cache
accounting differently — codex folds cache reads into input/total, the
claude adapter reports them separately — so compare per category and never
a single "total" number. The durable claim is the last row: identical
work, and only one column draws down Claude quota.

## Follow-up: crossing builder and gate (2026-07-09, same day)

The main table left a confound: builder and gate shared a route in every
run, so "Claude builders write rougher first drafts" and "Claude gates
judge more strictly" were indistinguishable. Two more runs crossed them —
`"impl:*"` routed one way, everything else the other
([cross-a-journal.jsonl](cross-a-journal.jsonl),
[cross-b-journal.jsonl](cross-b-journal.jsonl)):

| | cross-A: opus-4-8 builds, sol gates | cross-B: sol builds, opus-4-8 gates |
|---|---|---|
| Outcome | 12/12 tests | 12/12 tests |
| Gate | passed first try | passed first try |
| Wall time | 120 s | 146 s |

Both crossed configurations passed the gate first try. That weakens both
single-factor explanations at once: an opus build survived a sol gate, and
a sol build survived an opus gate. The fix rounds appeared only in the
three same-route Claude runs — which, at one run per configuration, is as
consistent with chance as with anything structural. What the follow-up
does establish: the cross-vendor configurations work, the outcome is
insensitive to who builds and who gates on this task, and mixed routing
turned the experiment itself into two config lines.

## Reproducing

```bash
mkdir -p /tmp/cmp-a/.ultracodex && cd /tmp/cmp-a
# write .ultracodex/config.toml with the route line of your choice
/usr/bin/time -p ultracodex run <this-folder>/cmp-build.js --json --budget 400k
```

Token categories come from the run's `journal.jsonl` (`agent_usage` /
`agent_end` events). Related, older measurements — the haiku-tier digest
experiment and the built-twice record — live in
[../../acceptance-comparison.md](../../acceptance-comparison.md).
