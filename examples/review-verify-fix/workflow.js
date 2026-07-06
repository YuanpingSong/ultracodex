// Adversarial review → two-skeptic verification → conditional fix.
//
// LLM reviewers overcall. This workflow buys precision with a trust pipeline:
// five dimension reviewers fan out, their findings are deduplicated in plain
// JS, and every survivor is attacked by two independent verifiers — each
// skeptical by default, each armed with a different strategy (reproduce it /
// check it against what the project actually promises). Only findings BOTH
// confirm reach the single fixer, which must leave the whole suite green.
//
// Inputs (via workflow args): { root, checks } — the repo path and its
// verification commands. Both default to something discoverable.
export const meta = {
  name: 'review-verify-fix',
  description: 'Adversarial review of a working codebase, verify findings with two skeptics each, fix confirmed ones',
  phases: [
    { title: 'Review', detail: '5 dimension reviewers in parallel' },
    { title: 'Verify', detail: '2 skeptics per deduped finding' },
    { title: 'Fix', detail: 'single fixer applies confirmed findings, suite stays green' },
  ],
}

const ROOT = args?.root ?? 'the current working directory'
const CHECKS = args?.checks ??
  "the project's typecheck, test, and build commands (discover them from the package manifest, Makefile, or CI config)"

const CTX = `Codebase under review: ${ROOT} — a working project whose verification suite is currently green (${CHECKS}; all pass before you start). Anything real you find is by definition something that suite does not catch.
Intended behavior lives in the repo itself: README and docs, doc comments on the public surface, and the tests. When implementation and documentation disagree, the disagreement is itself a finding — work out which side is wrong.`

const REVIEWER_RULES = `Find REAL problems: bugs, contract violations, races, hangs, leaks, crashes, wrong semantics. NOT style, NOT naming, NOT test coverage wishes, NOT hypotheticals that can't occur through any actual call path. For each finding give file:line, a one-line title, a concrete failure scenario (what call sequence triggers it, what goes wrong), and severity: high (wrong results/data loss/hang/crash in normal use) / medium (wrong behavior in plausible edge cases) / low (robustness gap). Max 10 findings, best first. If a dimension is genuinely clean, return fewer — do not pad.`

