// Loops pillar, run 2/3 — packaged loop workflows (`goal`, `loop`) + builtin
// resolution tier + round-label grammar in the authoring skill + docs/loops.md.
export const meta = {
  name: 'loops-2-packaged',
  description: 'Ship packaged goal/loop workflows resolvable by run <name>, builtin resolution tier, skill round-grammar, docs/loops.md vocabulary page',
  phases: [
    { title: 'Implement', detail: 'workflows/goal.js + loop.js, resolver tier, tests, skill, docs' },
    { title: 'Gate', detail: 'contract review, fix loop ≤2 rounds' },
    { title: 'Verify', detail: 'build + full suite + strict-validate + live resolution smoke' },
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

const COMMON = `Working dir = the ultracodex repo root. TypeScript sources in src/, vitest tests in tests/ (mirror existing conventions: tmpdir per test, afterEach cleanup, no global state). NO new runtime dependencies. Use package.json scripts for build/test (check the "scripts" field for exact names). NEVER run git commit or touch the git index; check hygiene with git status --short -uall. Do not bump the package version. RETURN raw data per your schema — your final text is parsed, not read by a human.`

// ————— FROZEN CONTRACT (parent-authored; the arbiter for the gate) —————
const CONTRACT = `
PACKAGED LOOPS CONTRACT v1 (frozen — deviations need a "decisions" entry with rationale):

A. BUILTIN RESOLUTION TIER. resolveScript() in src/cli.ts gains a third tier:
   (1) explicit path relative to project dir, (2) project-saved
   <projectDir>/.ultracodex/workflows/<name>.js, (3) package builtin
   <packageRoot>/workflows/<name>.js. Project-saved SHADOWS builtin (a user
   can override "goal" locally). Locate packageRoot the same way the
   sync-skills command locates the package's skills/ directory — reuse or
   extract that helper, do not invent a second mechanism. Update the
   cannot-resolve error message to name all three locations. Add "workflows"
   to package.json "files" so builtins ship in the npm tarball. The repo's
   workflows/ directory must contain EXACTLY goal.js and loop.js.

B. BOTH BUILTINS ARE PURE AGENT SCRIPT: plain-JS ESM, pure-literal meta
   export, no imports, no fs, no Date.now/Math.random, only the injected
   globals (agent/parallel/pipeline/phase/log/args/budget/workflow).
   \`ultracodex validate --strict workflows/goal.js\` (and loop.js) MUST pass —
   these files are the portability showcase and must run unmodified on any
   conforming engine. No engine-specific agent() options. Invalid/missing
   required args → throw new Error with a usage message naming the required
   args (a failed run is visible; a done:false return would silently
   reschedule forever under schedule --until-done).

C. workflows/goal.js — the builder-verifier loop ("/goal analog").
   args (FROZEN): {
     task: string (required) — what to build/do;
     criteria: string (required) — explicit, verifier-checkable acceptance criteria;
     maxRounds?: integer default 4;
     context?: string — optional paths/notes handed to the builder;
     builderModel?: string; verifierModel?: string — pass a model option to
       the respective agent ONLY when provided (conditional spread; engine
       defaults otherwise);
     budgetFloor?: integer default 20000 — when budget.total is set and
       budget.remaining() < budgetFloor before a round, stop.
   }
   Behavior: round N builder agent labeled "goal:build-r<N>" with
   { phase: 'Build' }; round 1 prompt = task + criteria + context; round N>1
   prompt additionally includes the previous verifier's issues VERBATIM and
   instructs targeted fixes, no drive-by refactors. Then verifier agent
   labeled "goal:verify-r<N>" with { phase: 'Verify' } and schema
   { verdict: 'approved'|'rejected', issues: string[],
     criteria: [{criterion, pass, note}] } — prompted as a SKEPTIC: verify
   each criterion mechanically by reading/running the work itself, never by
   trusting the builder's claims; reject when uncertain. Stop on approved,
   maxRounds, or budget floor. A null agent() return (skip/terminal error)
   stops the loop. log() one line per round with the verdict.
   Return (FROZEN): { done: boolean (verdict approved), rounds: number,
     verdict: 'approved'|'rejected'|'exhausted', issues: string[] (last
     verifier's, [] when approved),
     history: [{round, verdict, issues}] }.
   'exhausted' = stopped by budget floor or null agent; cap-out with a final
   rejection stays 'rejected'. done:true makes the script compose with
   schedule --until-done out of the box.

D. workflows/loop.js — the until-dry loop.
   args (FROZEN): {
     find: string (required) — finder instructions for one round;
     verify?: string — optional adversarial verifier instructions; when
       omitted, fresh findings are accepted unverified;
     dryRounds?: integer default 2 — consecutive rounds with zero fresh
       findings needed to converge;
     maxRounds?: integer default 8;
     dedupBy?: string default 'title' — finding field used as the dedup key;
     finderModel?: string; verifierModel?: string (conditional spread as in C);
     budgetFloor?: integer default 20000.
   }
   Behavior: round N finder labeled "loop:find-r<N>" { phase: 'Find' },
   schema { findings: [{ title: string, detail: string, location?: string }] };
   the prompt includes the list of already-seen dedup keys with an explicit
   "do not re-report these". Dedup key = lowercased finding[dedupBy], falling
   back to title, falling back to JSON of the finding; dedup against
   everything SEEN, not just confirmed (judge-rejected findings must not
   reappear). Zero fresh → dry counter increments; any fresh → resets to 0.
   When args.verify is set and fresh findings exist: verifier labeled
   "loop:verify-r<N>" { phase: 'Verify' }, schema
   { verdicts: [{ title, real: boolean, note: string }] }; keep only
   real===true. Stop when dry >= dryRounds (done:true), maxRounds
   (done:false), budget floor (done:false), or null agent (done:false).
   log() one line per round: fresh/confirmed/dry counts.
   Return (FROZEN): { done: boolean, rounds: number, dry: boolean,
     findings: [...confirmed findings], seenCount: number }.

E. TESTS. (1) CLI-level: validate --strict passes for both builtins;
   resolveScript resolves "goal" from a tmp project with no local copy, and
   a project-saved goal.js shadows the builtin. (2) Execution-level: study
   tests/runner.test.ts + tests/helpers.ts and drive BOTH scripts end to end
   with scripted fake agent results. goal: verifier rejects round 1 then
   approves round 2 → assert rounds===2, done===true, history shape, and the
   EXACT label sequence goal:build-r1, goal:verify-r1, goal:build-r2,
   goal:verify-r2 in the journal. loop: round 1 yields findings (including a
   duplicate to be deduped), rounds 2–3 yield none → assert dry convergence,
   done===true, seenCount, confirmed findings, and loop:find-r<N> labels.
   Also: goal with missing args fails the run with the usage error. Keep the
   full existing suite green.

F. EXAMPLE ALIGNMENT. examples/actor-critic-loop: bring its agent labels
   into the round grammar (role labels ending -r<N>, e.g. draft-r2 /
   critique-r2), keeping behavior and any parity tests green. Touch nothing
   else about it.

G. AUTHORING SKILL. skills/agent-script-authoring/SKILL.md, in the loops
   section (§6, after the existing loop pattern): add a short "Round labels"
   paragraph blessing the grammar — loop agents are labeled
   <loop>:<role>-r<N> (single-loop scripts may use bare <role>-r<N>; phase
   titles like "Round 3" fold too); engines group these into round-based
   loop views; a verifier that returns a top-level verdict/pass/approved
   field gets its verdict surfaced in trajectory displays; returning
   { done: true } from the script makes it compose with scheduled
   --until-done runs. Mention run goal / run loop as packaged references.
   Keep it under ~12 lines, match the skill's voice.

H. DOCS. New docs/loops.md (H1 "Loops"): loops are plain JS while/for — why
   there is no loop primitive (dual-runnability, one format); a vocabulary
   mapping table for users arriving from Claude Code's loop taxonomy
   (goal-based → run goal; time-based → ultracodex schedule, incl.
   --until-done; turn-based → interactive sessions, out of scope — one
   line); full args reference tables + CLI and nested workflow() examples
   for goal and loop; the round-label grammar (both forms); the convergence
   discipline (worker ≠ evaluator, deterministic criteria, capped rounds,
   budget as governor). Cross-link docs/schedule.md for --until-done.
   Add the row to docs/README.md's table. Document ONLY behavior that exists
   in this repo after your change — no references to unreleased features,
   internal plans, or internal ADR numbers. Match the existing docs voice.
`

phase('Implement')
const impl = await agent(`${COMMON}

YOUR ASSIGNMENT — implement packaged loop workflows exactly per the frozen contract below. Read src/cli.ts (resolveScript, sync-skills), tests/runner.test.ts, tests/helpers.ts, examples/actor-critic-loop/, skills/agent-script-authoring/SKILL.md, and docs/README.md first. Order: resolver tier → the two builtins → tests → example alignment → skill paragraph → docs.
${CONTRACT}
Verify before returning: build green, full vitest suite green, validate --strict green on both builtins, and a manual smoke: from a tmp dir, resolve-and-validate "goal" by name via the CLI (paste the command + output into "verified").`, { label: 'impl:packaged', phase: 'Implement', schema: REPORT, effort: 'xhigh' })
if (!impl) return { status: 'blocked', at: 'impl' }
log(`impl: ${impl.summary.slice(0, 100)}`)

let gate = null
for (let round = 1; round <= 3; round++) {
  gate = await agent(`${COMMON}

YOU ARE THE GATE (round ${round}). Adversarially review the packaged-loops implementation against the frozen contract below. Read the diff (git status --short -uall + git diff), the two builtins, the resolver change, tests, skill, docs. Hunt for: strict-validate violations or engine-specific options in the builtins; args/return shapes deviating from the FROZEN blocks; label grammar deviations (exact strings goal:build-r<N> etc.); dedup against confirmed instead of seen; verifier prompts that trust builder claims; conditional-spread violations (model: undefined leaking into agent opts); resolver precedence bugs (builtin shadowing project files would be a blocker); package.json files omissions; execution tests that parse but never run the scripts; docs describing behavior that does not exist. Run build + full suite + validate --strict on both builtins yourself — any red is an automatic fail. pass=true ONLY if zero blocker/major issues.
${CONTRACT}`, { label: `gate:packaged-r${round}`, phase: 'Gate', schema: GATE, effort: 'xhigh' })
  if (!gate) return { status: 'blocked', at: `gate-r${round}`, impl }
  log(`gate r${round}: ${gate.pass ? 'PASS' : `${gate.issues.length} issues`} — ${gate.summary.slice(0, 80)}`)
  if (gate.pass) break
  if (round === 3) return { status: 'gate-exhausted', impl, gate }
  const fixes = gate.issues.filter(i => i.severity !== 'minor')
  if (fixes.length === 0) break
  const fix = await agent(`${COMMON}

YOUR ASSIGNMENT — fix EXACTLY these gate findings (round ${round}); no drive-by refactors. Findings (file · issue · required fix):
${fixes.map(i => `- [${i.severity}] ${i.file}: ${i.issue} → ${i.fix}`).join('\n')}

The frozen contract (arbiter):
${CONTRACT}
Verify: build + full suite + validate --strict on both builtins green before returning.`, { label: `fix:packaged-r${round}`, phase: 'Gate', schema: REPORT, effort: 'xhigh' })
  if (!fix) return { status: 'blocked', at: `fix-r${round}`, impl, gate }
  log(`fix r${round}: ${fix.summary.slice(0, 80)}`)
}

phase('Verify')
const verify = await agent(`${COMMON}

YOU ARE THE FINAL VERIFIER. Fresh eyes, no prior context. (1) Build script — buildOk. (2) Full vitest suite — testsOk. (3) Smoke: validate --strict workflows/goal.js and workflows/loop.js; from a FRESH tmp project dir, run the CLI's validate against the bare name "goal" (builtin resolution) and confirm it resolves; then drop a trivial local .ultracodex/workflows/goal.js in the tmp project and confirm the local one shadows the builtin (validate output differs or use show/inspect to prove which file resolved). Confirm npm pack --dry-run lists workflows/goal.js and workflows/loop.js. (4) git status --short -uall — changes confined to src/, tests/, workflows/, examples/actor-critic-loop/, skills/, docs/, package.json. pass = all four. Report exact failures in details.`, { label: 'verify:packaged', phase: 'Verify', schema: VERIFY, effort: 'high' })

return { status: verify && verify.pass && gate && gate.pass ? 'green' : 'needs-review', impl, gate, verify }
