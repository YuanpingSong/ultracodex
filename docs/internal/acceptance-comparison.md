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

Caveats, honestly: the rebuild implemented a frozen written spec
(docs/internal/product_context.md), and re-implementing a spec is cheaper
than designing from scratch — some of the gap is process, some is fleet
economics. Token figures are each harness's own output-token accounting.
