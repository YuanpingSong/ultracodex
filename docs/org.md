# Org runtime

Orgs scale what agents remember — the state axis of agent work. An org does
not answer context limits with a bigger window; it **shards context into many
windows** with a disciplined interface between them: each seat is an agent
directory with its own memory, and the ≤80-line BRIEF is the interface
contract a superior actually reads. The span rule is the scaling law — an
aggregator's fan-out is context ÷ brief.

An org is a filesystem-routed set of agents with durable memory, inboxes,
tickets, and a tick scheduler. It is for domains where attention should
compound over time: new inputs arrive, entity memory changes, aggregators read
briefs, and the root gives the human the current house view.

Do not start with an org unless four gates pass:

| gate | test |
|---|---|
| Partition key | The domain splits into entities with crisp ownership. |
| Volume | Recurring inbound volume makes maintained memory cheaper than rereading. |
| Compounding | Prior distilled belief improves later judgment. |
| Judgment, not action | The output is synthesis a human reads, not direct world-changing action. |

If any gate fails, use a workflow, queue, script, or database instead.

## Structure

The public scaffold is a two-to-three-level tree:

```
/                         root agent
  AGENTS.md BRIEF.md LOG.md inbox/ tickets/
  coverage.toml           groups + entities
  templates/              root.md group.md entity.md
  <group>/                aggregator
    AGENTS.md BRIEF.md THESIS.md LOG.md inbox/ tickets/
    <entity>/             leaf agent
      AGENTS.md BRIEF.md IDENTITY.md THESIS.md LOG.md WATCHLIST.md
      FACTS/ inbox/ tickets/
  ingest/                 ledger.jsonl cache/ unassigned/
  .ultracodex/org/state/  runtime state
```

Keep aggregator span near 5-15 children. A superior reads child `BRIEF.md`
files, not the whole subtree, and every `BRIEF.md` body is capped at 80 lines.
When the brief cap or span rule breaks, add another group.

`coverage.toml` defines groups and entities. `ultracodex org init` copies role
templates when needed, creates memory files and inboxes, and preserves existing
memory unless replay asks for a pristine reset.

## Memory

Memory is divided by update trigger, not by topic:

| slot | owner | update trigger |
|---|---|---|
| `IDENTITY.md` | entity | Rebuilt from primary sources on `next_review`; incremental edits should stay in a clearly labeled recent-developments section. |
| `FACTS/` | fetcher | Machine-written only. Agents cite these files, never transcribe them from memory. |
| `THESIS.md` | group/entity | Judgment revised only on that agent's own wake. |
| `LOG.md` | every agent | Append on every wake. The null entry is mandatory when nothing changed. |
| `WATCHLIST.md` | entity | Each item carries an expiry or trigger date. |
| `BRIEF.md` | every agent | The only artifact a superior reads; body <= 80 lines. |

Every memory file has frontmatter:

```yaml
---
updated: 2026-07-09
sources: []
confidence: possible
next_review: 2026-10-07
---
```

Confidence vocabulary is `speculative|possible|likely|high-confidence`.
Severity vocabulary is `routine|notable|material|urgent`. Template text should
define severity by the deciding test: would the owner act differently today?

Null `LOG.md` entries are part of the contract. A quiet wake still records a
line such as `- 2026-07-09 - cycle 12 - 0 items - nothing material -
severity:routine`. Silence must be auditable.

## Communication

The org has three receiver-cost levels:

| type | receiver cost | rule |
|---|---|---|
| `QUERY` | none | A read-only fork answers from target files. No inbox item, no wake. |
| `NOTIFY` | one judgment | Creates an inbox item for the next wake. Lateral, downward, and cross-subtree sends are allowed. |
| `REQUEST` | work | Only an ancestor can request work from a descendant. The runtime creates a ticket. |
| `REPLY` | ticket write | Only the ticket target can answer an open ticket. |

Nobody writes up-tree. Agents do not notify their ancestors; they write
severity into memory, and the scheduler wakes parents through content triggers.
Infrastructure senders `ops`, `audit`, and `user` bypass authority checks but
are still ledgered.

Routing violations are data. The router rejects the message, appends a
`routing-violation` row to `ingest/ledger.jsonl`, and writes feedback into the
sender's inbox when the sender is an agent. The tick continues; the next wake
corrects the behavior.

## Ticks

`ultracodex org tick` evaluates four trigger classes:

| class | wakes |
|---|---|
| time | Memory files whose `next_review` is due. |
| quantity | Agents whose inbox depth crosses the threshold. |
| content | Parents of children with material or urgent lines since the parent last woke. |
| dependency | Aggregators whose children completed enough wakes since the aggregator last woke. |

