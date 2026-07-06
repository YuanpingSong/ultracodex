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
