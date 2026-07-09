# Controlled fleet comparison: same script, one `[route]` line apart

**Date:** 2026-07-09 · **Models:** gpt-5.6-sol (codex-cli 0.144.0) vs
claude-sonnet-5 (headless `claude -p`) · **Everything in this folder is the
experiment**: the script, both raw journals, this write-up.

## Question

Same real task, same acceptance bar, same runtime and accounting — what do
the two backends actually spend, and whose meter runs?

## Methodology

One build script ([cmp-build.js](cmp-build.js)): implement a rate-limiter
module against a frozen spec with twelve named tests → an adversarial gate
reads the code and runs the suite → a conditional fix round on gate
rejection → a mechanical verifier counts passing tests. Two throwaway
project directories whose configs differ by exactly one line:

```toml
"*" = "codex"    # run A
"*" = "claude"   # run B
```

Both runs went through the same ultracodex runtime with identical journal
accounting; wall time measured externally with `/usr/bin/time`. The raw
journals are in this folder: [codex-journal.jsonl](codex-journal.jsonl),
[claude-journal.jsonl](claude-journal.jsonl).

## Results

| | route → codex (gpt-5.6-sol, xhigh) | route → claude (claude-sonnet-5) |
|---|---|---|
| Outcome | 12/12 tests | 12/12 tests |
| Agents run | 3 — gate passed first try | 4 — gate ordered one fix round |
| Wall time | 107 s | 237 s |
| Output tokens | 4.7k (2.2k of it reasoning) | 21.6k |
| Input tokens | 181.7k, of which 124.2k cache reads | 20.1k, plus 747.8k cache reads |
| Quota meter | zero Claude | all Claude |

## Reading it honestly

Both sides converged to the same acceptance. The Claude side's extra agent
is the gate doing its job on round one; with one run per side, the
gate-round difference is an observation rather than a finding, and most of
the wall-time gap is that extra agent. The adapters report cache
accounting differently — codex folds cache reads into input/total, the
claude adapter reports them separately — so compare per category and never
a single "total" number. The durable claim is the last row: identical
work, and only one column draws down Claude quota.

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
