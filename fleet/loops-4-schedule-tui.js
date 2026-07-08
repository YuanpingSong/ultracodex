// Loops pillar, run 4 — the scheduler TUI: a third home tab (Runs | Loops |
// Schedules) with detail view, exec-now, add-from-TUI form, history strips,
// countdowns, and the startup overdue nudge.
export const meta = {
  name: 'loops-4-schedule-tui',
  description: 'Schedules home tab + detail view + exec-now + add-from-TUI form + history strips + countdowns + startup nudge',
  phases: [
    { title: 'Engine', detail: 'nextFire, shared addSchedule, log-tail parser, pure row helpers + tests' },
    { title: 'Views', detail: 'Schedules tab, ScheduleDetail, ScheduleForm, exec-now, nudge' },
    { title: 'Gate', detail: 'contract review, fix loop ≤2 rounds' },
    { title: 'Verify', detail: 'build + full suite + headless frames + CLI parity' },
  ],
}

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    verified: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    friction: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesTouched', 'verified', 'decisions', 'friction'],
}
const GATE = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'file', 'issue', 'fix'],
      },
    },
  },
  required: ['pass', 'summary', 'issues'],
}
const VERIFY = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    buildOk: { type: 'boolean' },
    testsOk: { type: 'boolean' },
    smokeOk: { type: 'boolean' },
    details: { type: 'string' },
  },
  required: ['pass', 'buildOk', 'testsOk', 'smokeOk', 'details'],
}

const COMMON = `Working dir = the ultracodex repo root. TypeScript sources in src/, TUI is Ink+React in src/tui/, vitest tests in tests/. NO new runtime dependencies. Use package.json scripts for build/test. NEVER run git commit or touch the git index; check hygiene with git status --short -uall. Do not bump the package version. RETURN raw data per your schema — your final text is parsed, not read by a human.`

