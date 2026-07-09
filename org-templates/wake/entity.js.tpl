export const meta = {
  name: 'entity-wake',
  description: 'Wake one entity agent from its own directory.',
  whenToUse: 'Runtime generated entity wake.',
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
log(`Entity wake: ${WAKE.agentPath}`)

const result = await agent(wakePrompt(), {
  label: `wake:${WAKE.agentLabel}`,
  phase: 'Wake',
  schema: WAKE_SCHEMA,
})

return result

function wakePrompt() {
  return `You are ${WAKE.agentPath}; read AGENTS.md and follow it exactly.

Today: ${WAKE.date}
Cycle: ${WAKE.cycle}
Wake reason: ${WAKE.reason}
Re-read your own memory files; this wake does not rely on prior conversation state.

Inbox item filenames under inbox are listed here:
${bulletList(WAKE.inbox.items)}
${backlogLine()}
${historicalLine()}
Process ONLY the listed inbox filenames. Do not read or process any other files in inbox.

Work ONLY inside this entity directory.
Append a LOG entry for every wake. If nothing changed, append a null LOG entry for this cycle with severity:routine.
Return changed, severity, logLine, and outbox. Use outbox: [] when no outbound message is needed. OUTBOX RULES (violations are rejected and cost you a cycle): NOTIFY goes to peers or other subtrees, never up your own chain; REQUEST commands work and is allowed ONLY toward your own descendants (if you have none, you may never REQUEST); REPLY only answers a ticket that names you. Infrastructure (ingest/ops/audit) is not an addressee - if you are missing source material or need something fixed, record the gap in your LOG and WATCHLIST instead; honest recorded ignorance beats an unauthorized message. FILE RULES: every memory file keeps its YAML frontmatter (updated, sources, confidence, next_review) current even on full rewrites; delete inbox items you have processed and LOGged; close or renew any WATCHLIST item whose date has passed.`
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
