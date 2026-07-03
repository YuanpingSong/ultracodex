// The canonical convergence loop: a builder drafts, an adversarial verifier
// judges against the requirements, and feedback flows back until the verifier
// passes it — or you run out of rounds or budget.
//
// Loops are ordinary JavaScript. The three safety rails every loop needs:
//   1. null-check every agent result (failed agents resolve null, never throw)
//   2. guard unbounded loops on budget (remaining() is Infinity without --budget)
//   3. cap rounds explicitly (the 1000-agent lifetime cap is a backstop, not a plan)
//
// Run it:   ultracodex run examples/03-builder-verifier.js --watch --budget 200k
// Try cross-vendor judging: route "verify:*" = "claude" in .ultracodex/config.toml —
// the builder and its judge come from different model families, same loop.
export const meta = {
  name: 'builder-verifier',
  description: 'Builder drafts, adversarial verifier judges, feedback loops until pass / max rounds / budget',
  phases: [
    { title: 'Build', detail: 'builder drafts or repairs the artifact' },
    { title: 'Verify', detail: 'adversarial judge checks every requirement' },
  ],
}

const REQUIREMENTS = args?.requirements ??
  'Write a portable POSIX sh one-liner that prints the 5 largest regular files under the current directory, largest first, with human-readable sizes. It must not choke on filenames with spaces.'
const MAX_ROUNDS = args?.maxRounds ?? 3

const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'true only if EVERY requirement is met' },
    issues: { type: 'array', items: { type: 'string' }, description: 'concrete defects; empty when pass' },
  },
  required: ['pass', 'issues'],
}

let artifact = null
let verdict = null
let rounds = 0

for (let round = 1; round <= MAX_ROUNDS; round++) {
  rounds = round

  phase('Build')
  const feedback = verdict && !verdict.pass
    ? `\n\nA reviewer rejected the previous attempt. Fix EVERY issue:\n- ${verdict.issues.join('\n- ')}\n\nPrevious attempt:\n${artifact}`
    : ''
  const built = await agent(
    `${REQUIREMENTS}${feedback}\n\nReturn ONLY the deliverable itself, no commentary.`,
    { label: `build:round-${round}`, phase: 'Build' },
  )
  if (built === null) {                       // rail 1: builder can fail
    log(`round ${round}: builder failed, retrying fresh`)
    continue
  }
  artifact = built

  phase('Verify')
  verdict = await agent(
    `Requirements:\n${REQUIREMENTS}\n\nCandidate:\n${artifact}\n\n` +
    `Be adversarial: hunt for any requirement not met, any edge case that breaks it. Return via the schema.`,
    { label: `verify:round-${round}`, phase: 'Verify', schema: VERDICT },
  )
  if (verdict === null) {                     // rail 1: the judge can fail too
    log(`round ${round}: verifier failed — treating as not passed`)
    verdict = { pass: false, issues: ['verifier unavailable'] }
  }

  log(`round ${round}: ${verdict.pass ? 'PASS' : verdict.issues.length + ' issue(s)'}`)
  if (verdict.pass) break
  if (budget.total && budget.remaining() < 20_000) {   // rail 2: budget governor
    log('budget nearly exhausted — stopping with best attempt so far')
    break
  }
}

return { artifact, verdict, rounds, converged: Boolean(verdict && verdict.pass) }
