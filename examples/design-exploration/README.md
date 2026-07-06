# Diverge-then-judge: three decorrelated design directions, one merged spec

**Shape:** lens-injected parallel fan-out → single comparative judge + synthesis

## Problem

I run a small static site: a hand-curated catalog of open-source command-line tools — several hundred entries in a few dozen categories, each with a short factual write-up, a tag row, and an expandable detail view (upsides/downsides, a copy-to-clipboard install snippet, an outbound link). The current skin is a vintage-terminal pastiche — green-on-black, scanline overlays, box-drawing borders, a blinking cursor in the masthead — and I want it replaced wholesale with a warm, modern light theme while every structural element stays exactly where it is: the category filter row, the entry grid, the staff-favorites strip with its little award marker, the detail view, the status markers.

The catch is what happens when I ask an AI for design directions: I get three near-identical safe options — the statistical mean of every landing page ever made. What I actually need:

- **Genuinely different candidates.** Each should commit hard to a distinct aesthetic, and each aesthetic has a known way it degenerates (an austere system turns bland, a playful one turns garish, a polished one turns anonymous). A candidate that hasn't explicitly defended against its own degenerate form is worthless to me.
- **Shared non-negotiables.** Every candidate must honor the same locked decisions — a light canvas that stays comfortable across hour-long dense-grid sessions, per-category hues as the navigation system (disciplined, never a paint-swatch wall), plain factual copy left untouched, literal searchable titles — and must preserve the surviving components. Creativity inside the fence, not over it.
- **Comparability.** Mood-board prose can't be scored or merged. Candidates need to be concrete (literal color values, a real type scale, component-by-component styling, every animation spelled out) and identically structured so I can put them side by side and make a real decision.
- **A buildable ending, not a beauty contest.** The best canvas, the best badge idea, and the best motion rule rarely live in the same candidate. I don't want "pick option B" — I want one merged specification with concrete CSS custom properties and an implementation order, precise enough that the restyle can start immediately with zero design guesswork. The stack is a static site generator with hand-written CSS and no animation library, so anything proposed has to work as a pure restyle of existing components in CSS alone.

## Reference solution

The shape is **diverge-then-judge**: a small parallel fan-out whose members are deliberately decorrelated, followed by a single comparative judge that both scores and synthesizes.

Why it fits: the failure mode being engineered against is *correlated output* — three agents given the same brief converge on the same safe middle. The fix is **lens injection**: every proposer receives the identical `SYSTEM` brief (site context, four non-negotiables, the outgoing look to remove, the components that stay, the build constraints), plus one distinct aesthetic direction appended. Each direction does two jobs — it names the register to commit to *and* names the trap that register falls into (blandness / garish excess / anonymous polish). Naming the degenerate form inside the prompt is what keeps the proposer committed to its corner instead of drifting back to the mean. And because judging is *comparative*, the second phase must be a single agent that sees all candidates at once — per-proposal critics could score in isolation but could never merge.

Walkthrough:

1. **Diverge phase (fan-out of 3).** `parallel()` over the `DIRECTIONS` array; each thunk calls `agent()` with `SYSTEM + direction` and the shared `PROPOSAL_SCHEMA`. The schema forces every proposal into the same 16-field shape — background system, color system, type system, surface styling, badge and detail-view restyles, motion, a `standout_element`, explicit `taste_rules`, and `weak_points` — so the judge compares like with like. Each result is provenance-tagged with `_direction` (null-checked first, so a failed agent stays `null` rather than becoming a truthy husk). After the barrier: `.filter(Boolean)`, a `log()` of the survivor count (no silent narrowing), and an early return if nothing survived.
2. **Converge phase (single agent).** One art-director call receives the same brief plus all surviving proposals serialized as JSON. `JUDGE_SCHEMA` forces three outputs at once: a `scores` array grading every proposal on a fixed four-dimension rubric (brief_fit, distinctiveness, browsability, buildability — 0..10 each, with a note), a named `winner`, and a `synthesis` object. The synthesis schema is where buildability is enforced: required `css_variables` (custom properties with literal values) and `application_sequence` fields mean the judge cannot end at commentary — it must hand back an implementation plan. `taste_rules` reappears as a required synthesis field, so the discipline constraints survive the merge and travel into the build.
3. **Return.** Both the raw proposals and the judgment are returned, so a human can audit the scores against the candidates rather than trusting the merge blindly.

The script also demonstrates the args escape hatch: pass `{ brief: "..." }` as workflow args and the same panel runs against your own site brief, directions unchanged.

## Techniques

- **Lens injection** — identical shared brief + one distinct aesthetic direction per fan-out member, decorrelating parallel outputs by construction.
- **Named-trap framing** — each direction states its own degenerate form in the prompt, so the agent defends against it instead of drifting to the safe middle.
- **Schema-enforced comparability** — one `PROPOSAL_SCHEMA` (consts in CAPS) shared by all proposers, making candidates directly scoreable side by side.
- **Taste rules as a first-class field** — required in both the proposal and the synthesis schemas, so discipline constraints are produced, judged, and propagated into the final spec.
- **Provenance tagging** — `.then((p) => (p ? { ...p, _direction: D.key } : null))` records which direction produced what, without turning a `null` failure into a truthy object.
- **Null-tolerant fan-out** — `.filter(Boolean)` after `parallel()`, a logged survivor count (no silent caps), and an empty-set early return.
- **Single comparative judge** — scoring is relative, so all candidates go to one agent in one context; a fixed numeric rubric plus per-proposal notes keeps the scoring auditable.
- **Synthesis-not-selection** — the judge must merge the strongest elements across proposals, with required `css_variables` and `application_sequence` fields forcing a buildable spec rather than a verdict.
- **Args-driven brief override** — `args?.brief` swaps in a caller-supplied brief so the shape is reusable beyond the example domain.
- **Phase grouping** — `phase('Diverge')` / `phase('Converge')` matching `meta.phases` titles for progress display.
