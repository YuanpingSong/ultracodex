export const meta = {
  name: 'org-lint-repair',
  description: 'Bounded repair wave for org lint findings',
  phases: [
    { title: 'Repair' },
    { title: 'Check' },
  ],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'remaining'],
  additionalProperties: false,
}

function required(name) {
  const value = args && args[name]
  if (value === undefined || value === null) throw new Error(`args.${name} is required`)
  return value
}

function findingAgent(finding) {
  if (finding && typeof finding.agent === 'string' && finding.agent.trim()) return finding.agent
  return '.'
}

function findingLine(finding) {
  if (typeof finding === 'string') return `- ${finding}`
  if (!finding || typeof finding !== 'object') return '- malformed finding'
  const file = finding.file || finding.path || '.'
  const message = finding.message || 'unknown issue'
  const line = Number.isInteger(finding.line) ? `:${finding.line}` : ''
  return `- ${file}${line} ${message}`
}

const date = required('date')
const cycle = required('cycle')
const findings = required('findings')
if (!Array.isArray(findings)) throw new Error('args.findings must be an array')

const byAgent = new Map()
for (const finding of findings) {
  const agent = findingAgent(finding)
  if (!byAgent.has(agent)) byAgent.set(agent, [])
  byAgent.get(agent).push(finding)
}

const history = []
let pendingByAgent = byAgent
for (let round = 1; round <= 2; round++) {
  phase('Repair')
  const offenders = [...pendingByAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (!offenders.length) break
  const outputs = []
  const nextByAgent = new Map()
  for (const [agentPath, rows] of offenders) {
    const agentFile = agentPath === '.' ? './AGENTS.md' : `${agentPath}/AGENTS.md`
    const scope = agentPath === '.' ? 'the org root' : agentPath
    const prompt = [
      `You are ${agentPath}; read ${agentFile} and follow it exactly.`,
      'The org linter rejected these lines of YOUR files:',
      rows.map(findingLine).join('\n'),
      [
        'Fix ONLY these violations with minimal edits that honor your role contract.',
        'Add real provenance refs from your actual sources: your LOG/inbox refs, child briefs, or [source:...]/[fact:...] refs.',
        'Add real dates on WATCHLIST items.',
        'NEVER delete a claim just to silence the linter unless it is genuinely unsupportable.',
        `Record what you did in your LOG as "- ${date} · cycle ${cycle} · lint repair · <what>".`,
        `Work only inside ${scope}.`,
      ].join('\n'),
      'Return the schema object with fixed and remaining lists.',
    ].join('\n\n')
    const result = await agent(prompt, {
      label: `org-lint-repair:${agentPath}:r${round}`,
      phase: 'Repair',
      schema: FINDINGS_SCHEMA,
    })
    outputs.push({ agent: agentPath, result })
    const remaining = remainingFindings(rows, result)
    if (remaining.length) nextByAgent.set(agentPath, remaining)
  }
  history.push({ round, outputs })
  pendingByAgent = nextByAgent
}

phase('Check')
log(`org lint repair wave complete for cycle ${cycle}`)

return { done: true, rounds: history.length, history }

function remainingFindings(previous, result) {
  if (!result || !Array.isArray(result.remaining)) return previous
  return result.remaining.map((item) => String(item)).filter((item) => item.trim())
}
