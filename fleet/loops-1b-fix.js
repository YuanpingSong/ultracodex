// Loops pillar, run 1b — targeted continuation of loops-1-scheduler (gate-exhausted
// at r3 with 2 major + 1 minor). Fix the exact findings, re-gate on the FULL
// contract (round numbering continues at r4), then run the final verifier.
export const meta = {
  name: 'loops-1b-scheduler-fix',
  description: 'Fix remaining scheduler gate findings (lock atomicity, silent exec error path, crontab byte preservation), re-gate, verify',
  phases: [
    { title: 'Fix', detail: 'the three r3 findings, nothing else' },
    { title: 'Gate', detail: 'full-contract review, rounds r4-r6' },
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


const FINDINGS = `
- [major] src/schedule/exec.ts:68 — The pid lock is not atomically created with readable pid contents. fs.writeFileSync(..., flag: "wx") creates the .lock path before the pid bytes are necessarily visible; a concurrent schedule exec can see an empty/partial lock, treat readLockPid() === null as stale, remove it under the steal path, and run while the original process also continues. FIX: create populated lock files atomically — write the pid to a unique temp file and fs.linkSync() it to <name>.lock (unlink the temp after); on EEXIST read the pid, and NEVER treat a null/unreadable pid as stale without a settle window (re-read after ~100ms; steal only if still unreadable or the pid is dead). Keep stale stealing serialized after lock contents are stable.
- [major] src/cli.ts:554 — Hidden schedule exec is still wrapped by the generic act() handler: an unreadable spec throws through scheduleExecAction(), act() writes "error: ..." to stderr, and cron mails it. Contract: exec NEVER writes stdout/stderr; nonzero exit only when the spec is unreadable. FIX: handle the unreadable-spec path inside the action without throwing to act() — set process.exitCode = 1 and return silently; every readable-spec failure goes to the schedule log only.
- [minor] src/schedule/crontab.ts:104 — Foreign crontab text not preserved byte-for-byte when the existing crontab's final foreign line lacks a trailing newline: install adds a separator newline that removal later leaves behind. FIX: preserve the non-owned content's trailing-newline state exactly — a separator inserted solely to append an owned line is removed together with that line.
`

phase('Fix')
const fix = await agent(`${COMMON}

YOUR ASSIGNMENT — fix EXACTLY these three gate findings from the previous round; no drive-by refactors, no new features. Add/adjust tests so each fix is pinned (lock atomicity: simulate a contender seeing an empty lock; exec silent-error path: unreadable spec produces empty stdout+stderr and exit code 1; crontab: no-trailing-newline foreign content survives install+remove byte-for-byte).
${FINDINGS}
The frozen contract (arbiter):
${CONTRACT}
Verify: build + full vitest suite green before returning.`, { label: 'fix:scheduler-r3', phase: 'Fix', schema: REPORT, effort: 'xhigh' })
if (!fix) return { status: 'blocked', at: 'fix' }
log(`fix: ${fix.summary.slice(0, 100)}`)

let gate = null
for (let round = 4; round <= 6; round++) {
  gate = await agent(`${COMMON}

YOU ARE THE GATE (round ${round}; rounds 1-3 happened in a previous run — the three known findings from r3 are listed below and should now be fixed). Adversarially review the FULL scheduler implementation against the frozen contract below. Read the diff (git status --short -uall + git diff), the sources under src/schedule/, the cli.ts wiring, the tests. Verify the three prior findings are actually fixed (test them, don't trust), then hunt fresh: crontab safety (foreign-line clobbering, quoting, % escaping, tag collisions), lock/stale races, until-done parsing vs the real --json shape, tests touching the real crontab, missing error paths, docs drift. Run the build and the full test suite yourself. pass=true ONLY if zero blocker/major issues.

Prior r3 findings (must be fixed):
${FINDINGS}
${CONTRACT}`, { label: `gate:scheduler-r${round}`, phase: 'Gate', schema: GATE, effort: 'xhigh' })
  if (!gate) return { status: 'blocked', at: `gate-r${round}`, fix }
  log(`gate r${round}: ${gate.pass ? 'PASS' : `${gate.issues.length} issues`} — ${gate.summary.slice(0, 80)}`)
  if (gate.pass) break
  if (round === 6) return { status: 'gate-exhausted', fix, gate }
  const fixes = gate.issues.filter(i => i.severity !== 'minor')
  if (fixes.length === 0) break
  const fixN = await agent(`${COMMON}

YOUR ASSIGNMENT — fix EXACTLY these gate findings (round ${round}); no drive-by refactors. Findings (file · issue · required fix):
${fixes.map(i => `- [${i.severity}] ${i.file}: ${i.issue} → ${i.fix}`).join('\n')}

The frozen contract (arbiter):
${CONTRACT}
Verify: build + full vitest suite green before returning.`, { label: `fix:scheduler-r${round}`, phase: 'Gate', schema: REPORT, effort: 'xhigh' })
  if (!fixN) return { status: 'blocked', at: `fix-r${round}`, fix, gate }
  log(`fix r${round}: ${fixN.summary.slice(0, 80)}`)
}

phase('Verify')
const verify = await agent(`${COMMON}

YOU ARE THE FINAL VERIFIER. Fresh eyes, no prior context. (1) Run the build script — buildOk. (2) Run the FULL vitest suite — testsOk. (3) Headless smoke in a fresh tmp project dir with ULTRACODEX_CRONTAB_FILE=/tmp/ucx-smoke-crontab: schedule add smoke-a --every 5m -- node -e "1" ; add smoke-b --daily 18:30 --until-done --max-runs 3 -- run <a trivial script you create in the tmp dir> ; ls (table sane?) ; pause smoke-a (line gone, spec kept?) ; resume smoke-a ; rm both (crontab file clean, no orphan tags?). Also seed the fake crontab with a foreign line WITHOUT a trailing newline first and confirm it survives the full lifecycle untouched byte-for-byte. Exercise schedule exec once against an unreadable spec and confirm stdout+stderr are empty with exit code 1. (4) git status --short -uall — no stray files outside src/schedule, src/cli.ts, src/rundir.ts, tests/, docs/, package artifacts, fleet/. pass = all four. Report exact failures in details if any.`, { label: 'verify:scheduler', phase: 'Verify', schema: VERIFY, effort: 'high' })

return { status: verify && verify.pass && gate && gate.pass ? 'green' : 'needs-review', fix, gate, verify }
