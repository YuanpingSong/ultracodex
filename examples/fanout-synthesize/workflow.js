// A real orchestration shape: parallel fan-out → synthesis → adversarial
// critique with structured output. Demonstrates phases, parallel(), schemas,
// and null-tolerance.
// Run it:   ultracodex run examples/fanout-synthesize/workflow.js --watch
export const meta = {
  name: 'fanout-synthesize',
  description: 'Three readers summarize project docs in parallel, one agent synthesizes, one critiques against the sources',
  phases: [
    { title: 'Read', detail: 'three parallel readers, one file each' },
    { title: 'Synthesize', detail: 'combine the summaries' },
    { title: 'Critique', detail: 'adversarial check against the sources' },
  ],
}

const FILES = ['README.md', 'docs/ARCHITECTURE.md', 'docs/OPERATIONS.md']

// JSON Schema → agent() returns a validated object instead of raw text.
// The engine enforces this (prompt contract + validation + repair turns).
const SUMMARY = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    summary: { type: 'string', description: '1-2 sentences' },
  },
  required: ['file', 'summary'],
}

phase('Read')
// parallel() is a barrier: it resolves when ALL thunks settle. A failed
// agent yields null in the array (never a rejection) — filter and move on.
const summaries = (await parallel(FILES.map(f => () =>
  agent(`Read "${f}" and summarize what it covers in 1-2 sentences. Return via the schema.`, {
    label: `read:${f}`,       // shows in the TUI; also what [route] rules match
    phase: 'Read',
    schema: SUMMARY,
  })
))).filter(Boolean)

log(`got ${summaries.length}/${FILES.length} summaries`)

phase('Synthesize')
const synthesis = await agent(
  `Combine these into one short "state of the project" paragraph:\n` +
  summaries.map(s => `- ${s.file}: ${s.summary}`).join('\n'),
  { label: 'synthesize' },
)

phase('Critique')
// Route this label to a different backend in .ultracodex/config.toml
// ("critique:*" = "claude") and you have cross-vendor verification:
// one vendor writes, another judges.
const critique = await agent(
  `Re-read ${FILES.join(', ')} yourself, then check this synthesis against them. ` +
  `Flag any claim the sources don't support:\n\n"${synthesis}"`,
  {
    label: 'critique:synthesis',
    schema: {
      type: 'object',
      properties: {
        accurate: { type: 'boolean' },
        issues: { type: 'array', items: { type: 'string' } },
      },
      required: ['accurate', 'issues'],
    },
  },
)

return { summaries, synthesis, critique }
