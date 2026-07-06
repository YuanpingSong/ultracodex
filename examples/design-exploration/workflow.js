// Diverge-then-judge: three proposers explore the same design brief under
// three DIFFERENT aesthetic directions (each carrying the name of its own
// degenerate form), then one art-director agent grades them on a fixed rubric
// and merges the best ideas into a single implementable spec (CSS variables +
// an application order). The direction injection is the whole trick: same
// brief, different divergence vector — you get spread instead of three shades
// of the same safe answer.
export const meta = {
  name: 'design-exploration',
  description: 'Three deliberately decorrelated restyle directions for a small content site, graded by one art director and merged into a single implementable spec',
  phases: [
    { title: 'Diverge', detail: '3 visual systems, one injected aesthetic direction apiece' },
    { title: 'Converge', detail: 'grade on a fixed rubric, merge into one implementable spec' },
  ],
}

// The brief is self-contained so the example runs as-is. Pass { brief: "..." }
// as workflow args to point the panel at your own site instead.
const SYSTEM = args?.brief ? String(args.brief) : `
You are restyling a live site. Structure, pages, and features are frozen; only the visual
skin changes.

WHAT THE SITE IS: a hand-curated catalog of open-source command-line tools — several hundred
entries in a few dozen categories, each with a short factual write-up, a tag row, and an
expandable detail view. Visitors compare options across long browsing sessions, and they
come back because the write-ups are honest.

FOUR NON-NEGOTIABLES (a proposal that breaks any one is disqualified):
1. LIGHT BACKGROUND. Dense entry grids must stay easy on the eyes for an hour at a stretch —
   no return to the old dark look, and no clinical pure-white either: warm, calm, current.
2. CATEGORY HUES CARRY THE NAVIGATION. Every category owns a color so visitors can scan by
   hue, but the palette must stay disciplined: saturation only where it earns its place,
   quiet neutrals everywhere else. If a screenshot reads as a paint-swatch wall, it failed.
3. PLAIN-SPOKEN COPY IS UNTOUCHABLE. Short factual write-ups with honest downsides are why
   people trust the catalog; no visual treatment may nudge the tone toward hype.
4. TITLES STAY LITERAL. Page and section names are deliberately boring and searchable;
   decoration must never obscure them.

THE OUTGOING LOOK (remove it completely): the site currently dresses up as a vintage
computer terminal — green-on-black text, scanline overlays, box-drawing borders, a blinking
cursor in the masthead, system-message copy. None of it carries over.

THE PARTS THAT STAY (restyle them; never rearrange or drop them): the masthead with its
one-sentence pitch, the category filter row, the entry grid (name, write-up, tags, a small
maintenance-status marker), the STAFF FAVORITES strip (its award marker is the one playful
element on the site — give it a fresh look without losing its charm), the expandable detail
view (longer write-up, upsides/downsides, a copy-to-clipboard install snippet, an outbound
link button), and the "vetted" marker.

BUILD REALITY: a static site generator with hand-written stylesheets; there is no JS
framework and no animation library, so every effect must be pure CSS.
`

const PROPOSAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['proposal_name', 'concept_summary', 'background_system', 'color_system',
             'type_system', 'surface_styling', 'favorites_restyle', 'detail_view_restyle',
             'motion', 'wordmark_treatment', 'category_hue_rule', 'keep_list', 'remove_list',
             'standout_element', 'taste_rules', 'weak_points'],
  properties: {
    proposal_name: { type: 'string' },
    concept_summary: { type: 'string', description: 'the direction in one sentence' },
    background_system: { type: 'string', description: 'the light-canvas recipe: literal base color values, any wash or texture, and how elevation and layering read without going dark' },
    color_system: { type: 'string', description: 'the heart of the brief: where saturated color appears and where it is withheld — the brand accent (with gradient stops if any) and the restraint rules that keep color deliberate rather than decorative' },
    type_system: { type: 'string', description: 'heading/body/code roles with a concrete size scale; how headings feel current without borrowing the old terminal dress-up' },
    surface_styling: { type: 'string', description: 'entry cards, category chips, and panels: corner radii, borders, shadows, hover treatment, fill colors on the light canvas' },
    favorites_restyle: { type: 'string', description: 'a fresh award marker for the staff-favorites strip that fits the new system and keeps its charm' },
    detail_view_restyle: { type: 'string', description: 'the expanded detail view on light: upsides/downsides, the install-snippet block, the outbound link button — readable and trustworthy' },
    motion: { type: 'string', description: 'every animation spelled out, pure CSS; movement should reward attention, never demand it' },
    wordmark_treatment: { type: 'string', description: 'how the site title lockup appears while staying literal and searchable' },
    category_hue_rule: { type: 'string', description: 'the assignment rule that gives a few dozen categories distinct hues without chaos — formula, hue families, collision handling' },
    keep_list: { type: 'string' },
    remove_list: { type: 'string' },
    standout_element: { type: 'string', description: 'the single flourish a visitor would remember the site by' },
    taste_rules: { type: 'string', description: 'the hard rules this direction commits to so its color use stays deliberate under pressure' },
    weak_points: { type: 'string' },
  },
}

