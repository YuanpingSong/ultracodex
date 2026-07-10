// Fixes for the new-user simulation findings (loops + scheduler), each with a
// pinning test. Findings are verbatim from the user-sim friction reports.
export const meta = {
  name: 'user-sim-fixes',
  description: 'Fix the user-sim findings: false-dead watcher race, until-dry loops render as failed, --every non-divisors, verdict text, ended-glyph, single-round loops, docs budgets',
  phases: [
    { title: 'Fix', detail: 'seven findings, each pinned by a test' },
    { title: 'Gate', detail: 'adversarial review, fix loop' },
    { title: 'Verify', detail: 'build + suite + repro checks' },
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

const COMMON = `Working dir = the ultracodex repo root. TypeScript in src/, vitest tests in tests/. NO new runtime dependencies. Use package.json scripts for build/test. NEVER run git commit. Do not bump the package version. RETURN raw data per your schema.`

const CONTRACT = `
USER-SIM FIX CONTRACT (each finding is verbatim user evidence; every fix
lands with a test that fails before and passes after):

F1 [major] FALSE-DEAD WATCHER RACE. Evidence: a successful ~19s run —
   "ultracodex ls showed the goal as dead and --json returned
   {status:failed, error:runner exited before run_end}. Without restarting
   it, the same run later …" (it had completed; journal contains run_end,
   result.json exists). Reproduced twice independently today. Root cause
   lives in the watch/--json path in src/cli.ts (watchToEnd or its
   equivalent) and possibly listRuns dead-detection in src/rundir.ts: when
   the runner's pid disappears, the watcher declares "dead" without one
   final full re-read of the journal, losing the race against the
   runner's last flush. FIX: on pid-death, re-read the journal completely
   (and once more after a short grace, ~250ms, if no run_end) before
   declaring dead; apply the same final-re-read discipline to any code
   path that reports "dead" (ls, show --wait, --json). TEST: simulate a
   runner that writes run_end and exits immediately; assert the watcher
   returns the ok result, never the dead error. Also pin ls: a run dir
   with run_end and a dead pid is "ok", not "dead".

F2 [major] UNTIL-DRY LOOPS RENDER AS FAILED. Evidence: a dry-converged
   packaged loop (result done:true) rendered "loop · ✖ ended after 3
   rounds (not converged)". The fold's loop status only counts an
   approved last-round verdict as convergence; until-dry's dry rounds
   produce no verdicts. FIX in src/tui/loops.ts (+ callers): when the run
   has ended and its run-level RESULT is an object with done === true,
   the loop is "converged" (display "done after N rounds" or "converged
   after N rounds" — pick one and use it consistently) regardless of
   round verdicts. detectLoops needs access to the run result: extend the
   reader parameter or add an optional runResult argument — keep loops.ts
   pure (callers read result.json via the existing capped file reader).
   TEST: synthetic until-dry state (rounds with unknown verdicts) + a
   done:true result → status converged; done:false/absent → unchanged.

F3 [major] --every NON-DIVISORS ARE NOT UNIFORM. Evidence: "--every 59m
   installed */59 * * * *, which fires at minutes 00 and 59 — alternating
   59-minute and 1-minute gaps." FIX in src/schedule/spec.ts parseEvery:
   minutes must divide 60 (1,2,3,4,5,6,10,12,15,20,30,60→use 1h), hours
   must divide 24 (1,2,3,4,6,8,12); reject others with a CliError naming
   the valid values and suggesting --cron for irregular cadences. Update
   docs/schedule.md's --every description accordingly. TEST: 59m and 7m
   and 5h rejected with the helpful message; 15m/30m/6h accepted;
   existing schedule tests updated if they used non-divisors.

F4 [minor] "[object Object]" VERDICT TEXT. Evidence: 'verdict: rejected —
   "[object Object]"'. In src/tui/loops.ts verdictTextFromRecord, issues
   arrays may contain OBJECTS (e.g. {severity,file,issue,fix}). FIX:
   stringify object items as their "issue" ?? "what" ?? "message" ??
   "title" field, else compact JSON; never String(obj). TEST: object
   issues render readable text.

F5 [minor] ENDED-WITHOUT-VERDICTS RENDERS AS FAILURE. Evidence: a
   successful run's fix-round series showed as "✖ … ended r2" in red
   beside its converged sibling. FIX: the "ended" status splits — last
   verdict rejected → ✖ red "ended after N rounds (not converged)"; no
   verdicts at all (all unknown) → dim "○ ended after N rounds" with no
   failure connotation (glyph/color via the existing vocabulary). Apply in
   loops.ts glyph/status helpers + wherever Loops tab rows and static
   LOOPS lines colorize. TEST: pins both variants.

F6 [minor] SINGLE-ROUND CONVERGED LOOPS ARE INVISIBLE. Evidence: "show
   <run> omitted the LOOPS section for the approved one-round goal." The
   ≥2-rounds qualification hides legitimate one-round loops. FIX: a loop
   also qualifies with a single round when (a) its stems form a
   multi-stem colon group (goal:build + goal:verify), OR (b) the round
   has a known verdict, OR (c) the run result has a boolean done. Plain
   one-shot bare "-r1" labels with no verdict stay non-loops (unchanged).
   TEST: one-round goal-style state qualifies and renders "converged
   after 1 round"; a lone unrelated foo-r1 agent still does not.

F7 [minor·docs] EXAMPLES OMIT --budget. Evidence: "README Loops example
   and both CLI examples in docs/loops.md omit --budget, although the
   convergence section says to use budget as a governor." FIX: add
   --budget to every copyable run command in README.md's Loops section
   and docs/loops.md (and docs/schedule.md examples if any lack it).
   Keep values modest (200k-300k). No test; gate eyeballs it.
`

phase('Fix')
const fix = await agent(`${COMMON}

YOUR ASSIGNMENT — implement all seven fixes per the contract below. Read src/cli.ts (watch/--json/show --wait paths), src/rundir.ts (dead detection), src/tui/loops.ts, src/tui/static.ts, src/tui/HomeView.tsx (loop rows), src/schedule/spec.ts, tests/loops.test.ts, tests/schedule.test.ts, tests/cli.test.ts first. F1 is the highest-stakes change — keep the dead-detection semantics for genuinely dead runs (no run_end after the grace re-read) intact and prove it with the existing dead-run tests still green.
${CONTRACT}
Verify before returning: build green, full vitest suite green.`, { label: 'impl:usersim-fixes', phase: 'Fix', schema: REPORT, effort: 'xhigh' })
if (!fix) return { status: 'blocked', at: 'fix' }
log(`fix: ${fix.summary.slice(0, 100)}`)

let gate = null
for (let round = 1; round <= 3; round++) {
  gate = await agent(`${COMMON}

YOU ARE THE GATE (round ${round}). Adversarially review against the contract below. For F1 especially: hunt for the inverse regression (a genuinely dead runner — killed before run_end — must STILL be reported dead; race the grace window in a test, don't trust it). For F2/F6: verify loops.ts stayed pure (no fs). For F3: confirm the divisor sets are exactly right and the error text helps. Run build + the full suite. Reproduce at least F1 (fast-exiting fake runner) and F4 (object issues) empirically. pass=true ONLY if zero blocker/major issues.
${CONTRACT}`, { label: `gate:usersim-fixes-r${round}`, phase: 'Gate', schema: GATE, effort: 'xhigh' })
  if (!gate) return { status: 'blocked', at: `gate-r${round}`, fix }
  log(`gate r${round}: ${gate.pass ? 'PASS' : `${gate.issues.length} issues`} — ${gate.summary.slice(0, 80)}`)
  if (gate.pass) break
  if (round === 3) return { status: 'gate-exhausted', fix, gate }
  const fixes = gate.issues.filter(i => i.severity !== 'minor')
  if (fixes.length === 0) break
  const fixN = await agent(`${COMMON}

Fix EXACTLY these gate findings (round ${round}); no drive-by refactors:
${fixes.map(i => `- [${i.severity}] ${i.file}: ${i.issue} → ${i.fix}`).join('\n')}

The contract (arbiter):
${CONTRACT}
Verify: build + full suite green.`, { label: `fix:usersim-fixes-r${round}`, phase: 'Gate', schema: REPORT, effort: 'xhigh' })
  if (!fixN) return { status: 'blocked', at: `fix-r${round}`, fix, gate }
  log(`fix r${round}: ${fixN.summary.slice(0, 80)}`)
}

phase('Verify')
const verify = await agent(`${COMMON}

FINAL VERIFIER, fresh eyes. (1) Build. (2) Full suite. (3) Repro the original user evidence, fixed: (a) a fake runner that writes run_end + exits instantly → run --json returns the result, ls says ok; a fake runner killed mid-run → still dead; (b) synthetic until-dry journal + done:true result → show renders the loop as converged/done, never "not converged"; (c) ultracodex schedule add x --every 59m → helpful rejection; --every 15m → accepted; (d) a verdict whose issues are objects renders readable text in show; (e) a one-round goal-style journal renders a LOOPS section. (4) git status confined to src/, tests/, docs/, README.md. pass = all four.`, { label: 'verify:usersim-fixes', phase: 'Verify', schema: VERIFY, effort: 'high' })

return { status: verify && verify.pass && gate && gate.pass ? 'green' : 'needs-review', fix, gate, verify }
