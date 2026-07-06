// Pilot before you scale: derive the taxonomy from the data, enrich a small
// stratified sample against a strict schema, and end at a sign-off report a
// human can judge — the full several-thousand-record run is a separate,
// deliberate second step after approval.
//
// Run it:   ultracodex run examples/pilot-then-full/workflow.js --watch \
//             --args '{"db":"/path/to/collection.db","table":"records"}'
export const meta = {
  name: 'pilot-then-full',
  description: 'Pilot an enrichment pass: derive a taxonomy, enrich a stratified sample of a few dozen records, and synthesize a sign-off report before scaling to the several-thousand-record collection',
  phases: [
    { title: 'Taxonomy & sample' },
    { title: 'Enrich' },
    { title: 'Synthesize' },
  ],
}

const DB = args?.db ?? '/path/to/collection.db'   // local SQLite store — READ-ONLY throughout the pilot
const TABLE = args?.table ?? 'records'
const BATCH_SIZE = args?.batchSize ?? 5           // records per enrichment agent: small enough to stay careful

const TAXONOMY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['taxonomy', 'pilot'],
  properties: {
    taxonomy: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['key', 'name', 'definition'],
      properties: { key: { type: 'string' }, name: { type: 'string' }, definition: { type: 'string' } } } },
    pilot: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'name', 'conf', 'stratum'],
      properties: { id: { type: 'integer' }, name: { type: 'string' }, conf: { type: 'number' },
        stratum: { type: 'string', enum: ['popular', 'ambiguous', 'mid'] } } } },
  },
}

const ENRICH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['records'],
  properties: { records: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['id', 'verdict', 'category', 'score', 'summary', 'evidence', 'confidence', 'notes'],
    properties: {
      id: { type: 'integer' },
      verdict: { type: 'string', enum: ['in-scope', 'out-of-scope', 'unsure'] },
      category: { type: 'string' },
      score: { type: 'number' },
      summary: { type: 'string' },
      evidence: { type: 'string' },
      confidence: { type: 'number' },
      notes: { type: 'string' },
    } } } },
}

phase('Taxonomy & sample')
const scout = await agent(
  `Design a category taxonomy for a curated directory built from a local record collection, and select a stratified pilot sample. Use the SQLite store at ${DB} READ-ONLY via the sqlite3 CLI. Inspect the shape first:
  sqlite3 "${DB}" ".schema ${TABLE}"

TAXONOMY — derive it from the real data, not just intuition. Sample broadly, e.g.:
  sqlite3 "${DB}" "SELECT * FROM ${TABLE} ORDER BY RANDOM() LIMIT 200"
Produce 10-20 coherent, non-overlapping categories that fit what is actually in the collection. Each entry: key (kebab-case), name, one-line definition.

PILOT SAMPLE — a few dozen records, stratified so the review is meaningful:
  roughly a third popular: the highest-visibility records (whatever popularity signal the table carries — these are where enrichment mistakes hurt most)
  roughly a third ambiguous: records the earlier cheap classifier was LEAST confident about (lowest prior confidence — this is where slipped-through records hide)
  roughly a third mid-tier, spread across apparent categories
Return id, name, conf (= the prior classifier's confidence), and stratum for each. Return ONLY the structured object.`,
  { schema: TAXONOMY_SCHEMA, phase: 'Taxonomy & sample', label: 'taxonomy+sample' }
)
if (!scout || !scout.pilot || !scout.pilot.length) {
  return { error: 'scout/taxonomy phase failed', scout }   // nothing downstream can run without it
}
const taxonomyText = scout.taxonomy.map(t => `- ${t.key} (${t.name}): ${t.definition}`).join('\n')
log(`scout: ${scout.taxonomy.length} categories, ${scout.pilot.length} pilot records`)

phase('Enrich')
const ids = scout.pilot.map(p => p.id)
const batches = []
for (let i = 0; i < ids.length; i += BATCH_SIZE) batches.push(ids.slice(i, i + BATCH_SIZE))

const ENRICH_PROMPT = (batch, bi) =>
  `You are the editorial curator for a directory built from a local record collection. Enrich these ${batch.length} records. ids: ${batch.join(', ')}.

For EACH id (substitute the id for ID):
1) Read its full row READ-ONLY from the store:
   sqlite3 "${DB}" "SELECT * FROM ${TABLE} WHERE id=ID"
2) Judge and output per record:
   - verdict: re-confirm the record actually belongs in this collection ('in-scope') vs slipped through the earlier cheap classifier ('out-of-scope'); 'unsure' only when the row genuinely underdetermines it. Judge from what the record substantively says, not superficial signals. Flag anything that looks misfiled.
   - category: the single best-fitting key from THIS taxonomy:
${taxonomyText}
   - score (0-1): overall editorial strength as a directory entry, informed by whatever quality signal the row carries.
   - summary (<=160 chars): crisp editorial "why it's notable". GROUNDED — assert only what the record supports; never invent details.
   - evidence: the specific phrase(s) in the row supporting the verdict.
   - confidence (0-1) in your calls; notes for anything borderline.
Return ONLY the structured object {"records":[ one entry per id ]}.`

const results = await parallel(batches.map((batch, bi) => () =>
  agent(ENRICH_PROMPT(batch, bi), { schema: ENRICH_SCHEMA, phase: 'Enrich', label: `enrich:b${bi + 1}` })
))
const enriched = results.filter(Boolean).flatMap(r => r.records)
const failedBatches = results.filter(r => !r).length
log(`enrich: ${enriched.length}/${ids.length} records back from ${batches.length} batch(es)` +
  (failedBatches ? ` — ${failedBatches} batch(es) failed and were dropped` : ''))

phase('Synthesize')
const review = await agent(
  `Review this pilot enrichment BEFORE it scales to the full collection of several thousand records. Write a concise markdown review for the human owner to sign off on.

PROPOSED TAXONOMY:
${taxonomyText}

PILOT ROSTER (id | name | stratum):
${scout.pilot.map(p => `${p.id} | ${p.name} | ${p.stratum}`).join('\n')}

ENRICHED PILOT (${enriched.length} of ${ids.length} planned records, JSON):
${JSON.stringify(enriched)}

Cover:
1. Taxonomy: coherent and complete? gaps/overlaps? concrete fixes.
2. Enrichment quality: are summaries crisp and GROUNDED? are scores sensible and calibrated across records?
3. Re-confirmation: list every record whose verdict != 'in-scope' (slipped through the earlier classifier), with the reason.
4. Category distribution across the pilot — any stratum the taxonomy serves badly? Note any planned records missing from the enriched set.
5. A verbatim table of 6-8 example rows: name | category | score | summary — so the owner can judge the editorial voice directly.
6. Open calls for the owner before the full run: the score bar for inclusion, summary voice, how strictly to exclude 'unsure' verdicts, and anything this pilot could not settle.`,
  { phase: 'Synthesize', label: 'synthesize' }
)

return { taxonomy: scout.taxonomy, enriched, enrichedCount: enriched.length, review }
