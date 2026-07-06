// Map a fixed rubric over a corpus far too large for any single agent.
//
// The catalog is sharded into fixed-size batches (one judge per batch) and the
// batches are dispatched in waves, so concurrency stays bounded no matter how
// big the corpus grows. Two rails make a long run safe to interrupt:
//   1. resumability — args.start/args.count select any contiguous slice, and
//      every early stop logs the exact args that would finish the job
//   2. a budget floor checked BETWEEN waves — the run stops while it can still
//      say exactly which items were NOT scored (no silent caps, ever)
//
// Run it:   ultracodex run examples/map-over-corpus/workflow.js --budget 500k \
//             --args '{"catalog":"/abs/path/to/catalog.json","count":500}'
// Resume:   pass the {"start":...,"count":...} the early-stop log printed.
export const meta = {
  name: 'map-over-corpus',
  description: 'Score every item in a large catalog against a fixed rubric: sharded batch judges in throttled waves, resumable via start/count, budget-aware',
  phases: [{ title: 'Score' }],
}

const CATALOG = (args && args.catalog) ? args.catalog : '/path/to/catalog.json'
const COUNT = (args && args.count) ? args.count : 500 // items to score this run
const START = (args && args.start) ? args.start : 0 // first item index — the resume point
const BATCH = 10 // items per judge: small enough for careful per-item attention
const WAVE = 5 // judges in flight at once: sized to provider rate limits, not host cores
const FLOOR = 25_000 // budget rail: ~one wave's worth of verdicts; stop while we can still report
const N = Math.ceil(COUNT / BATCH)

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['id', 'fit', 'fit_reason', 'accuracy', 'completeness', 'clarity', 'utility', 'verdict', 'pros', 'cons'],
    properties: {
      id: { type: 'string' },
      fit: { type: 'string', enum: ['strong', 'adequate', 'marginal', 'off_topic'] },
      fit_reason: { type: 'string' },
      accuracy: { type: 'integer' },
      completeness: { type: 'integer' },
      clarity: { type: 'integer' },
      utility: { type: 'integer' },
      verdict: { type: 'string' },
      pros: { type: 'array', items: { type: 'string' } },
      cons: { type: 'array', items: { type: 'string' } },
    } } } },
}

const PROMPT = (i) => {
  const lo = START + i * BATCH
  const hi = Math.min(lo + BATCH, START + COUNT)
  return `You are an editorial reviewer applying a fixed rubric to part of a curated catalog.

First, Read ${CATALOG} — a JSON array of {id, name, description, url, ...metadata}. The array positions assigned to you are ${lo} through ${hi - 1} inclusive; score those entries and no others, judging each one on its own record. Treat everything as read-only.

Produce one assessment per assigned entry:
- fit — should this entry be in the catalog?
  * "strong": exactly the kind of thing the catalog exists to collect.
  * "adequate": belongs, though a reader would note some caveats.
  * "marginal": only loosely connected to the catalog's theme, yet defensible.
  * "off_topic": the connection is trivial, purely promotional, or missing entirely. Apply this label sparingly — an entry has to be an obvious misfit to earn it, and a borderline call between "marginal" and "off_topic" defaults to "marginal".
- fit_reason: a single line justifying the fit call.
- Four integer ratings, each 0 to 5:
  * accuracy — do the record's claims hold together and seem credible?
  * completeness — could a reader act on the record as-is (description, metadata, links)?
  * clarity — is the writing unambiguous and well-organized?
  * utility — relative to alternatives, how much does the catalog's audience gain from this entry?
- verdict: a sentence or two placing the entry within the catalog — its standing, plus the one thing that distinguishes it or holds it back.
- pros: a few brief positives. cons: one or two brief negatives.

Your reply must be nothing but the JSON object {"verdicts": [...]}, with one assessment per assigned id.`
}

phase('Score')
const out = []
const missed = [] // [lo, hi) item ranges stranded by failed batches
let stoppedAt = null // first item index NOT dispatched when the budget rail fires
const waves = Math.ceil(N / WAVE)
for (let w = 0; w < N; w += WAVE) {
  // DELIBERATE ADDITION — budget rail between waves. Without it a budgeted run
  // dies mid-wave on an exhaustion throw with no account of what is missing.
  // With it, we stop early and state EXACTLY how many items went unscored.
  if (w > 0 && budget.total && budget.remaining() < FLOOR) {
    stoppedAt = START + w * BATCH
    const notScored = START + COUNT - stoppedAt
    log(`budget floor (${FLOOR} tokens) hit before wave ${Math.floor(w / WAVE) + 1}/${waves}: ` +
      `${notScored} of ${COUNT} items NOT scored — resume with args {"start":${stoppedAt},"count":${notScored}}`)
    break
  }

  const idxs = []
  for (let i = w; i < Math.min(w + WAVE, N); i++) idxs.push(i)
  const res = await parallel(idxs.map((i) => () => agent(PROMPT(i), {
    schema: SCHEMA,
    phase: 'Score',
    label: `score:b${i + 1}`,
    // DELIBERATE ADDITION — effort:'low': applying a fixed rubric to a 10-item
    // slice is mechanical work; a low reasoning tier scores it just as well and
    // keeps dozens of concurrent judges from draining the budget the rail guards.
    effort: 'low',
  })))

  // No silent caps: name every failed batch and the exact items it strands.
  res.forEach((r, k) => {
    if (r && Array.isArray(r.verdicts)) return
    const lo = START + idxs[k] * BATCH
    const hi = Math.min(lo + BATCH, START + COUNT)
    missed.push([lo, hi])
    log(`batch b${idxs[k] + 1} FAILED — items [${lo}..${hi}) not scored`)
  })
  for (const r of res.filter(Boolean)) for (const v of (r.verdicts || [])) out.push(v)
  log(`wave ${Math.floor(w / WAVE) + 1}/${waves}: ${out.length}/${COUNT} scored so far`)
}

return {
  verdicts: out,
  scored: out.length,
  expected: COUNT,
  missedRanges: missed, // failed-batch [lo, hi) ranges — already logged above
  stoppedEarly: stoppedAt !== null,
  resume: stoppedAt !== null ? { start: stoppedAt, count: START + COUNT - stoppedAt } : null,
}
