export const meta = {
  name: 'demo-doc-digest',
  description: 'Illustrative 3-stage workflow: 3 agents summarize 3 project docs in parallel (max concurrency 3), one agent synthesizes, one agent adversarially critiques the synthesis',
  phases: [
    { title: 'Summarize', detail: '3 agents, each reads one doc and returns a short summary — capped at 3 concurrent' },
    { title: 'Synthesize', detail: 'one agent combines the three summaries into a short overview' },
    { title: 'Critique', detail: 'one agent adversarially checks the overview against the source docs' },
  ],
}

const DOCS = [
  'docs/architecture.md',
  'docs/internal/PROGRESS.md',
  'docs/operations.md',
]

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    summary: { type: 'string', description: '1-2 sentence summary of what this doc covers' },
  },
  required: ['file', 'summary'],
}

phase('Summarize')
log('Summarizing 3 docs in parallel (3 concurrent agents, the max requested)')

const summaries = (await parallel(DOCS.map(file => () =>
  agent(`Read the file "${file}" (relative to the repo root) and summarize what it covers in 1-2 sentences. Return via the schema.`, {
    label: `summarize:${file}`,
    phase: 'Summarize',
    schema: SUMMARY_SCHEMA,
  })
))).filter(Boolean)

log(`Got ${summaries.length}/${DOCS.length} summaries`)

phase('Synthesize')
const bulletList = summaries.map(s => `- ${s.file}: ${s.summary}`).join('\n')

const synthesis = await agent(
  `Here are short summaries of three project docs:\n${bulletList}\n\nWrite a single short paragraph (3-4 sentences) synthesizing these into one coherent "state of the project" overview. Return plain text, no markdown headers.`,
  { label: 'synthesize', phase: 'Synthesize' }
)

log('Synthesis written, running adversarial critique')

phase('Critique')
const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    accurate: { type: 'boolean', description: 'true only if every claim in the synthesis is supported by the source docs' },
    issues: { type: 'array', items: { type: 'string' }, description: 'any inaccuracies, unsupported claims, or omissions' },
  },
  required: ['accurate', 'issues'],
}

const critique = await agent(
  `Re-read these files yourself: ${DOCS.join(', ')} (relative to the repo root).\nThen check this synthesized overview against them:\n\n"${synthesis}"\n\nBe skeptical: flag any claim not actually supported by the docs. Return via the schema.`,
  { label: 'critique', phase: 'Critique', schema: CRITIQUE_SCHEMA }
)

return { summaries, synthesis, critique }
