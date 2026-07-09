# v0.5.0 fleet usage — the per-run ledger

Every feature in v0.5.0 was built by ultracodex fleets running on Codex.
The build arc (2026-07-08 → 2026-07-09): **14 runs, 72 agents,
1.26M output tokens — all on the Codex meter.** The driving Claude
session did planning, contract-freezing, and review.

| date | run | workflow | agents | output tokens |
|---|---|---|---|---|
| 2026-07-08 13:35 | `uc_mrcczqmu6wr8l` | loops-1-scheduler | 1 | 0 |
| 2026-07-08 13:43 | `uc_mrcd9iaw39wf6` | loops-1-scheduler | 6 | 125,592 |
| 2026-07-08 14:30 | `uc_mrcexorl29t00` | loops-1b-scheduler-fix | 7 | 104,231 |
| 2026-07-08 14:39 | `uc_mrcf9rlu6sajo` | loops-1c-scheduler-gate | 6 | 75,433 |
| 2026-07-08 15:14 | `uc_mrcgii2g96bj0` | loops-2-packaged | 5 | 70,472 |
| 2026-07-08 15:44 | `uc_mrchkngf4y8es` | loops-3-observability | 7 | 126,319 |
| 2026-07-08 16:30 | `uc_mrcj8ztj0ror4` | loops-3b-verify | 1 | 5,015 |
| 2026-07-08 18:13 | `uc_mrcmweze0q6ma` | loops-4-schedule-tui | 6 | 110,868 |
| 2026-07-09 00:41 | `uc_mrd0r64v6vz9u` | org-1-core | 7 | 188,580 |
| 2026-07-09 02:02 | `uc_mrd3oghp2cyhm` | org-1b-core-fix | 6 | 95,910 |
| 2026-07-09 02:45 | `uc_mrd5734u5zrse` | org-1c-verify | 1 | 15,407 |
| 2026-07-09 02:53 | `uc_mrd5gzmy1lacm` | org-2-replay-docs | 8 | 159,797 |
| 2026-07-09 03:55 | `uc_mrd7pr5t1dfk3` | org-3-org-tab | 8 | 153,493 |
| 2026-07-09 15:15 | `uc_mrdw031b3ux8m` | sched-budget-guardrail | 3 | 33,451 |
| | | **total** | **72** | **1,264,568** |

Notes: the first loops-1 run aborted after five minutes on a stale
routing config (one agent, ~0 tokens) and is counted — it happened.
Excluded: v0.1-era demo runs, the M4 fleets (they built v0.4.0), and
measurement runs (the controlled comparisons have their own ledgers under
[research/cmp-build/](cmp-build/README.md)).

Method: sums of `outputTokens` (which includes reasoning tokens) over the
`agent_usage`/`agent_end` events of each run's `journal.jsonl`. The
journals live in the engine state directory (`.ultracodex/runs/`,
untracked); regenerate this table with:

```python
# from the repo root
import json, glob
for j in glob.glob('.ultracodex/runs/*/journal.jsonl'):
    per = {}
    for line in open(j):
        e = json.loads(line)
        if e.get('t') in ('agent_usage','agent_end') and e.get('usage'):
            per[e['n']] = e['usage'].get('outputTokens', 0)
    print(j, len(per), sum(per.values()))
```