The scheduler wakes deepest agents first, bounded by `--concurrency`, then
re-evaluates triggers until no new agent is due or the round cap is reached.
Each wake runs from the agent directory and returns:

```js
{ changed, severity, logLine, outbox }
```

The runtime delivers `outbox` messages with router checks, stamps
`.ultracodex/org/state/last-wake.json`, expires tickets unless disabled, and
runs org lint after non-empty ticks. A no-wake tick is a no-op.

## Fetchers

Fetchers are user code. They should be deterministic and testable without
network by fixture injection. A fetcher delivery is exactly one inbox item plus
one ingest row.

Fetcher rows live in `ingest/ledger.jsonl`, alongside router
`routing-delivery` and `routing-violation` rows. The public ingest row shape is
frozen:

```json
{"type":"ingest","at":"2026-07-09T00:00:00.000Z","id":"source-item-1","date":"2026-07-09","to":"group/entity","item":"source-item-1.md","ref":"ingest/cache/source-item-1.txt"}
```

Fields:

| field | meaning |
|---|---|
| `type` | Always `ingest` for fetcher-delivered corpus rows. |
| `at` | ISO timestamp when the fetcher delivered the item. |
| `id` | Stable non-empty item id, unique within the source stream. It is data, not a path slug. |
| `date` | Delivery date in `YYYY-MM-DD` form. |
| `to` | Target agent path, with `.` for the root agent. |
| `item` | Inbox item filename or repo-relative inbox path. |
| `ref` | Optional repo-relative source or cache reference. |

Fetcher discipline:

- Route deterministically. Do not ask an LLM to decide where routine items go.
- Cache by content or stable source id, and extract searchable plain text for
  cached documents.
- Advance cursors only through fully successful days.
- Defer per item on upstream failures. One bad item should not block a day.
- Put unroutable but relevant items in `ingest/unassigned/`.
- Prefer narrow per-entity source access when available. On blocks, use silence
  followed by one retry; diagnostic probes are traffic too.

Replay derives its corpus only from `type:"ingest"` rows, deduped by `id`, `to`,
and `date`; rows stamped `"replay": true` mark matching original rows as
already replayed. When an `item` is not already an inbox markdown filename or
path, replay percent-escapes `id` only for the fallback inbox filename.

## Lint

`ultracodex org lint` validates the tree:

- role-required files and directories;
- memory frontmatter and vocabulary;
- `BRIEF.md` body length <= 80 lines;
- watchlist item dates;
- `THESIS.md` provenance refs;
- wake liveness through `LOG.md` entries for the cycle;
- single-writer boundaries when diff paths are supplied.

`--strict` upgrades past-review warnings to errors. Tick repair, when enabled,
uses the packaged `org-lint-repair` workflow and asks only offending agents to
repair their own files.

## Audit

`ultracodex org audit [--sample N] [--json]` runs the packaged `org-audit`
workflow. It samples claim lines from `BRIEF.md` and `THESIS.md`, preferring
lines with `[source:...]` or `[fact:...]` refs and lines containing numbers.
Each sampled claim is checked against its cited source file only.

Verdicts are `verified`, `unsupported`, `contradicted`, and `uncheckable`.
Mixed lines use weakest-link grading. The CLI appends one history row per
date/sample/accuracy to:

```
.ultracodex/org/state/audit-history.jsonl
```

It also delivers each finding as a `NOTIFY` from infrastructure sender `audit`
to the owning agent. The next tick gives that agent the correction loop.

## Replay

Replay re-lives the ingest ledger through the tick scheduler:

```
ultracodex org replay [--root DIR] [--from YYYY-MM-DD] [--to YYYY-MM-DD] \
  [--faults "drop:ID;dup:ID;late:ID:DAYS"] [--pristine] [--json]
```

Faults:

| fault | behavior |
|---|---|
| `drop:ID` | Omits matching deliveries. |
| `dup:ID` | Delivers a duplicate on the following day. |
| `late:ID:DAYS` | Shifts delivery forward by `DAYS`. |

If an id contains `:`, `,`, or `;`, quote it as a JSON string inside the fault
spec, for example `late:"pkg:@scope/name:1.2.3":2`.

Replay stamps generated ledger rows with `"replay": true`. `--pristine`
requires the current git branch to start with `replay/`, then resets memory
files to scaffold stubs before replay. This makes counterfactual runs visible
without rewriting the active org history.

## Scheduling

Schedules are external cron-backed commands, not an org daemon. To run the org
tick daily at local 18:30, schedule the CLI itself:

```
ultracodex schedule add org-tick --daily 18:30 -- ultracodex org tick
```

The special scheduled `run` form is only for workflows. `org tick` is an
ordinary CLI command, so the scheduled argv must include `ultracodex`.

See [schedule.md](schedule.md) for cron management and missed-run warnings.
