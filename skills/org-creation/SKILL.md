---
name: org-creation
description: Design and stand up a generic filesystem-routed agent organization: a long-lived, self-scheduling, self-auditing org with per-entity memory, deterministic ingestion, audit, replay, and tick scheduling. Use when a domain needs continuous document or event intake, durable judgment that compounds by entity, and human-readable synthesis rather than one-shot workflow output.
---

# Creating An Agent Org

An org is an attention organization: a directory tree of agents with durable
memory, inboxes, and a tick scheduler. Nothing is resident. Agents are
directories; ticks wake only the agents whose triggers fire.

## Part 1 - The Gate

Build an org only when all four tests pass:

1. **Partition key.** The domain splits into entities with crisp boundaries.
   Use groups/entities, not fuzzy topics that duplicate work.
2. **Volume.** Recurring inbound volume makes maintained memory cheaper than
   rereading from scratch.
3. **Compounding.** Yesterday's distilled belief improves today's judgment.
4. **Judgment, not action.** The org produces synthesis a human reads. It does
   not directly send mail, deploy, approve, trade, or operate production.

If a test fails, use a workflow, script, queue, or database instead.

## Part 2 - Structure

Use two to three levels:

```text
/                         root agent: house view and user door
  AGENTS.md BRIEF.md LOG.md inbox/ tickets/
  coverage.toml           scaffold input: groups + entities
  templates/              root.md group.md entity.md
  <GROUP>/                aggregator
    AGENTS.md BRIEF.md THESIS.md LOG.md inbox/ tickets/
    <ENTITY>/             leaf agent
      AGENTS.md BRIEF.md IDENTITY.md THESIS.md LOG.md WATCHLIST.md
      FACTS/ inbox/ tickets/
  ingest/                 ledger.jsonl cache/ unassigned/
```

Keep aggregator span near 5-15 children. The superior reads only child
`BRIEF.md` files, and every `BRIEF.md` body is capped at 80 lines.

Templates use `{{GROUP}}`, `{{GROUP_TITLE}}`, and `{{ENTITY}}`. Scaffold owns
`AGENTS.md`; edit templates and re-scaffold rather than editing instances.

Directory slugs must be filesystem-safe and stable. Avoid reserved names:
`ingest`, `templates`, `docs`, `coverage.toml`, `.ultracodex`, `.git`,
`node_modules`, `ops`, `runtime`, `workflows`, `audit`, and `user`. Map scoped
or special external ids to safe slugs and record the mapping in `IDENTITY.md`.

Runtime-created files and directories such as `tickets/`, `.thread`, and
`QA.log.md` may appear after operation. Do not make templates depend on their
initial presence.

Entity counts are flexible. Cover the real population, then split or add
aggregators when the span rule breaks.

## Part 3 - Memory

Divide memory by update trigger, not by topic:

| slot | update trigger |
|---|---|
| `IDENTITY.md` | Rebuild from primary sources on `next_review`; between rebuilds, only append a clearly labeled recent-developments section. |
| `FACTS/` | Fetcher-written only; agents cite these files, never transcribe them from memory. |
| `THESIS.md` | The agent's judgment; revise only on the agent's own wake. |
| `LOG.md` | Append on every wake. The null entry is mandatory when nothing changed. |
| `WATCHLIST.md` | Each item carries an expiry or trigger date. |
| `BRIEF.md` | The only artifact a superior reads; body <= 80 lines. |

Every memory file needs frontmatter: `updated`, `sources`, `confidence`,
`next_review`. Use fixed vocabulary: confidence
`speculative|possible|likely|high-confidence`; severity
`routine|notable|material|urgent`.

Calibrate severity in the templates with the deciding test: "would the owner
act differently today?" Expect thresholds to be wrong at first. Replay real
history and adjust.

Citation discipline:

- Fact lines cite the source that contains the fact: `[source:...]` or
  `[fact:...]`.
- Judgment lines lead with a confidence word and cite the facts they rest on.
- Forward-looking lines say `projection:` and cite their basis.
- Honest recorded ignorance beats a fabricated answer. Record missing inputs
  in `LOG.md` or `WATCHLIST.md`.

