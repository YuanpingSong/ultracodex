// Scheduler guardrail — first-class token budgets on scheduled runs, so an
// every-minute loop can't silently burn quota unattended.
export const meta = {
  name: 'sched-budget-guardrail',
  description: 'schedule add --budget flag (injected into run argv at exec), no-budget warning, budget surfacing in ls/TUI, quota-safety docs',
  phases: [
    { title: 'Implement', detail: 'flag + injection + warning + surfacing + tests + docs' },
    { title: 'Gate', detail: 'contract review, fix loop ≤2 rounds' },
    { title: 'Verify', detail: 'build + suite + headless lifecycle smoke' },
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

const COMMON = `Working dir = the ultracodex repo root. TypeScript in src/, vitest tests in tests/. NO new runtime dependencies. Use package.json scripts for build/test. NEVER run git commit or touch the git index. Do not bump the package version. RETURN raw data per your schema.`

// ————— FROZEN CONTRACT —————
const CONTRACT = `
SCHEDULE BUDGET GUARDRAIL CONTRACT v1:

B1. \`schedule add <name> … --budget <spec> -- run <ref> …\`: new option on the
    add command AND the shared addSchedule() (single code path — the TUI
    schedule form gains the same optional budget field). Valid ONLY when the
    scheduled command starts with "run" (CliError otherwise). Validate the
    spec with the SAME syntax \`run --budget\` accepts (find its parser in
    src/cli.ts and reuse/extract it — do not write a second parser). Stored
    on the spec as budget: string | null (spec version stays 1; missing
    field reads as null for existing specs).
B2. EXEC INJECTION: for "run" commands, schedule exec appends
    ["--budget", spec.budget] to the run argv when spec.budget is set —
    UNLESS the stored command argv already contains a --budget token (the
    explicit in-command value wins; no duplicate flags ever).
B3. NO-BUDGET WARNING: schedule add (CLI and addSchedule for the form path)
    with a "run" command and NO budget anywhere (no --budget option, no
    --budget token in the command argv) prints ONE warning line to stderr
    and still succeeds:
    "warning: no token budget on scheduled run '<name>' — an unattended
    loop without --budget can exhaust your quota; add --budget (e.g.
    --budget 200k)". Non-run commands never warn. --json/quiet paths keep
    the warning on stderr only.
B4. SURFACING: schedule ls --json includes budget; the human ls table is
    UNCHANGED (width discipline). The TUI inline selection detail and
    ScheduleDetail command line gain " · budget: <spec>" when set (pure
    row helpers in src/tui/schedules.ts updated + unit tests).
B5. DOCS: docs/schedule.md gains a "Budgets and quota safety" section:
    always budget scheduled runs; the --budget flag and the in-command
    alternative; the warning; how the exec lock already prevents overlap
    stacking; --until-done/--max-runs as the retirement guardrails; cross
    reference from docs/loops.md's schedule mention (one sentence).
B6. TESTS (mirror tests/schedule.test.ts conventions, ULTRACODEX_CRONTAB_FILE
    everywhere): flag stored + injected into stub exec argv; explicit
    in-command --budget suppresses injection AND the warning; --budget with
    a non-run command errors; warning emitted exactly once on stderr for
    unbudgeted run schedules and NOT for budgeted/non-run ones; bad budget
    spec rejected with the run parser's error; ls --json field present;
    TUI row-helper budget rendering. Full existing suite stays green.
`

phase('Implement')
const impl = await agent(`${COMMON}

YOUR ASSIGNMENT — implement the guardrail exactly per the contract below. Read src/schedule/add.ts, src/schedule/exec.ts, src/schedule/spec.ts, src/cli.ts (the run command's --budget parsing and the schedule group), src/tui/schedules.ts, src/tui/HomeView.tsx (the schedule form), src/tui/ScheduleDetail.tsx, tests/schedule.test.ts, docs/schedule.md first.
${CONTRACT}
Verify before returning: build green, full vitest suite green.`, { label: 'impl:sched-budget', phase: 'Implement', schema: REPORT, effort: 'xhigh' })
if (!impl) return { status: 'blocked', at: 'impl' }
log(`impl: ${impl.summary.slice(0, 100)}`)

let gate = null
for (let round = 1; round <= 3; round++) {
  gate = await agent(`${COMMON}

YOU ARE THE GATE (round ${round}). Adversarially review against the contract below. Hunt for: a second budget parser instead of reuse; injection duplicating an explicit --budget; the warning printed to stdout (breaks --json consumers) or printed for non-run commands; TUI form path skipping the shared addSchedule (artifacts must stay byte-identical — run the parity test); ls TABLE width changes; docs describing behavior that does not exist (run the commands yourself). Run build + full suite. pass=true ONLY if zero blocker/major issues.
${CONTRACT}`, { label: `gate:sched-budget-r${round}`, phase: 'Gate', schema: GATE, effort: 'xhigh' })
  if (!gate) return { status: 'blocked', at: `gate-r${round}`, impl }
  log(`gate r${round}: ${gate.pass ? 'PASS' : `${gate.issues.length} issues`} — ${gate.summary.slice(0, 80)}`)
  if (gate.pass) break
  if (round === 3) return { status: 'gate-exhausted', impl, gate }
  const fixes = gate.issues.filter(i => i.severity !== 'minor')
  if (fixes.length === 0) break
  const fix = await agent(`${COMMON}

YOUR ASSIGNMENT — fix EXACTLY these gate findings (round ${round}); no drive-by refactors. Findings:
${fixes.map(i => `- [${i.severity}] ${i.file}: ${i.issue} → ${i.fix}`).join('\n')}

The frozen contract (arbiter):
${CONTRACT}
Verify: build + full suite green before returning.`, { label: `fix:sched-budget-r${round}`, phase: 'Gate', schema: REPORT, effort: 'xhigh' })
  if (!fix) return { status: 'blocked', at: `fix-r${round}`, impl, gate }
  log(`fix r${round}: ${fix.summary.slice(0, 80)}`)
}

phase('Verify')
const verify = await agent(`${COMMON}

YOU ARE THE FINAL VERIFIER. Fresh eyes. (1) Build. (2) Full suite. (3) Smoke in a fresh tmp project with ULTRACODEX_CRONTAB_FILE: add a budgeted run schedule (--budget 200k) → spec has it, stub exec receives --budget 200k exactly once; add an unbudgeted run schedule → warning on stderr (capture and quote it), exit 0; add with in-command "--budget 100k" → no warning, no duplicate injection; add --budget with a non-run command → clear error; schedule ls --json shows budgets; the human table renders identically in shape to docs/schedule.md's documented columns. (4) git status confined to src/schedule/, src/cli.ts, src/tui/, tests/, docs/. pass = all four.`, { label: 'verify:sched-budget', phase: 'Verify', schema: VERIFY, effort: 'high' })

return { status: verify && verify.pass && gate && gate.pass ? 'green' : 'needs-review', impl, gate, verify }
