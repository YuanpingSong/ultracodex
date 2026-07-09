export const meta = {
  name: 'root-wake',
  description: 'Wake the root agent from the org root.',
  whenToUse: 'Runtime generated root wake.',
  phases: [
    { title: 'Wake', detail: 'Process capped inbox items and return outbound messages' },
  ],
}

const WAKE = __WAKE_ARGS_JSON__

const WAKE_SCHEMA = {
  type: 'object',
  properties: {
    changed: { type: 'boolean' },
    severity: { type: 'string', enum: ['routine', 'notable', 'material', 'urgent'] },
    logLine: { type: 'string' },
    outbox: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['NOTIFY', 'REQUEST', 'REPLY'] },
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          refs: { type: 'array', items: { type: 'string' } },
        },
        required: ['type', 'to', 'subject', 'body', 'refs'],
      },
    },
  },
  required: ['changed', 'severity', 'logLine', 'outbox'],
}

phase('Wake')
log('Root wake')

const result = await agent(wakePrompt(), {
  label: 'wake:root',
  phase: 'Wake',
  schema: WAKE_SCHEMA,
})

return result

function wakePrompt() {
  return `You are root; read AGENTS.md and follow it exactly.

Today: ${WAKE.date}
Cycle: ${WAKE.cycle}
Wake reason: ${WAKE.reason}
Re-read your own memory files and the child BRIEF.md files required by AGENTS.md.

Inbox item filenames under inbox are listed here:
${bulletList(WAKE.inbox.items)}
${backlogLine()}
${historicalLine()}
Process ONLY the listed inbox filenames. Do not read or process any other files in inbox.

Work ONLY at the org root.
Append a LOG entry for every wake. If nothing changed, append a null LOG entry for this cycle with severity:routine.
Return changed, severity, logLine, and outbox. Use outbox: [] when no outbound message is needed. OUTBOX RULES (violations are rejected and cost you a cycle): NOTIFY goes to peers or other subtrees, never up your own chain; REQUEST commands work and is allowed ONLY toward your own descendants; REPLY only answers a ticket that names you. Infrastructure (ingest/ops/audit) is not an addressee - if you are missing source material or need something fixed, record the gap in your LOG and WATCHLIST instead; honest recorded ignorance beats an unauthorized message.`
}

function backlogLine() {
  if (!WAKE.inbox.backlog) return ''
  return `${WAKE.inbox.backlog} more items are queued behind these; they arrive in later cycles.`
}

function historicalLine() {
  if (!WAKE.inbox.historical || !WAKE.inbox.historical.length) return ''
  return `Historical backfill items: ${WAKE.inbox.historical.join(', ')}. Judge severity by what the information means today.`
}

function bulletList(items) {
  if (!items || !items.length) return '- none'
  return items.map((item) => `- ${item}`).join('\n')
}