Auditor test: could a reader verify this line by reading the cited source file
alone?

## Part 4 - Communication

Use three receiver-cost levels:

- **QUERY** costs the target nothing. A read-only fork answers from its files.
- **NOTIFY** costs one judgment. It creates an inbox item for the next wake and
  expects no response.
- **REQUEST** costs work. Only an ancestor can request work from a descendant;
  the runtime creates a ticket. The target answers with **REPLY** on that
  ticket.

Nobody writes up-tree. Agents do not page their ancestors; they write severity
in memory, and the scheduler wakes the parent through content triggers.

Router violations are not silent. The runtime rejects the message, appends a
`routing-violation` row to `ingest/ledger.jsonl`, and sends feedback to the
sender so the next wake can correct the behavior.

## Part 5 - Cycle

The scheduler evaluates four trigger classes:

- **time**: `next_review` or cadence.
- **quantity**: inbox depth crosses the threshold.
- **content**: material or urgent lines in a child wake the parent.
- **dependency**: enough children have completed since the parent last woke.

Wakes run from the agent directory. The wake result shape is:

```js
{ changed, severity, logLine, outbox }
```

The runtime delivers outbox messages with authority checks, records state, and
runs org lint. Every wake appends a `LOG.md` line; a quiet wake appends a null
entry with `severity:routine`.

## Part 6 - Ingestion

Build deterministic fetchers. They write one inbox item and one ledger row per
delivered item:

```json
{"type":"ingest","at":"2026-07-09T00:00:00.000Z","id":"item-1","date":"2026-07-09","to":"group/entity","item":"item-1.md","ref":"ingest/cache/item-1.txt"}
```

Disciplines:

- Make routing deterministic and test it with fixtures.
- Append a ledger row for every delivered item. The `id` is any stable
  non-empty source id, not a filesystem slug; replay escapes it only when it
  must derive a fallback inbox filename. Router delivery and violation rows
  coexist in the same file.
- Use content-addressed cache entries and extract searchable plain text for
  cached documents.
- Advance cursors only through fully successful days.
- Defer per item when an upstream item fails; one blocked item must not kill a
  whole cycle.
- Keep unroutable inputs in `ingest/unassigned/` for root review.
- Be polite: prefer per-entity APIs where they exist, avoid broad crawling,
  and on blocks use silence followed by one retry.

Example domains can be dependency-watching, incident-watching, or an
investment-research org watching a public filings feed. Keep the fetcher
contract generic until the user supplies source-specific rules.

## Part 7 - Verification

Run `ultracodex org lint` on demand and after ticks. Lint checks file
presence, frontmatter, vocabulary, `BRIEF.md` length, watchlist dates, thesis
provenance, LOG liveness, and single-writer boundaries.

Run `ultracodex org audit` after large ingests and on a schedule. A different
agent samples `BRIEF.md` and `THESIS.md` claims, verifies each against its
cited source file only, and returns
`verified|unsupported|contradicted|uncheckable`. Mixed lines use weakest-link
grading. Audit findings are delivered as `audit` notifies; owning agents fix
their own memory on the next tick.

Use replay for calibration. Replay derives a corpus from ingest ledger rows,
re-delivers it day by day, and can inject `drop`, `dup`, and `late` faults.
`--pristine` resets memory to scaffold state and is allowed only on a
`replay/` branch.

## Part 8 - Build Order

1. Run the gate. Pick partition key, groups, and an initial entity set.
2. Write `coverage.toml` and role templates. Put severity calibration and
   citation rules in the templates.
3. Run `ultracodex org init`; `ultracodex org lint` must pass.
4. Write the fetcher contract before coding fetchers. Then build deterministic
   fetchers with fixture tests.
5. Ingest a small sample and run `ultracodex org tick`. Read the root and group
   briefs yourself.
6. Audit, fix templates, and re-audit.
7. Backfill through replay. Tune thresholds by replay, not by hope.
8. Schedule the daily tick only after null LOG entries, audit convergence, and
   replay behavior are trustworthy.