const DIMENSIONS = [
  {
    key: 'correctness',
    prompt: `${CTX}

REVIEW DIMENSION: core logic correctness. Read the main modules end to end and audit the actual data flow. Hunt: off-by-one and boundary bugs, wrong ordering assumptions, state mutated while being iterated, unawaited promises, races between concurrent operations, stale caches never invalidated, unicode/encoding assumptions, integer/float traps, timezone and locale sensitivity. Where reading the code leaves doubt, write tiny probe scripts under /tmp and RUN them against the project to check actual behavior — a demonstrated wrong output beats a suspicion. ${REVIEWER_RULES}`,
  },
  {
    key: 'error-handling',
    prompt: `${CTX}

REVIEW DIMENSION: error and failure paths. Audit every catch block, error return, cleanup path, and process/resource lifecycle. Hunt: swallowed errors (caught and dropped, or logged then continued into corrupt state), resources leaked on failure paths (handles, temp files, child processes, listeners), partial writes with no rollback, cleanup that itself can throw and mask the original error, retries that double-apply side effects, error messages that misreport the actual failure, exit paths that skip flushes. Simulate failures where feasible (kill a child process, make a path unwritable under /tmp) and observe what actually happens. ${REVIEWER_RULES}`,
  },
  {
    key: 'api-contract',
    prompt: `${CTX}

REVIEW DIMENSION: public API contract adherence. For every exported/public symbol, compare its documented contract (doc comment, README, type signature) against what the implementation actually does. Hunt: functions that throw where the contract says they return an error value (or vice versa), defaults that differ from the documented ones, mutation of caller-owned inputs, return shapes that vary by code path, invariants promised to callers but never enforced, accepted input silently narrower than documented. Call the public surface directly from probe scripts under /tmp wherever reading leaves doubt. ${REVIEWER_RULES}`,
  },
  {
    key: 'docs-drift',
    prompt: `${CTX}

REVIEW DIMENSION: documentation drift. Treat every executable claim in the README and docs as a test case. Hunt: setup instructions that no longer work, documented flags/options/config keys that were renamed or removed, examples that error when run verbatim, documented output that no longer matches reality, stale version/compatibility claims, links to files that moved. RUN the documented commands and examples where feasible instead of eyeballing them. A doc claim contradicted by behavior is a finding whichever side is wrong. ${REVIEWER_RULES}`,
  },
  {
    key: 'test-quality',
    prompt: `${CTX}

REVIEW DIMENSION: test suite defects — tests that pass without protecting anything. Hunt: assertions that cannot fail (a value asserted against itself, expect-no-throw around code that cannot throw), tests that codify a bug as expected behavior, mocks/fakes drifted from the real interface they imitate, order-dependent tests that pass only in suite order, sleeps standing in for synchronization, skipped/disabled tests whose TODO hides a regression, setup that swallows the very failure the test is about. Mutate the code under test in a scratch copy under /tmp and check the suite actually goes red where it should. This dimension is about defective tests, not missing coverage. ${REVIEWER_RULES}`,
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          title: { type: 'string' },
          scenario: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['file', 'title', 'scenario', 'severity'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

phase('Review')
const reviews = await parallel(
  DIMENSIONS.map((d) => () =>
    agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA })
      .then((r) => (r ? r.findings.map((f) => ({ ...f, dimension: d.key })) : [])),
  ),
)
const all = reviews.filter(Boolean).flat()
log(`${all.length} raw findings across ${DIMENSIONS.length} dimensions`)

// dedupe by file+title similarity (cheap key) — reviewers rediscover the same
// defect in different words, and verifying a duplicate is money burned twice
const seen = new Map()
for (const f of all) {
  const key = `${f.file}::${f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60)}`
  if (!seen.has(key)) seen.set(key, f)
}
const deduped = [...seen.values()]
log(`${deduped.length} after dedupe`)

phase('Verify')
const VERIFY_LENSES = [
  {
    key: 'repro',
    text: 'REPRODUCE lens: attempt to actually trigger the failure (write and RUN a minimal repro under /tmp against the project; for code-path claims, trace the exact call sequence in the source). If you cannot reproduce it or trace a concrete triggering path, it is refuted.',
  },
  {
    key: 'contract',
    text: 'CONTRACT lens: check the claim against what the project actually promises (README/docs, doc comments, type signatures, tests). If the "bug" is documented intended behavior, or the scenario cannot arise through any real caller, it is refuted.',
  },
]
// bounded fan-out: ≤10 findings × 5 dimensions in, × 2 lenses out — worst
// case ~100 verifier calls, well under the per-call and lifetime caps
const judged = await parallel(
  deduped.map((f) => () =>
    parallel(
      VERIFY_LENSES.map((lens) => () =>
        agent(
          `${CTX}\n\nA reviewer claims this bug. Your DEFAULT verdict is refuted=true — reviewers overcall, and a false positive handed to the fixer costs more than a dropped maybe. Only confirm if the evidence is solid.\n\nFINDING [${f.severity}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.title}\nScenario: ${f.scenario}\n\n${lens.text}`,
          // effort:'high' — verification is the precision gate for the whole
          // run; this is where the strongest reasoning tier pays for itself
          { label: `verify:${lens.key}:${f.title.slice(0, 36)}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' },
        ),
      ),
    ).then((vs) => ({
      f,
      verdicts: vs.filter(Boolean),
      // unanimous gate, fail-closed: BOTH lenses must return a verdict AND
      // both must decline to refute — a failed verifier (null) blocks advance
      confirmed: vs.filter(Boolean).filter((v) => !v.refuted).length === 2,
    })),
  ),
)
const confirmed = judged.filter((j) => j.confirmed).map((j) => ({ ...j.f, evidence: j.verdicts.map((v) => v.reason) }))
const rejected = judged.filter((j) => !j.confirmed).map((j) => ({ title: j.f.title, file: j.f.file, severity: j.f.severity, why: j.verdicts.map((v) => (v.refuted ? v.reason : '')).filter(Boolean).join(' | ') }))
log(`${confirmed.length}/${deduped.length} findings confirmed by both skeptics`)

phase('Fix')
if (confirmed.length === 0) {
  return { confirmed: [], rejected, fixer: null, note: 'no confirmed findings — nothing to fix' }
}
const FIXER_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    declined: { type: 'array', items: { type: 'string' } },
    typecheckOk: { type: 'boolean' },
    testsOk: { type: 'boolean' },
    buildOk: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['fixed', 'declined', 'typecheckOk', 'testsOk', 'buildOk'],
}
const fixer = await agent(
  `${CTX}\n\nYou are the sole fixer. Each finding below was confirmed by two independent adversarial verifiers. Fix ALL of them (high and medium first; a low may be declined only with a strong reason). For each fix: a minimal, surgical change that honors the project's existing contracts, plus a regression test in the existing test files where feasible. After all fixes, run ${CHECKS} — ALL must pass (fix any fallout; never weaken or delete existing tests to get green). Do NOT run git commit.\n\nCONFIRMED FINDINGS (with verifier evidence):\n${JSON.stringify(confirmed, null, 2)}`,
  { label: 'fix:confirmed', phase: 'Fix', schema: FIXER_SCHEMA },
)

return { confirmedCount: confirmed.length, confirmed: confirmed.map((c) => `[${c.severity}] ${c.file} — ${c.title}`), rejectedCount: rejected.length, rejected, fixer }
