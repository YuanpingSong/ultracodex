export const meta = {
  name: 'goal',
  description: 'Build toward explicit acceptance criteria with a skeptical verifier loop',
  phases: [
    { title: 'Build' },
    { title: 'Verify' },
  ],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approved', 'rejected'] },
    issues: { type: 'array', items: { type: 'string' } },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          pass: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['criterion', 'pass', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'issues', 'criteria'],
  additionalProperties: false,
}

function usage(message) {
  return new Error(`usage: run goal --args '{"task":"...","criteria":"..."}' (${message}; required args: task, criteria)`)
}

function requiredString(name) {
  const value = args && args[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw usage(`args.${name} must be a non-empty string`)
  }
  return value
}

function optionalString(name) {
  const value = args && args[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw usage(`args.${name} must be a string when provided`)
  return value
}

function positiveInteger(name, fallback) {
  const value = args && args[name]
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw usage(`args.${name} must be a positive integer`)
  }
  return value
}

function nonNegativeInteger(name, fallback) {
  const value = args && args[name]
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) {
    throw usage(`args.${name} must be a non-negative integer`)
  }
  return value
}

function buildPrompt(round, task, criteria, context, previousIssues) {
  const parts = [
    `Task:\n${task}`,
    `Acceptance criteria:\n${criteria}`,
  ]
  if (context) parts.push(`Context:\n${context}`)
  if (round > 1) {
    parts.push(
      `Previous verifier issues, verbatim:\n${previousIssues.join('\n')}`,
      'Make targeted fixes for those issues only. Do not do drive-by refactors.',
    )
  }
  return parts.join('\n\n')
}

function verifyPrompt(round, task, criteria, context, builderResult) {
  const parts = [
    'You are the skeptical verifier for this goal loop.',
    `Round: ${round}`,
    `Task:\n${task}`,
    `Acceptance criteria:\n${criteria}`,
    'Verify each criterion mechanically by reading and running the work yourself. Never trust the builder claims. Reject when uncertain.',
  ]
  if (context) parts.push(`Context:\n${context}`)
  parts.push(`Builder final message for context only, not evidence:\n${builderResult}`)
  parts.push('Return only the schema object.')
  return parts.join('\n\n')
}

const task = requiredString('task')
const criteria = requiredString('criteria')
const maxRounds = positiveInteger('maxRounds', 4)
const context = optionalString('context')
const builderModel = optionalString('builderModel')
const verifierModel = optionalString('verifierModel')
const budgetFloor = nonNegativeInteger('budgetFloor', 20000)

const history = []
let lastBuilt = null
let lastIssues = []
let roundsRun = 0
let finalVerdict = 'exhausted'
let stoppedExhausted = false

for (let round = 1; round <= maxRounds; round++) {
  if (budget.total !== null && budget.remaining() < budgetFloor) {
    stoppedExhausted = true
    break
  }

  phase('Build')
  const built = await agent(buildPrompt(round, task, criteria, context, lastIssues), {
    label: `goal:build-r${round}`,
    phase: 'Build',
    ...(builderModel ? { model: builderModel } : {}),
  })
  if (built === null) {
    roundsRun = round
    stoppedExhausted = true
    log(`round ${round}: exhausted`)
    break
  }
  lastBuilt = built

  phase('Verify')
  const verification = await agent(verifyPrompt(round, task, criteria, context, built), {
    label: `goal:verify-r${round}`,
    phase: 'Verify',
    schema: VERIFY_SCHEMA,
    ...(verifierModel ? { model: verifierModel } : {}),
  })
  if (verification === null) {
    roundsRun = round
    stoppedExhausted = true
    log(`round ${round}: exhausted`)
    break
  }

  const verdict = verification.verdict === 'approved' ? 'approved' : 'rejected'
  const issues = verdict === 'approved' ? [] : verification.issues
  roundsRun = round
  lastIssues = issues
  history.push({ round, verdict, issues })
  log(`round ${round}: ${verdict}`)

  if (verdict === 'approved') {
    finalVerdict = 'approved'
    break
  }
  finalVerdict = 'rejected'
}

if (stoppedExhausted) finalVerdict = 'exhausted'

return {
  done: finalVerdict === 'approved',
  rounds: roundsRun,
  verdict: finalVerdict,
  issues: finalVerdict === 'approved' ? [] : lastIssues,
  output: lastBuilt,
  history,
}