phase('Diverge')
// Each proposer gets the SAME brief plus a DIFFERENT aesthetic direction. A
// direction names the register to commit to AND the trap that register falls
// into — without the second half, all three drift back to the safe middle.
const DIRECTIONS = [
  { key: 'ink-and-hue',
    push: `DIRECTION 1 — "Ink and hue." Typography-first on an almost-uncolored ground: on
    ordinary pages the category hues are the only pigment, everything else is ink, paper,
    and hairline rules, and the complete palette surfaces in exactly one place per page
    (the masthead lockup or a section divider) as a single recurring gradient signature.
    Gallery-wall labeling that secretly loves color. The trap this direction must dodge:
    restraint curdling into blandness — a site nobody could describe an hour later.` },
  { key: 'sticker-sheet',
    push: `DIRECTION 2 — "The sticker sheet." Generous corner radii, saturated category
    chips, oversized friendly headings, springy hover states, award markers that feel
    collectible. Browsing should feel like paging through a beautifully printed toy
    catalog — exuberant on the surface, rigorously tuned underneath, so it lands as
    crafted joy. The trap this direction must dodge: sliding from playful into loud,
    juvenile, or the over-saturated sameness of machine-made design.` },
  { key: 'flagship-calm',
    push: `DIRECTION 3 — "Flagship calm." The register of a top-tier product homepage:
    airy spacing, exact alignment, feathered elevation, one meticulously tuned brand
    gradient doing all the accent work, assured heading type. Sophisticated with a wink.
    The trap this direction must dodge: coming out interchangeable with every polished
    company homepage shipped this year — competent but anonymous.` },
]

const proposals = await parallel(DIRECTIONS.map((D) => () =>
  agent(
    `${SYSTEM}\n\nYour assigned aesthetic direction:\n${D.push}\n\nProduce a complete visual
    system for this catalog in your direction — concrete enough that a stylesheet could be
    written from it without a single follow-up question: literal color values for the canvas
    and accents, the category-hue assignment rule, a full heading/body/code type scale,
    per-component styling for cards, chips, markers, and the detail view, and every
    animation spelled out. All four non-negotiables apply. Taste is the scarce resource:
    state the rules you will hold yourself to so the color stays deliberate. Reply with the
    structured object and nothing else.`,
    { label: `direction:${D.key}`, phase: 'Diverge', schema: PROPOSAL_SCHEMA }
  ).then((p) => (p ? { ...p, _direction: D.key } : null))  // tag provenance; keep null null
))
const valid = proposals.filter(Boolean)
log(`diverge: ${valid.length}/${DIRECTIONS.length} proposals returned`)  // no silent narrowing
if (!valid.length) {
  log('no proposals survived — nothing to grade')
  return { proposals: [], judgment: null }
}

phase('Converge')
const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['scores', 'winner', 'synthesis'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['proposal_name', 'brief_fit', 'distinctiveness', 'browsability', 'buildability', 'total', 'note'],
        properties: {
          proposal_name: { type: 'string' },
          brief_fit: { type: 'number', description: 'honors all four non-negotiables and the parts-that-stay list, 0..10' },
          distinctiveness: { type: 'number', description: 'dodges its own named trap; a visitor could describe this site a week later, 0..10' },
          browsability: { type: 'number', description: 'dense entry grids stay comfortable across long sessions, 0..10' },
          buildability: { type: 'number', description: 'achievable as a pure restyle of the existing components in hand-written CSS, 0..10' },
          total: { type: 'number' },
          note: { type: 'string' },
        },
      },
    },
    winner: { type: 'string' },
    synthesis: {
      type: 'object', additionalProperties: false,
      required: ['concept_summary', 'background_system', 'color_system', 'category_hue_rule',
                 'type_system', 'surface_styling', 'favorites_restyle', 'detail_view_restyle',
                 'motion', 'wordmark_treatment', 'css_variables', 'taste_rules',
                 'application_sequence', 'remove_list'],
      properties: {
        concept_summary: { type: 'string' },
        background_system: { type: 'string' },
        color_system: { type: 'string', description: 'the merged color discipline, with literal accent values and gradient stops' },
        category_hue_rule: { type: 'string' },
        type_system: { type: 'string' },
        surface_styling: { type: 'string' },
        favorites_restyle: { type: 'string' },
        detail_view_restyle: { type: 'string' },
        motion: { type: 'string' },
        wordmark_treatment: { type: 'string' },
        css_variables: { type: 'string', description: 'the custom properties to define, each with its literal value: canvas, text, border, and accent colors, gradient definitions, and the category-hue formula' },
        taste_rules: { type: 'string' },
        application_sequence: { type: 'string', description: 'what to convert first, second, third: variables and fonts, then which components, then which pages' },
        remove_list: { type: 'string' },
      },
    },
  },
}

log(`grading ${valid.length} proposals`)
const judgment = await agent(
  `${SYSTEM}\n\nYou are the reviewing art director. ${valid.length} candidate visual systems
  for this catalog follow, each produced under a different aesthetic direction. First grade
  every candidate 0..10 on brief_fit, distinctiveness, browsability, and buildability, with
  a one-line note apiece. Then produce ONE merged system: take the strongest pieces — canvas
  treatment, color discipline, category-hue rule, award marker, detail view, motion — from
  wherever they appear and unify them into a spec a stylesheet author can implement verbatim.
  Bias toward quiet confidence punctuated by at most two playful signatures. Include literal
  color values, the complete accent gradient, the category-hue assignment rule, and the order
  in which to apply the restyle. Candidate JSON follows.\n\n${JSON.stringify(valid)}`,
  { label: 'director:merge', phase: 'Converge', schema: JUDGE_SCHEMA }
)
if (!judgment) log('director call failed — returning raw proposals only')

return { proposals: valid, judgment }
