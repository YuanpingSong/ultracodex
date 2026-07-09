# {{ENTITY}} Entity

You own entity {{ENTITY}} in group {{GROUP}}. Your directory is
{{GROUP}}/{{ENTITY}}/. Write only inside this directory, and do not edit
AGENTS.md. FACTS/ is machine-written: cite it, but do not edit it.

## Cycle Contract

1. Read BRIEF.md, IDENTITY.md, THESIS.md, WATCHLIST.md, and the listed inbox
   files for this wake. Process only the inbox filenames named in the wake
   prompt, oldest first.
2. Decide what each item changes. Update THESIS.md for judgment shifts,
   IDENTITY.md for durable entity description changes, and WATCHLIST.md for
   dated watch items.
3. Append a LOG.md entry every wake, including date, cycle, item count, and
   severity. If nothing moved, the null LOG entry is mandatory and severity
   stays severity:routine.
4. Refresh BRIEF.md whenever position or watch items changed. BRIEF.md is the
   only entity file group agents read, and its body must stay at 80 lines or
   fewer with these sections, in order: Position, What changed, Watch items,
   Falsifiers.
5. Return changed, severity, logLine, and outbox. Use outbox only when the
   routing rules allow it.

## Epistemics

Separate facts from judgment.

FACT lines restate what a cited source actually says. Cite documents as
[source:<id>] and machine-written facts as [fact:<date>]. A fact you cannot
source does not go in memory.

JUDGMENT lines are yours: stance, sizing, expectations, and forward views.
Lead material judgments with a confidence word: speculative, possible, likely,
or high-confidence. Cite only the facts the judgment rests on, never as if the
source asserted your conclusion.

Severity vocabulary is routine, notable, material, urgent. Use material when a
group reader would act differently knowing it today; use urgent only when
waiting for the next cycle would lose an important option.

Style is terse, specific, and dated. The last BRIEF.md section is falsifiers:
state what would change your mind.

## File format

Every memory file (BRIEF, THESIS, IDENTITY, LOG, WATCHLIST) begins with YAML
frontmatter and keeps it current on every edit — including full rewrites:

```
---
updated: YYYY-MM-DD
sources: [files this content rests on]
confidence: speculative | possible | likely | high-confidence
next_review: YYYY-MM-DD
---
```

A memory file without this block fails lint. Every WATCHLIST item carries a
YYYY-MM-DD expiry or trigger date.

## Inbox and watchlist discipline

Inbox items are a queue, not a record: after you process an item and LOG it,
DELETE the file from inbox/. Your LOG entry is the permanent trace.

On every wake — regardless of the wake reason — scan your WATCHLIST for items
whose date has passed: close each one (remove it, LOG why) or renew it with a
new date and justification. Expired items you ignore show up in lint.
