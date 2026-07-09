# Acceptance: ultracode vs ultracodex

The acceptance bar: run the **same workflow script** under Claude Code's Workflow
tool (ultracode) and under ultracodex, and get comparable-or-better results from
ultracodex — while spending Codex/OpenAI tokens instead of Claude quota.

## Test: `cmp-doc-digest` (3-phase, 5 agents)

Identical script both sides: three parallel doc summarizers (schema'd) →
one synthesizer → one adversarial critic (schema'd). Agents pinned to the
`haiku` tier (upstream: Claude Haiku; ultracodex: mapped to `gpt-5.4-mini`).

| | ultracode (Workflow tool) | ultracodex (codex app-server) |
|---|---|---|
| Result shape | valid, schema-conformant | valid, schema-conformant |
| Agents ok | 5/5 | 5/5 |
| Wall time | ~18 s | ~3 min |
| Tokens | ~58k Claude | ~82k Codex (1.6k output); **0 Claude** |
| Critic verdict | `accurate: true`, 0 issues | `accurate: false`, 2 grounded issues |

**Quality:** ultracodex's critic was the more rigorous of the two — it caught
that the synthesis overstated project maturity ("working loader/runtime",
"beyond prototype") relative to what `PROGRESS.md` actually claims, and flagged
both as unsupported inferences. The upstream Haiku critic passed the same
synthesis with no issues. Same script, same tier, and the Codex-backed run was
at least as discerning.

**Speed:** ultracode wins on latency. Each ultracodex agent spins up its own
`codex app-server` and runs a full turn, which carries real per-agent startup +
turn latency; upstream subagents are lighter-weight. This is the expected
trade-off and is acceptable for the "fable plans, codex executes, fable
verifies" pattern where the point is to move execution *off* Claude quota.

**Cost (the actual goal):** the ultracodex run consumed zero Claude tokens —
all 82k tokens were Codex's, metered per-turn via `thread/tokenUsage/updated`
and surfaced in the journal totals. That is the conservation win the project
exists for.

## Verdict

Dual-runnability holds: the byte-identical script produced a valid, equal-or-
better result on ultracodex while spending no Claude quota. Latency is higher,
which is the intended cost of offloading execution to Codex.

## Provenance and re-verification (2026-07-09)

- The Claude-side run record survives in the driving session's workflow
  archive: totalTokens 57,638 and a longest-agent duration of 17.9 s —
  both match the table above.
- The original ultracodex run directory was removed in a later state-dir
  cleanup; its column stands as recorded on 2026-07-03.
- Fresh re-run of the same script on the current stack (codex-cli 0.144.0,
  gpt-5.6-sol, docs paths refreshed): 5/5 agents ok, wall time 58 s,
  ~180k Codex total tokens (2.9k output), zero Claude quota. Faster and
  chattier than the 2026-07-03 run; the trade shape is unchanged.

## The build head-to-head: this project, built twice

Same acceptance bar (the M1 exit criterion), two fleets:

| | original build (Claude Workflow tool) | clean-room rebuild (ultracodex → Codex) |
|---|---|---|
| Fleet | 13 agents (build) + 78 agents (review/fix pass) | 9 runs, 42 agents |
| Output tokens | 1.16M (build) + 3.43M (review) = 4.59M **Claude quota** | 0.33M **Codex; 0 Claude** |
| Verification | 27 dual-verified findings fixed in-pass | independent verifier: ACCEPT, 125/125 tests |
| Records | session workflow archive (wf_efbbed06, wf_abd86d99) | the-second-ultracodex/.ultracodex/runs |

These two columns are NOT comparable, and the README cites them only
qualitatively. Three confounds stack in the same direction: the rebuild
implemented a frozen written spec (re-implementing is cheaper than
designing); the original's 78-agent review pass has no rebuild
equivalent (its verifier ran outside the counted fleet); and the models'
output styles differ (thinking-heavy frontier output vs terse
implementation output), so output-token counts measure verbosity as much
as work. For comparable numbers, see the controlled comparison below —
same script, same runtime, same accounting, one [route] line changed.

## Controlled comparison (2026-07-09): same script, one [route] line apart

Methodology: one build script (implement a rate-limiter module against a
frozen 12-test spec → adversarial gate → conditional fix → mechanical
verify), two throwaway projects whose configs differ by exactly one line
(`"*" = "codex"` vs `"*" = "claude"`), both runs through the same
ultracodex runtime with identical journal accounting, wall-clock timed
externally. Script and both journals preserved at
docs/internal/research/cmp-build/.

| | route → codex (gpt-5.6-sol, xhigh) | route → claude (claude-sonnet-5) |
|---|---|---|
| Outcome | 12/12 tests | 12/12 tests |
| Agents run | 3 — gate passed first try | 4 — gate ordered one fix round |
| Wall time | 107 s | 237 s |
| Output tokens | 4.7k (2.2k of it reasoning) | 21.6k |
| Input tokens | 181.7k, of which 124.2k cache reads | 20.1k, plus 747.8k cache reads |
| Quota meter | zero Claude | all Claude |

Reading the table honestly: both sides converged to the same acceptance;
the extra Claude-side agent is the gate doing its job on round one, and
with one run per side the gate-round difference is an observation rather
than a finding. The adapters report cache accounting differently — codex
folds cache reads into input/total, the claude adapter reports them
separately — so compare per category and never the single "total" number.
The durable claim is the last row: identical work, and only one of the
two columns draws down Claude quota.
