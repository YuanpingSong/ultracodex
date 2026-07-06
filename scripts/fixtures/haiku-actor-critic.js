// The demo-video task, pinned as the release gate: a 3-round actor–critic
// loop writing a haiku on the meaning of life. Small prompts by design —
// this runs live against real codex before every release.
export const meta = {
  name: 'haiku-actor-critic',
  description: 'Release gate: 3-round actor-critic haiku loop (the demo video task)',
  phases: [
    { title: 'Round 1' },
    { title: 'Round 2' },
    { title: 'Round 3' },
  ],
}

const CRITIQUE = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'true only if the haiku is 5-7-5, vivid, and not a cliché' },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'issues'],
}

const rounds = []
let haiku = null
let verdict = null

for (let round = 1; round <= 3; round++) {
  phase(`Round ${round}`)
  const feedback = verdict && !verdict.pass
    ? `\nA critic rejected the previous attempt:\n${haiku}\nIssues: ${verdict.issues.join('; ')}\nFix every issue.`
    : ''
  const built = await agent(
    `Write a haiku (5-7-5) on the meaning of life. Vivid imagery, no clichés.${feedback}\nReturn ONLY the three lines.`,
    { label: `actor:round-${round}`, phase: `Round ${round}` },
  )
  if (built === null) { log(`round ${round}: actor failed`); continue }
  haiku = built

  verdict = await agent(
    `Judge this haiku strictly against: 5-7-5 syllables, vivid imagery, no clichés. Do not invent requirements beyond these.\n\n${haiku}\n\nReturn via the schema.`,
    { label: `critic:round-${round}`, phase: `Round ${round}`, schema: CRITIQUE },
  )
  if (verdict === null) { log(`round ${round}: critic failed`); verdict = { pass: false, issues: ['critic unavailable'] } }
  rounds.push({ round, haiku, pass: verdict.pass, issues: verdict.issues })
  log(`round ${round}: ${verdict.pass ? 'PASS' : verdict.issues.length + ' issue(s)'}`)
  if (verdict.pass) break
}

return { finalHaiku: haiku, rounds, converged: Boolean(verdict && verdict.pass) }
