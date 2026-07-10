# Skill validation — the standing procedure

Validates that the shipped skills let a USER'S agent (any vendor) drive
every ultracodex pillar correctly, knowing only what a user's agent knows.
Run it before releases that touch the skills, the CLI surface, or the
packaged workflows.

## Design

- **Item under test:** skills/ultracodex/SKILL.md (the dispatch skill),
  with agent-script-authoring and org-creation reachable from it.
- **Matrix:** 15 tasks × 3 driver backends (codex / claude / opencode) —
  see the TESTS table in fleet/skill-validation.js. The tasks cover all
  four pillars plus dispatch-negative and foot-gun cases; several carry
  planted ground truth (contradictions, exactly six TODO markers).
- **Drivers as strangers:** each combo gets a clean folder with
  `sync-skills` run and nothing else; drivers are told to read the
  installed skill first and are forbidden from reading source. What a
  driver needed but the docs never gave it is a finding.
- **Artifact-first judging:** judges (claude-sonnet-5) verify mechanical
  ground truth with their own shell (specs, crontab files, run results,
  lint output, recall counts) and treat driver self-reports as claims.
  Verdict schema: pass · score · dispatchCorrect · budgetDiscipline ·
  violations.

## Running a round

```bash
# 1. folders (L4 wants a seeded completed run)
SKILLVAL_L4_SEED=<path-to-a-completed-goal-run-dir> \
  python3 fleet/skillval-gen.py /tmp/skillval-harness/rN

# 2. harness project config: see the [route] table in this doc's appendix —
#    driver:cx-*→codex(terra), driver:cl-*→claude(sonnet-5),
#    driver:oc-*→opencode, judge:*→claude(sonnet-5), plus
#    [profiles.Networked] for the codex drivers.

# 3. main matrix
cd /tmp/skillval-harness && ultracodex run <repo>/fleet/skill-validation.js \
  --json --concurrency 6 --args '{"base":"/tmp/skillval-harness/rN","backends":["cx","cl"]}'

# 4. opencode separately — low concurrency, isolated state
mkdir -p /tmp/oc-data/opencode && cp ~/.local/share/opencode/auth.json /tmp/oc-data/opencode/
XDG_DATA_HOME=/tmp/oc-data ultracodex run <repo>/fleet/skill-validation.js \
  --json --concurrency 2 --args '{"base":"/tmp/skillval-harness/rN","backends":["oc"]}'
```

## Infra lessons (hit in round 1; both are also user-facing)

- **Nested fleets under a codex sandbox** need a workspace-scoped state
  home: the driver preamble exports `CODEX_HOME="$PWD/.codex-home"` with
  auth.json copied in (also documented in docs/operations.md).
- **opencode's server-per-call design contends on its state db** — a
  large user db (observed: ~2 GB) plus concurrent spawns produces
  "database is locked" storms. Isolate via `XDG_DATA_HOME` and keep
  opencode driver concurrency low. Engine backlog: per-backend
  concurrency caps and a data-dir override in the opencode adapter.

## Rounds

- **Round 1 (2026-07-09)** — round-1-results.json. claude 14/15; codex
  7/15 with every failure traced to the nested-CODEX_HOME fault; opencode
  0/15 (db lock storm). Genuine skill findings folded back: offer options
  on implied recurrence; exact day-2 org verb shapes. Test-design fix:
  L4 folders now seed a completed run. Redundancy thesis (packaged
  until-dry removed; goal covers completeness) passed empirically on the
  working backend.
- **Round 2 (2026-07-10)** — results committed alongside when complete.
