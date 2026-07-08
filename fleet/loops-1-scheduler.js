// Loops pillar, run 1/3 — the schedule manager.
export const meta = {
  name: 'loops-1-scheduler',
  description: 'Build ultracodex schedule add|ls|rm|pause|resume|exec: crontab ownership, until-done retirement, missed-run nudge, doctor section, docs',
  phases: [
    { title: 'Implement', detail: 'src/schedule + CLI wiring + tests + docs' },
    { title: 'Gate', detail: 'contract review, fix loop ≤2 rounds' },
    { title: 'Verify', detail: 'build + full suite + headless smoke' },
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

const COMMON = `Working dir = the ultracodex repo root. TypeScript sources in src/, vitest tests in tests/ (mirror tests/cli.test.ts conventions: tmpdir per test, afterEach cleanup, no global state). NO new runtime dependencies (commander/picocolors/ink only). Use package.json scripts for build/test (check the "scripts" field for exact names). NEVER run git commit or touch the git index; check hygiene with git status --short -uall. Do not bump the package version. RETURN raw data per your schema — your final text is parsed, not read by a human.`

// ————— FROZEN CONTRACT (parent-authored; the arbiter for the gate) —————
const CONTRACT = `
SCHEDULER CONTRACT v1 (frozen — deviations need a "decisions" entry with rationale):

Principle: a schedule MANAGER, never a daemon. ultracodex owns tagged crontab
lines; cron does the waking. No background process of ours ever persists.

STATE (per project): <projectDir>/.ultracodex/schedules/<name>.json (spec),
<name>.log (append-only exec log), <name>.lock (pid lockfile during exec).
Spec JSON: { version: 1, name, createdAt (ISO), schedule: {kind: "every"|"daily"|"cron", value},
cronExpr, command: string[] (argv as given after --), projectDir, untilDone: bool,
maxRuns: number|null, status: "active"|"paused"|"retired", retiredReason: string|null,
runs: number, lastRun: {ts, ok, exitCode, runId?, done?}|null,
env: {PATH}, nodeBin (process.execPath at add), cliPath (absolute path to our CLI entry at add) }.

COMMANDS (commander subcommand group on the existing program; reuse the act() wrapper):
- schedule add <name> (--every <dur> | --daily <HH:MM> | --cron "<5-field expr>") [--until-done] [--max-runs <n>] -- <command...>
  name: slug /^[a-z0-9][a-z0-9-]*$/, unique per project (error on dup).
  --every: <N>m (1-59) or <N>h (1-23) → cron "*/N * * * *" / "0 */N * * *".
  --daily HH:MM → "MM HH * * *". --cron: raw 5-field escape hatch (validate field count only).
  Exactly one of the three (error otherwise).
  <command...>: if first token is "run", the script ref is resolved NOW via the existing
  resolveScript() (fail add if unresolvable) and exec will invoke our own CLI for it;
  any other argv is scheduled as-is (PATH lookup at exec, shell:false).
  --until-done requires a "run" command (error otherwise).
  Captures env.PATH, nodeBin, cliPath at add time (cron's env is bare).
  Installs the crontab line (see OWNERSHIP). Prints one confirmation line incl. the cron expr.
- schedule ls [--json]: table — name, human schedule ("every 5m" / "daily 18:30" / raw expr),
  status, runs, last run (relative ts + ok/fail glyph ✔/✖), and for until-done schedules the
  done state. --json emits the spec array.
- schedule rm <name>: remove crontab line + spec file; append a final "removed" line to the log
  (log file is kept for post-mortems).
- schedule pause <name>: remove crontab line, status="paused", keep spec.
- schedule resume <name>: reinstall crontab line, status="active". Error if retired.
- schedule exec <name>: HIDDEN (registered but not shown in help; commander supports hidden).
  Behavior: (1) load spec; paused/retired → log "skipped: <status>", exit 0.
  (2) lockfile with pid; if held by a live pid → log "skipped: previous run still active", exit 0;
  stale (dead pid) → steal. (3) chdir projectDir, merge spec env.PATH into process env.
  (4) "run" commands: spawn [nodeBin, cliPath, "run", <resolved ref>, ...restArgs, "--json"],
  capture stdout; READ src/cli.ts --json output shape from the code and parse runId/status/result
  from what it actually prints. Other argv: spawn as-is. Append a log line:
  ISO ts · exit code · runId if any · status · done flag if present.
  (5) update spec lastRun/runs. (6) until-done: if the run result value is an object with
  done === true → retire (remove cron line, status="retired", retiredReason="done").
  If maxRuns reached → retire with retiredReason="max-runs". Retirement is logged.
  (7) exec never writes to stdout/stderr (everything goes to the log); exits 0 unless the spec
  itself is unreadable. Rationale: cron mails on output.

CRONTAB OWNERSHIP: module src/schedule/crontab.ts with readCrontab()/writeCrontab(text).
Real impl: execFileSync("crontab", ["-l"]) (treat "no crontab for" stderr/exit as empty) and
"crontab -" via stdin. TEST/DRY-RUN HOOK: if env ULTRACODEX_CRONTAB_FILE is set, read/write that
file instead of the crontab binary (empty/missing file = empty crontab). Every line we own ends
with tag "# ultracodex:<name>@<hash8>" where hash8 = first 8 hex chars of sha256(projectDir) —
two projects with the same schedule name never collide. Managing a schedule rewrites ONLY lines
bearing its exact tag; all other lines (foreign or other schedules) are preserved byte-for-byte.
Line shape: <cronExpr> cd '<projectDir>' && '<nodeBin>' '<cliPath>' schedule exec <name> >>'<logPath>' 2>&1 # <tag>
Single-quote all paths; escape % as \\% (cron treats % specially).

MISSED-RUN NUDGE: checkMissedSchedules(projectDir): string[] — for active "every"/"daily"
schedules where now - (lastRun?.ts ?? createdAt) exceeds 1.5× the interval (daily: interval=24h),
return one warning line each ("schedule '<name>' looks overdue (expected ~<t>) — is cron running?").
Raw-cron schedules are exempt (no next-run math in v1). Call it from the ls action and the run
action (print dim to stderr, skip under --json). Do NOT touch the TUI in this run — TUI surfaces
land in a later run.

DOCTOR: add a "schedules" section to doctorAction() using the existing report()/info() helpers:
crontab binary reachable (or ULTRACODex_CRONTAB_FILE override active — spell env var correctly);
per active spec, exactly one tagged line present (report drift per schedule);
orphaned tagged lines for this project with no spec → warn; schedules dir writable.
Missing schedules dir = fine (info "no schedules").

TESTS (hermetic — the real crontab binary must NEVER be touched; every test sets
ULTRACODEX_CRONTAB_FILE to a tmp path): add/ls/rm/pause/resume full lifecycle incl. spec+line
shape; dup-name, bad slug, bad --every, --until-done without run → errors; every/daily→expr
mapping; foreign crontab lines preserved byte-for-byte; tag isolation across two project dirs;
exec with an arbitrary command (node -e writing a marker file) updates lastRun+log; exec lock
skip; paused skip; until-done retirement (point cliPath at a stub node script that prints a
{"done":true,...} run result in the real --json shape) removes the cron line and retires; max-runs
retirement; nudge math (overdue vs fresh vs raw-cron exempt); cli.test.ts surface test gains the
schedule group. Keep the full existing suite green.

DOCS: docs/schedule.md (H1 "Scheduling runs" + H2 sections: why a manager not a daemon; quick
start; command reference; the --until-done contract — a run result object with done:true retires
the schedule; how crontab is managed — tags, one line per schedule, foreign lines untouched;
missed-run nudges; testing with ULTRACODEX_CRONTAB_FILE; limitations — cron's bare env, local
time, macOS Full Disk Access note, no log rotation, launchd/systemd planned). Add the row to
docs/README.md's table and the command list in docs/operations.md. Match the existing docs voice.
`

phase('Implement')
const impl = await agent(`${COMMON}

YOUR ASSIGNMENT — implement the ultracodex scheduler exactly per the frozen contract below. New code in src/schedule/ (crontab.ts, spec.ts, exec.ts or similar — your layout call, record it in decisions), wired into src/cli.ts buildProgram(). Read src/cli.ts, src/rundir.ts, src/constants.ts first; reuse stateDir()/CliError/act() patterns. Then tests, then docs.
${CONTRACT}
Verify before returning: build script green, full vitest suite green, plus a manual headless lifecycle smoke in a tmp dir with ULTRACODEX_CRONTAB_FILE (paste the ls table into "verified").`, { label: 'impl:scheduler', phase: 'Implement', schema: REPORT, effort: 'xhigh' })
if (!impl) return { status: 'blocked', at: 'impl' }
log(`impl: ${impl.summary.slice(0, 100)}`)

let gate = null
for (let round = 1; round <= 3; round++) {
  gate = await agent(`${COMMON}

YOU ARE THE GATE (round ${round}). Adversarially review the scheduler implementation against the frozen contract below. Read the diff (git status --short -uall + git diff), the new sources, and the tests. Hunt for: contract deviations; crontab safety holes (foreign-line clobbering, unquoted paths, % handling, tag collisions); lock/stale-pid races; until-done parsing that guesses the --json shape instead of matching src/cli.ts; tests that touch the real crontab; missing error paths; docs drift. Run the build and the full test suite yourself — a red suite is an automatic fail. pass=true ONLY if zero blocker/major issues.
${CONTRACT}`, { label: `gate:scheduler-r${round}`, phase: 'Gate', schema: GATE, effort: 'xhigh' })
  if (!gate) return { status: 'blocked', at: `gate-r${round}`, impl }
  log(`gate r${round}: ${gate.pass ? 'PASS' : `${gate.issues.length} issues`} — ${gate.summary.slice(0, 80)}`)
  if (gate.pass) break
  if (round === 3) return { status: 'gate-exhausted', impl, gate }
  const fixes = gate.issues.filter(i => i.severity !== 'minor')
  if (fixes.length === 0) break
  const fix = await agent(`${COMMON}

YOUR ASSIGNMENT — fix EXACTLY these gate findings on the scheduler (round ${round}); no drive-by refactors. Findings (file · issue · required fix):
${fixes.map(i => `- [${i.severity}] ${i.file}: ${i.issue} → ${i.fix}`).join('\n')}

The frozen contract (arbiter):
${CONTRACT}
Verify: build + full vitest suite green before returning.`, { label: `fix:scheduler-r${round}`, phase: 'Gate', schema: REPORT, effort: 'xhigh' })
  if (!fix) return { status: 'blocked', at: `fix-r${round}`, impl, gate }
  log(`fix r${round}: ${fix.summary.slice(0, 80)}`)
}

phase('Verify')
const verify = await agent(`${COMMON}

YOU ARE THE FINAL VERIFIER. Fresh eyes, no prior context. (1) Run the build script — buildOk. (2) Run the FULL vitest suite — testsOk. (3) Headless smoke in a fresh tmp project dir with ULTRACODEX_CRONTAB_FILE=/tmp/ucx-smoke-crontab: schedule add smoke-a --every 5m -- node -e "1" ; add smoke-b --daily 18:30 --until-done --max-runs 3 -- run <a trivial script you create in the tmp dir> ; ls (table sane?) ; pause smoke-a (line gone, spec kept?) ; resume smoke-a ; rm both (crontab file clean, no orphan tags?). Also seed the fake crontab with a foreign line first and confirm it survives untouched byte-for-byte. (4) git status --short -uall — no stray files outside src/schedule, src/cli.ts, tests/, docs/, package artifacts. pass = all four. Report exact failures in details if any.`, { label: 'verify:scheduler', phase: 'Verify', schema: VERIFY, effort: 'high' })

return { status: verify && verify.pass && gate && gate.pass ? 'green' : 'needs-review', impl, gate, verify }
