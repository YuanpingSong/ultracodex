export const meta = {
  name: 'loop',
  description: 'Run finder rounds until fresh findings dry up under a dedup key',
  phases: [
    { title: 'Find' },
    { title: 'Verify' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          location: { type: 'string' },
        },
        required: ['title', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
}

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          real: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['title', 'real', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
}

function usage(message) {
  return new Error(`usage: run loop --args '{"find":"..."}' (${message}; required args: find)`)
}

function requiredString(name) {
  const value = args && args[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw usage(`args.${name} must be a non-empty string`)
  }
  return value
}

function optionalString(name, fallback) {
  const value = args && args[name]
  if (value === undefined) return fallback
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

function normalizeFinding(finding) {
  const out = {
    title: String(finding.title),
    detail: String(finding.detail),
  }
  if (typeof finding.location === 'string' && finding.location !== '') {
    out.location = finding.location
  }
  return out
}

function keyFor(finding, field) {
  let value
  if (finding && finding[field] !== undefined && finding[field] !== null) {
    value = finding[field]
  } else if (finding && finding.title !== undefined && finding.title !== null) {
    value = finding.title
  } else {
    value = JSON.stringify(finding)
  }
  return String(value).toLowerCase()
}

function finderPrompt(round, find, dedupBy, seenKeys) {
  const seen = seenKeys.length === 0 ? '(none)' : seenKeys.join('\n')
  return [
    `Round: ${round}`,
    `Finder instructions:\n${find}`,
    `Dedup field: ${dedupBy}`,
    `Already-seen dedup keys. Do not re-report these:\n${seen}`,
    'Return only fresh candidate findings via the schema. Omit location when no precise location applies.',
  ].join('\n\n')
}

function verifierPrompt(verify, fresh) {
  return [
    'You are the adversarial verifier for this loop.',
    `Verifier instructions:\n${verify}`,
    'Try to refute each fresh finding. Mark real=false when uncertain.',
    `Fresh findings:\n${JSON.stringify(fresh, null, 2)}`,
    'Return one verdict for each fresh finding title via the schema.',
  ].join('\n\n')
}

const find = requiredString('find')
const verify = optionalString('verify', undefined)
const dryRounds = positiveInteger('dryRounds', 2)
const maxRounds = positiveInteger('maxRounds', 8)
const dedupBy = optionalString('dedupBy', 'title')
const finderModel = optionalString('finderModel', undefined)
const verifierModel = optionalString('verifierModel', undefined)
const budgetFloor = nonNegativeInteger('budgetFloor', 20000)

const seen = new Set()
const confirmed = []
let dryCount = 0
let roundsRun = 0
let done = false

for (let round = 1; round <= maxRounds; round++) {
  if (budget.total !== null && budget.remaining() < budgetFloor) break

  phase('Find')
  const found = await agent(finderPrompt(round, find, dedupBy, Array.from(seen)), {
    label: `loop:find-r${round}`,
    phase: 'Find',
    schema: FINDINGS_SCHEMA,
    ...(finderModel ? { model: finderModel } : {}),
  })
  if (found === null) {
    roundsRun = round
    log(`round ${round}: fresh=0 confirmed=0 dry=${dryCount}`)
    break
  }

  const fresh = []
  for (const item of found.findings) {
    const normalized = normalizeFinding(item)
    const key = keyFor(normalized, dedupBy)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(normalized)
  }

  if (fresh.length === 0) {
    dryCount += 1
    roundsRun = round
    log(`round ${round}: fresh=0 confirmed=0 dry=${dryCount}`)
    if (dryCount >= dryRounds) {
      done = true
      break
    }
    continue
  }

  dryCount = 0
  let confirmedThisRound = fresh
  if (verify) {
    phase('Verify')
    const checked = await agent(verifierPrompt(verify, fresh), {
      label: `loop:verify-r${round}`,
      phase: 'Verify',
      schema: VERDICTS_SCHEMA,
      ...(verifierModel ? { model: verifierModel } : {}),
    })
    if (checked === null) {
      roundsRun = round
      log(`round ${round}: fresh=${fresh.length} confirmed=0 dry=${dryCount}`)
      break
    }
    const realTitles = new Set()
    for (const verdict of checked.verdicts) {
      if (verdict.real === true) realTitles.add(String(verdict.title).toLowerCase())
    }
    confirmedThisRound = fresh.filter((finding) => realTitles.has(finding.title.toLowerCase()))
  }

  for (const finding of confirmedThisRound) confirmed.push(finding)
  roundsRun = round
  log(`round ${round}: fresh=${fresh.length} confirmed=${confirmedThisRound.length} dry=${dryCount}`)
}

return {
  done,
  rounds: roundsRun,
  dry: done && dryCount >= dryRounds,
  findings: confirmed,
  seenCount: seen.size,
}
