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
- **Round 2 (2026-07-10)** — round-2-main-results.json. cx 6/15, cl
  13/15 — the dip EXPOSED the next infra layer: pidAlive read the sandbox
  boundary's EPERM as death, so `ls` reported healthy runs dead and
  drivers faithfully relayed the tool's lie (fixed: EPERM=alive). Also
  yielded: goal returns its deliverable; the skill documents `show`;
  folders gitignore .codex-home after a driver committed a copied token.
- **Round 3 (2026-07-10)** — round-3-main-results.json. cx 10/15, cl
  14/15. Residue attributes to nested-sandbox runtime (inner exec tools
  blocked — since fixed by the CODEX_SANDBOX auto-downgrade) and model
  tier, not skill authorship. Dispatch and budget discipline near-
  universal. VERDICT: the skill is validated at frontier and balanced
  tiers.
- **The opencode lane** — never produced skill data; SIX attempts across
  TWO providers, each converting an invisible failure into a visible one,
  yielding five committed adapter fixes: state-isolation guidance, the
  undici-300s replacement, the finite 30min turn cap, the idle watchdog
  with direct request destruction, and finally the progress-only idle
  reset. THE CONCRETE FINDING: deepseek-v4-pro AND glm-5.2 (Zhipu
  coding-plan) both pass short probes in seconds but stall identically on
  long driver sessions — the provider is ruled out; the fault is
  opencode 1.17.x (or our long-session interaction with it), which keeps
  the SSE connection warm with non-progress events during a stall. ROOT
  CAUSE FOUND (via opencode server logs + the message DB): NOT a stall and
  NOT the provider — our adapter never told opencode headless serve to
  auto-approve tool permissions, so reading the skill file (outside the
  agent cwd → permission=external_directory, action=ask) blocked the turn
  forever. Short probes passed because they read files INSIDE cwd
  (auto-allow). Fixed by setting OPENCODE_PERMISSION on serve spawn;
  opencode drivers then completed for the first time. The idle watchdog +
  turn timeout remain as defense-in-depth for genuine stalls. Lesson:
  when a headless integration hangs, read ITS logs before blaming the
  model or the network — the owner called this exactly. RESULT after the
  fix (opencode-glm52-results.json): 13/13 judged drivers PASS — a clean
  sweep across all four pillars (W 3/3, L 4/4, S 4/4, O 2/2), dispatch
  correct on every one, budget discipline universal. The two non-passes
  were driver deaths on the serve spawn-collision (concurrency contention,
  v0.6), not skill failures. Net: the skill is validated on ALL THREE
  backends — the opencode column just needed the adapter to stop asking a
  headless server for approvals no one could give. RETRY of the two spawn-crash tasks at concurrency 1: O1 (org creation) passed clean (confirming pure infra contention), W1 completed but FAILED on substance — GLM-5.2 authored a verifier prompt biased toward dismissal and missed 2 of 3 planted contradictions (dispatch correct; a model-quality miss, not a skill gap). Full-coverage opencode tally: 14/15.
