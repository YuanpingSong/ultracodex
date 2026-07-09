// Controlled fleet-economics comparison: identical script, identical spec,
// identical acceptance — the backend is chosen by the project's [route]
// config, so the two runs differ by exactly one config line.
export const meta = {
  name: 'cmp-build',
  description: 'Build a rate-limiter module with tests from a frozen spec; gate adversarially; verify mechanically',
  phases: [
    { title: 'Build' },
    { title: 'Gate' },
    { title: 'Verify' },
  ],
}

const SPEC = `Create exactly two files in the current directory (plain Node >= 20, ESM, zero dependencies):

1. limiter.mjs — exporting two classes:
   - TokenBucket(capacity, refillPerSecond): take(n=1) returns true and deducts when n tokens are available, else returns false and deducts nothing; tokens refill continuously with elapsed time, capped at capacity; constructor rejects capacity <= 0 or refillPerSecond < 0 by throwing RangeError. The clock must be injectable: constructor accepts an optional now() function (defaults to Date.now) so tests never sleep.
   - SlidingWindow(limit, windowMs): allow() returns true and records a timestamp when fewer than limit events occurred in the trailing windowMs, else returns false and records nothing; same injectable now() rule; constructor throws RangeError on limit <= 0 or windowMs <= 0.

2. limiter.test.mjs — a node:test suite (import { test } from 'node:test') with EXACTLY these twelve test names, each genuinely testing what it names:
   "bucket grants when tokens available"
   "bucket denies when empty"
   "bucket deducts nothing on denial"
   "bucket refills with elapsed time"
   "bucket refill caps at capacity"
   "bucket take(n) is atomic for multi-token requests"
   "bucket rejects invalid constructor args"
   "window allows under the limit"
   "window denies at the limit"
   "window forgets events older than the window"
   "window records nothing on denial"
   "window rejects invalid constructor args"

All twelve must pass under: node --test limiter.test.mjs`

phase('Build')
const built = await agent(`${SPEC}

Implement both files now. Run the suite yourself and iterate until all twelve tests pass. Report which tests pass.`, { label: 'impl:limiter' })
if (built === null) return { done: false, failedAt: 'build' }

phase('Gate')
const gate = await agent(`A rate-limiter module was just implemented in the current directory against this frozen spec:

${SPEC}

You are the adversarial gate. Read limiter.mjs and limiter.test.mjs. Run: node --test limiter.test.mjs. Check every requirement mechanically: the twelve exact test names, injectable clocks actually used (no sleeps), RangeError cases, denial-deducts-nothing semantics tested for real (a test that cannot fail is a finding). Return via the schema.`, {
  label: 'gate:limiter',
  schema: {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      issues: { type: 'array', items: { type: 'string' } },
    },
    required: ['pass', 'issues'],
  },
})
if (gate === null) return { done: false, failedAt: 'gate' }
log(`gate: ${gate.pass ? 'PASS' : gate.issues.length + ' issues'}`)

if (!gate.pass && gate.issues.length) {
  phase('Build')
  const fixed = await agent(`The gate rejected the rate-limiter implementation in the current directory. Fix EXACTLY these issues, nothing else, and re-run the suite until green:

${gate.issues.map(i => '- ' + i).join('\n')}

The frozen spec:

${SPEC}`, { label: 'impl:limiter-fix' })
  if (fixed === null) return { done: false, failedAt: 'fix' }
}

phase('Verify')
const verdict = await agent(`Run: node --test limiter.test.mjs in the current directory. Count passing and failing tests. Confirm limiter.mjs and limiter.test.mjs both exist. Return via the schema.`, {
  label: 'verify:limiter',
  schema: {
    type: 'object',
    properties: {
      testsPassed: { type: 'number' },
      testsFailed: { type: 'number' },
      filesPresent: { type: 'boolean' },
    },
    required: ['testsPassed', 'testsFailed', 'filesPresent'],
  },
})
if (verdict === null) return { done: false, failedAt: 'verify' }

return {
  done: verdict.testsPassed === 12 && verdict.testsFailed === 0 && verdict.filesPresent,
  testsPassed: verdict.testsPassed,
  testsFailed: verdict.testsFailed,
  gatePassedFirstTry: gate.pass,
}
