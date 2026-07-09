export const meta = {
  name: 'org-audit',
  description: 'Audit sampled org BRIEF/THESIS claims against their cited source files',
  phases: [
    { title: 'Collect' },
    { title: 'Audit' },
    { title: 'Verdict' },
  ],
}

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          agent: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          claim: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['file', 'line', 'claim'],
        additionalProperties: false,
      },
    },
  },
  required: ['claims'],
  additionalProperties: false,
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['verified', 'unsupported', 'contradicted', 'uncheckable'] },
    note: { type: 'string' },
  },
  required: ['verdict', 'note'],
  additionalProperties: false,
}

const VERDICTS = ['verified', 'unsupported', 'contradicted', 'uncheckable']

function positiveInteger(name, fallback) {
  const value = args && args[name]
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`args.${name} must be a positive integer`)
  }
  return value
}

function optionalScope() {
  const value = args && args.scope
  if (value === undefined || value === null || String(value).trim() === '') return '.'
  return normalizePath(String(value))
}

function normalizePath(value) {
  let out = String(value).trim().replace(/\\/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  while (out.endsWith('/') && out !== '/') out = out.slice(0, -1)
  return out === '' ? '.' : out
}

function agentFromFile(file) {
  const normalized = normalizePath(file)
  if (normalized === 'BRIEF.md' || normalized === 'THESIS.md') return '.'
  return normalized.replace(/\/(?:BRIEF|THESIS)\.md$/u, '') || '.'
}

function citations(text) {
  const out = []
  const seen = new Set()
  for (const match of String(text).matchAll(/\[(source|fact):([^\]]+)\]/giu)) {
    const value = String(match[2] ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function normalizeClaim(raw) {
  if (!raw || typeof raw !== 'object') return null
  const file = normalizePath(raw.file)
  const line = Number(raw.line)
  const claim = String(raw.claim ?? '').trim()
  if (!file || !Number.isInteger(line) || line < 1 || !claim) return null
  const sourceSet = new Set(citations(claim))
  return {
    agent: normalizePath(raw.agent ?? agentFromFile(file)),
    file,
    line,
    claim,
    sources: [...sourceSet].sort(),
    hasNumber: /\d/u.test(claim),
  }
}

function claimPriority(claim) {
  if (claim.sources.length && claim.hasNumber) return 0
  if (claim.sources.length) return 1
  if (claim.hasNumber) return 2
  return 3
}

function compareClaims(left, right) {
  return claimPriority(left) - claimPriority(right)
    || left.file.localeCompare(right.file)
    || left.line - right.line
    || left.claim.localeCompare(right.claim)
}

function claimKey(claim) {
  return `${claim.file}\0${claim.line}\0${claim.claim}`
}

function collectorPrompt(scope) {
  return [
    'You are a read-only claim collector for a generic filesystem org.',
    `Scope path prefix: ${scope}`,
    'Read only BRIEF.md and THESIS.md files under that scope. Ignore inboxes, tickets, logs, templates, caches, and generated runtime state.',
    'Collect candidate claim lines: prefer lines with [source:...] or [fact:...] citations, then lines containing numbers. Skip frontmatter, headings, placeholders, and pure formatting.',
    'For each claim return: agent path (directory owning the file, "." for root), repo-relative file path, one-based line number, exact trimmed claim text, and citation payloads from [source:...] / [fact:...] refs.',
    'Do not verify anything in this step. Return only the schema object.',
  ].join('\n\n')
}

function auditPrompt(claim) {
  const sources = claim.sources.length ? claim.sources.join('\n') : '(none)'
  return [
    'You are an adversarial read-only fact auditor for a filesystem org.',
    'Verify the single claim below against the cited source file(s) only. Do not use web search, memory, neighboring org files, or uncited sources.',
    'If no cited source file is present, or a cited source cannot be read as a repo-relative file, return uncheckable.',
    'Verdicts:',
    '- verified: every factual assertion and number in the claim is supported by the cited source file(s).',
    '- unsupported: the cited source is readable but does not contain the asserted fact or number.',
    '- contradicted: the cited source states a conflicting fact or number.',
    '- uncheckable: the cited source file is missing, ambiguous, or not a file path.',
    'For mixed claims, use the weakest-link rule: one unsupported or contradicted piece controls the line.',
    `Claim file: ${claim.file}:${claim.line}`,
    `Owning agent: ${claim.agent}`,
    `Claim:\n${claim.claim}`,
    `Cited source payloads:\n${sources}`,
    'Return only the schema object. Keep note short and source-grounded.',
  ].join('\n\n')
}

function normalizeVerdict(value) {
  const text = String(value ?? '').toLowerCase()
  return VERDICTS.includes(text) ? text : 'uncheckable'
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

const sample = positiveInteger('sample', 25)
const scope = optionalScope()

phase('Collect')
const collected = await agent(collectorPrompt(scope), {
  label: 'audit:collect',
  phase: 'Collect',
  schema: CLAIMS_SCHEMA,
  agentType: 'Explore',
})

const claims = []
const seen = new Set()
if (collected && Array.isArray(collected.claims)) {
  for (const raw of collected.claims) {
    const claim = normalizeClaim(raw)
    if (!claim) continue
    const key = claimKey(claim)
    if (seen.has(key)) continue
    seen.add(key)
    claims.push(claim)
  }
}

const sampled = claims.sort(compareClaims).slice(0, sample)

phase('Audit')
const audited = await parallel(sampled.map((claim) => () => auditOne(claim)))

async function auditOne(claim) {
  const result = await agent(auditPrompt(claim), {
    label: `audit:${claim.agent}:${claim.line}`,
    phase: 'Audit',
    schema: AUDIT_SCHEMA,
    agentType: 'Explore',
  })
  return { claim, result }
}

phase('Verdict')
const tally = { verified: 0, unsupported: 0, contradicted: 0, uncheckable: 0 }
const findings = []

for (const row of audited) {
  if (!row || !row.claim) continue
  const verdict = row.result ? normalizeVerdict(row.result.verdict) : 'uncheckable'
  const note = row.result && typeof row.result.note === 'string' && row.result.note.trim()
    ? row.result.note.trim()
    : 'auditor returned no usable result'
  tally[verdict] += 1
  findings.push({
    agent: row.claim.agent,
    file: row.claim.file,
    line: row.claim.line,
    claim: row.claim.claim,
    verdict,
    note,
  })
}

const checkable = tally.verified + tally.unsupported + tally.contradicted
const accuracy = checkable > 0 ? round4(tally.verified / checkable) : 0
log(`org audit: ${tally.verified}/${checkable} checkable claims verified; ${tally.uncheckable} uncheckable`)

return {
  accuracy,
  tally,
  findings,
  sampled: sampled.length,
  done: accuracy >= 0.99,
}