// ————— FROZEN CONTRACT (parent-authored; the arbiter for the gate) —————
const CONTRACT = `
SCHEDULER TUI CONTRACT v1 (frozen — deviations need a "decisions" entry).
MOCKUPS: information architecture is normative; exact spacing, column
widths, and any glyph not in the NORMATIVE GLYPH SET are illustrative.
NORMATIVE GLYPHS: active ● (cyan), paused ⊘ (yellow), retired ○ (dim),
exec ok ✔ (green), exec fail ✖ (red), running-now = the shared spinner.

A. ENGINE-SIDE (src/schedule/, pure, unit-tested):
   1. nextFireMs(spec, nowMs): number|null — REAL next wall-clock fire time
      derived from the generated cron shapes: kind "every" Nm → next minute
      multiple of N (cron */N semantics: minute ≡ 0 mod N, seconds 0);
      "every" Nh → next hour multiple of N at minute 0; "daily" HH:MM →
      today at HH:MM local or tomorrow if passed. kind "cron" → null.
      Local time, plain Date math, no timezone libraries.
   2. Extract the CLI add action's core into an exported addSchedule(...)
      in src/schedule/ (validation, resolution, spec write, crontab
      install) so the CLI action and the TUI form call ONE code path.
      CLI behavior must remain byte-identical (cli.test.ts proves it).
   3. parseScheduleLogTail(text, max=5): Array<{ts: string, ok: boolean}>
      — the last N EXEC outcomes from a schedule log (lines matching the
      exec log format "ISO · exit N · ..."); skipped/paused/retired/error
      annotation lines are NOT outcomes. Feed it the log's last ~4 KB only.
   4. isExecRunning(projectDir, name): boolean — lockfile exists AND its
      pid is alive (reuse the existing lock helpers; do not duplicate pid
      logic).
   5. Pure row/format helpers in src/tui/schedules.ts (no fs, no Ink —
      same discipline as loops.ts): formatScheduleRow(...), history strip
      builder (✔ ✔ ✖ ✔ + trailing spinner char when running), countdown
      formatter ("in 2h 14m" / "in 45s" / "OVERDUE" when
      checkMissedSchedules flags it / "—" for raw cron), status glyph
      mapping per the normative set. All exported + unit-tested.

B. SCHEDULES TAB (HomeView): HomeTab becomes "runs" | "loops" |
   "schedules"; tab key cycles runs → loops → schedules → runs; the strip
   renders all three with the existing active-tab styling. MOCKUP (list +
   inline selection detail):

    ultracodex · ~/repos/private-org   Runs | Loops | Schedules

    ❯ ● report-tick   daily 18:30   ✔ ✔ ✖ ✔   in 2h 14m   12 runs
      ⊘ digest        every 30m    ✔ ✔ ✔ ✔   paused      41 runs
      ○ backfill      every 4h     ✔ ✔ ✔ ✔   retired (done)  6 runs

      selected: report-tick
      command  bash ops/cron-tick.sh · until-done: no
      last run ✔ 07-07 18:30 · exit 0 · uc_abc123
      LOG 2026-07-07T18:30:02 · exit 0 · status ok

    ↵ detail · e exec now · p pause/resume · x remove · tab next · q quit

   Data: listScheduleSpecs(projectDir) + per-schedule log tail + lock
   check; refresh every 2s while the tab is active (mtime cheap-check on
   the schedules dir before re-reading); countdowns re-render on the
   existing 1s-ish tick without fs reads. Rows sorted: active first (by
   next fire ascending), then paused, then retired. Empty state (dim):
   "no schedules — ultracodex schedule add <name> --every 30m -- run <wf>".
   Keys p/x/e are ACTIVE ONLY on the schedules tab (n/r/S stay
   workflow/run keys on the runs tab; verify no collisions with existing
   HomeView bindings). x asks an inline y/n confirm on the selected row
   before removing. p toggles pause/resume (resume of retired → flash the
   CLI error text via the existing useFlash). Overdue active rows render
   their countdown cell as OVERDUE in yellow.

C. EXEC NOW (e): spawn the schedule exec DETACHED (node <cliPath>
   schedule exec <name>, stdio ignore, unref — same child-process idioms
   the CLI already uses for detached runners) — NEVER run execSchedule
   in-process (it chdirs and blocks). Immediately flash "exec started:
   <name>". The row shows the spinner + "running now" while
   isExecRunning() is true; lastRun cell updates when the spec file
   refreshes. e on a paused/retired schedule → flash "schedule is
   <status>" and do nothing (exec would skip silently anyway).

D. SCHEDULE FORM (S on a workflow item in the runs tab, mirroring the
   existing launch-form pattern): fields — name (prefilled: workflow name
   slugified, editable), cadence (toggle every/daily with left/right or
   space), value ("30m" / "18:30" free text), until-done (y/n toggle),
   max-runs (blank = none), args JSON (blank = none; appended to the
   scheduled command as --args '<json>'). Enter on last field (or a
   submit affordance consistent with the launch form) calls
   addSchedule() with command ["run", <workflow ref>, ...args flags].
   Validation errors from addSchedule render inline (same error-line
   pattern as the launch form); on success: flash "scheduled <name>
   (<cronExpr>)", switch to the schedules tab with the new row selected.
   esc cancels. MOCKUP (illustrative layout, normative fields):

    schedule workflow: digest.js
    name        digest
    cadence     ● every   ○ daily
    value       30m
    until-done  no
    max-runs    (none)
    args        (none)
    ↵ create · esc cancel

E. SCHEDULE DETAIL (↵ on a schedules-tab row → ScheduleDetail.tsx):
   header "<name> · <human schedule> (<cronExpr>) · <status glyph+word>";
   line 2 "next <t> (in …) · runs N · until-done yes/no · max-runs …";
   command line; project line; last run line "✔ <ts> · exit N · <runId>"
   where ↵/o opens the run in RunView when a runId exists (esc returns
   back to the detail, then to the tab); LOG section = last 10 raw log
   lines (tail the file, no parsing); keys: e exec now, p pause/resume,
   x remove (y/n confirm; on remove return to the tab), esc back, q quit.
   Live-refresh the spec + log every 2s while open.

F. STARTUP NUDGE: on HomeView mount, checkMissedSchedules(projectDir);
   render at most 2 warning lines (yellow, dim) directly under the header
   on ALL tabs, "+N more" when more; recompute on the 2s refresh so the
   warning clears once a run lands. This closes the deferred TUI-nudge
   item from the scheduler contract.

G. DOCS: docs/schedule.md gains a short "In the TUI" section (tab, keys,
   exec-now, the S form); docs/operations.md TUI key list updated if one
   exists. Document only what exists.

H. TESTS: pure helpers per A (nextFireMs math incl. hour/day rollover and
   the daily-tomorrow case; log-tail parser incl. non-outcome lines and
   truncated first line; history strip; countdown formatter incl. OVERDUE
   and raw-cron —; row formatting; status glyph map), addSchedule shared
   path (CLI action still passes existing cli.test.ts suite; a new test
   calls addSchedule directly with ULTRACODEX_CRONTAB_FILE and asserts
   spec+line identical to the CLI's), isExecRunning (live pid vs stale vs
   absent), form validation logic (extract as a pure function). NO Ink
   component harness — pure-helper coverage is the requirement (run-3
   precedent). Full existing suite stays green.
`

phase('Engine')
const engine = await agent(`${COMMON}

YOUR ASSIGNMENT — part 1 (Engine) of the scheduler-TUI contract below: items A.1–A.5 and their tests (H, engine half). Read src/schedule/spec.ts, src/schedule/exec.ts, src/schedule/crontab.ts, src/cli.ts (the schedule add action + act() wrapper), src/tui/loops.ts (the pure-helper discipline to mirror), tests/schedule.test.ts first. Extract addSchedule WITHOUT changing CLI behavior. Read sections B–F so your helper APIs serve the views (they build on you next).
${CONTRACT}
Verify before returning: build green, full vitest suite green (existing schedule tests must not change semantics).`, { label: 'impl:sched-engine', phase: 'Engine', schema: REPORT, effort: 'xhigh' })
if (!engine) return { status: 'blocked', at: 'engine' }
log(`engine: ${engine.summary.slice(0, 100)}`)

phase('Views')
const views = await agent(`${COMMON}

YOUR ASSIGNMENT — part 2 (Views) of the scheduler-TUI contract below: sections B–G plus the view half of H. Part 1 already landed (src/schedule/ helpers + src/tui/schedules.ts) — consume it; extend schedules.ts only with additional PURE helpers (tested). Read src/tui/HomeView.tsx (tab state, Mode union, launch form, useFlash), RunView.tsx, LoopView.tsx (chrome + navigation precedent), AgentDetail.tsx, hooks.ts first. The Schedules tab must be indistinguishable in style from Runs/Loops; verify every new keybinding against the existing ones (n, r, S, tab, ↵, arrows) per tab scope.
${CONTRACT}
Verify before returning: build green, full suite green; confirm the CLI (non-TUI) surface is untouched by rendering ultracodex schedule ls in a tmp project with ULTRACODEX_CRONTAB_FILE.`, { label: 'impl:sched-views', phase: 'Views', schema: REPORT, effort: 'xhigh' })
if (!views) return { status: 'blocked', at: 'views', engine }
log(`views: ${views.summary.slice(0, 100)}`)

let gate = null
for (let round = 1; round <= 3; round++) {
  gate = await agent(`${COMMON}

YOU ARE THE GATE (round ${round}). Adversarially review the scheduler-TUI implementation against the frozen contract below. Read the diff (git status --short -uall + git diff) and every touched file. Hunt for: CLI add behavior drift after the addSchedule extraction (run the existing schedule lifecycle tests and diff the spec/crontab artifacts against the pre-change format); in-process execSchedule calls from the TUI (blocker — it chdirs the TUI process); fs reads inside render paths outside the sanctioned 2s refresh; nextFireMs math errors (test rollover cases yourself: 59m every at 23:58, daily at a time already passed, 4h every at 03:00); keybinding collisions per tab; lock-based running detection treating a stale lock as running; impure schedules.ts; form validation gaps (bad value strings, dup names — must surface addSchedule's error, not crash); mockup drift in information architecture (glyph substitutions within the normative set are FINE — the mockups' spacing and non-normative glyphs are illustrative, per the contract header); missing y/n confirm on remove; docs drift. Run build + full suite yourself. pass=true ONLY if zero blocker/major issues.
${CONTRACT}`, { label: `gate:sched-tui-r${round}`, phase: 'Gate', schema: GATE, effort: 'xhigh' })
  if (!gate) return { status: 'blocked', at: `gate-r${round}`, engine, views }
  log(`gate r${round}: ${gate.pass ? 'PASS' : `${gate.issues.length} issues`} — ${gate.summary.slice(0, 80)}`)
  if (gate.pass) break
  if (round === 3) return { status: 'gate-exhausted', engine, views, gate }
  const fixes = gate.issues.filter(i => i.severity !== 'minor')
  if (fixes.length === 0) break
  const fix = await agent(`${COMMON}

YOUR ASSIGNMENT — fix EXACTLY these gate findings (round ${round}); no drive-by refactors. Findings (file · issue · required fix):
${fixes.map(i => `- [${i.severity}] ${i.file}: ${i.issue} → ${i.fix}`).join('\n')}

The frozen contract (arbiter):
${CONTRACT}
Verify: build + full suite green before returning.`, { label: `fix:sched-tui-r${round}`, phase: 'Gate', schema: REPORT, effort: 'xhigh' })
  if (!fix) return { status: 'blocked', at: `fix-r${round}`, engine, views, gate }
  log(`fix r${round}: ${fix.summary.slice(0, 80)}`)
}

phase('Verify')
const verify = await agent(`${COMMON}

YOU ARE THE FINAL VERIFIER. Fresh eyes, no prior context. (1) Build — buildOk. (2) Full vitest suite — testsOk. (3) Smoke, in a fresh tmp project with ULTRACODEX_CRONTAB_FILE set: create two schedules via the CLI (one --every 5m arbitrary command, one --daily 18:30 --until-done -- run <trivial script you create>); assert schedule ls output is unchanged in format from before this change (compare against the documented table in docs/schedule.md); call the exported addSchedule() directly and diff its spec file + crontab line against the CLI-created ones (must be identical in shape); exercise nextFireMs with a frozen now for: every 5m at 12:03 → 12:05, every 4h at 03:00 → 04:00, daily 18:30 at 19:00 → tomorrow 18:30; run parseScheduleLogTail on a synthetic log containing exec lines, a skipped line, and a retired line → only exec outcomes. (4) git status --short -uall — changes confined to src/schedule/, src/tui/, src/cli.ts, tests/, docs/. pass = all four. Report exact failures in details.`, { label: 'verify:sched-tui', phase: 'Verify', schema: VERIFY, effort: 'high' })

return { status: verify && verify.pass && gate && gate.pass ? 'green' : 'needs-review', engine, views, gate, verify }
