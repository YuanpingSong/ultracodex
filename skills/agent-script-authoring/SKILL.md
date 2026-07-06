---
name: agent-script-authoring
description: >-
  Write Agent Script workflow files — deterministic multi-agent orchestration
  in one plain-JavaScript file, runnable unmodified by Claude Code's Workflow
  tool and by ultracodex. Use when asked to author, review, or fix a workflow
  script / Agent Script. Self-contained: no other document is required.
---

# Writing Agent Scripts

An Agent Script is one JavaScript file that orchestrates a fleet of AI
agents deterministically: the *script* decides what fans out, what gets
verified, and how results flow; the *agents* do all the actual reading,
writing, and thinking. You are writing the harness, not the workers.

This skill is model-agnostic. Any agent that can write plain JavaScript can
author Agent Scripts; the format is defined by contract, not by any one
vendor's runtime. (Spec, for engine implementers:
`docs/agent_script_spec.md` in the ultracodex repo.)

## 1. The file contract

- **One ECMAScript module**, plain JavaScript. TypeScript syntax
  (annotations, interfaces, generics) is rejected at load time.
- The **first statement** must be `export const meta = {...}` where the
  initializer is a **pure literal**: objects, arrays, strings, numbers,
  booleans, null, and zero-interpolation template strings only. No
  variables, no function calls, no spreads, no `${}`.
- **meta fields**: `name` (required, kebab-case), `description` (required,
  one line), `whenToUse` (optional), `phases` (optional array of
  `{ title, detail? }`). Each `phases[].title` must **exactly match** a
  `phase()` call in the body — matching is by string equality. Declare
  *every* phase the body runs: undeclared `phase()` groups are legal but
  lose the run's upfront progress map. A step deserves its own phase when
  it groups agent calls; a step that's just bookkeeping gets a `log()`
  line inside the current phase.
- Everything after the meta export is the **body**, evaluated as an async
  function body: top-level `await` and top-level `return` are legal. The
  body's return value is the run's result.
- **No other `import`/`export` statements**, no dynamic `import()`, no
  `require`, no `process`, no filesystem or network APIs. The script itself
  cannot touch the outside world — only its agents can.

## 2. Skeleton

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}

const FLAKY_SCHEMA = {
  type: 'object',
  properties: {
    tests: { type: 'array', items: { type: 'string' } },
  },
  required: ['tests'],
  additionalProperties: false,
}

phase('Scan')
const scan = await agent('Grep the CI logs under ./logs for retry markers; return every flaky test name.', { schema: FLAKY_SCHEMA })
if (!scan) return { error: 'scan agent failed' }

phase('Fix')
const fixes = (await parallel(scan.tests.map((t) => () =>
  agent(
    `Diagnose why test "${t}" is flaky and fix it. Run the test 5x to confirm stability.`,
    { label: `fix:${t}` },
  ),      // <- closes agent(
)))       // <- closes map(, then parallel(, then the (await ...) wrapper
  .filter(Boolean)

log(`${fixes.length}/${scan.tests.length} tests fixed`)
return { fixed: fixes.length, of: scan.tests.length }
```

Note the closer of the nested fan-out idiom: the wrapping paren in
`(await parallel(items.map((x) => () => agent(...))))` must be closed
**before** `.filter(Boolean)`. Unbalanced closers on exactly this
multi-line construct are the single most common way authored scripts fail
to parse — count the parens on every `map`/`parallel`/`pipeline` close.

## 3. The complete API — eight injected globals

There is nothing else. If you find yourself wanting another import or
primitive, restructure so an agent does that work.

### `agent(prompt, opts?) → Promise<string | object | null>`

Spawns one agent. Without `schema`, resolves the agent's final message
text. With `schema` (a JSON Schema object), resolves an object validated
against that schema.

`opts`: `{ label?, phase?, schema?, model?, effort?, isolation?, agentType? }`

- `label` — display name; use `verb:target` (e.g. `review:auth`,
  `fix:parser`) so progress views read well.
- `phase` — assigns this call to a progress group explicitly. **Use this
  instead of `phase()` inside `pipeline()`/`parallel()` callbacks** —
  `phase()` mutates global state and races across concurrent items.
- `model` — advisory capability tier (e.g. `'sonnet' | 'opus' | 'haiku' |
  'fable'` on the reference engine). Engines map tiers to their own models;
  scripts stay portable. **Default: omit** — the engine's default is almost
  always right. Override only when a stage is clearly cheap-mechanical or
  clearly hardest-difficulty.
- `effort` — reasoning effort: `'low' | 'medium' | 'high' | 'xhigh' |
  'max'`. Omit to inherit. `'low'` for mechanical stages (classify,
  extract, reformat), high tiers for the hardest verify/judge stages.
- `isolation: 'worktree'` — runs the agent in a fresh git worktree. Costly
  per agent; use **only** when parallel agents mutate the same files and
  would conflict. Disjoint file ownership does not need it. **Hard rule:**
  scaling any write-capable stage (fixers, builders) to `parallel()` over a
  shared working tree *requires* `isolation: 'worktree'` on each — without
  it the agents trample each other's edits and each one runs the project's
  checks against a tree its siblings are mutating mid-flight.
- `agentType` — an engine-defined agent profile (e.g. a read-only explorer
  type). Engine-specific; the script still runs on engines that map it
  differently or fall back to the default agent.

### `parallel(thunks) → Promise<any[]>`

Runs an array of `() => Promise` thunks concurrently and **waits for all of
them** (it is a barrier). A thunk that throws — or whose agent fails —
yields `null` at its index; `parallel()` itself never rejects. Always
`.filter(Boolean)` before using the results.

### `pipeline(items, stage1, stage2, ...) → Promise<any[]>`

Runs each item through all stages **independently — no barrier between
stages**. Item A can be in stage 3 while item B is still in stage 1. Stage
callbacks receive `(prevResult, originalItem, index)`; for the first stage
`prevResult` is the item itself. A stage that *throws* drops its item to
`null` and skips its remaining stages; a stage that *resolves* `null` (a
failed agent) does **not** drop the item — later stages run with
`prev === null`, so null-check.

### `phase(title)` / `log(message)`

`phase()` starts a new progress group for subsequently *started* agent
calls. `log()` emits a narrator line. Neither affects results — but a
script that narrates its progress and its coverage decisions is far more
trustworthy to the person watching it run.

### `args`

The run's input value, verbatim (`undefined` if none). This is how one
script serves many runs: pass file lists, offsets, questions, or config as
real JSON values. Never JSON-encode arrays into strings.

### `budget`

`{ total: number|null, spent(): number, remaining(): number }` — output
tokens across the whole run; `total` is `null` when the caller set no
target. The ceiling is **hard**: once `spent() ≥ total`, every further
`agent()` call **throws**. Guard loops on `budget.total` first — with no
target, `remaining()` is `Infinity`.

### `workflow(nameOrRef, args?) → Promise<any>`

Runs another saved workflow (by name) or script file (`{ scriptPath }`) as
a child sharing this run's caps and budget. Nesting is **one level only**.
Throws (catchably) on unknown name/path or child syntax error.

## 4. Failure semantics — design around `null`

The single most important invariant: **a failed agent call resolves `null`;
it does not throw.** (The only throws you'll see from `agent()`: budget
exhausted, the 1000-calls-per-run lifetime cap, the 4096-items-per-call
fan-out cap.)

Consequences you must write for:

- `.filter(Boolean)` after every `parallel()`.
- Null-check `prev` in every pipeline stage after the first.
- Null-check single awaited agents before touching properties.
- In loops, both the builder **and the verifier** can come back `null` —
  decide explicitly whether null means retry, skip, or abort. If null means
  *skip*, anything a later iteration reads back (accumulators, the previous
  verdict, a feedback source) must be guarded for the not-yet-populated
  case; degrading the verifier to a synthetic failing verdict is usually
  safer than `continue`, because control flow then never dereferences an
  empty history.
- Prefer degrading to a synthetic finding (`{ pass: false, issues:
  ['verifier failed'] }`) over silently losing an item.
- **Key results by id, not by position.** When fan-out results must be
  joined back to their inputs, put the item's id *inside* the result
  schema. Never rely on array position, `indexOf` of returned objects, or
  index-joining two independently `.filter(Boolean)`-ed arrays — filtering
  shifts indices and silently misaligns the join on the first `null`.
- Don't wrap `agent()` in `try/catch` by default. It only throws on the
  budget ceiling and the two caps; if you already guard loops on
  `budget.total`, a catch adds nothing. Let a genuine cap overrun abort the
  run — that's the signal working as designed.

## 5. Determinism rules (breaking these breaks resume)

Banned in the script body: `Date.now()`, `Math.random()`, argless
`new Date()`. Engines replay finished agent calls from a journal when a run
is resumed or edited; nondeterministic script code would desynchronize the
replay. Need a timestamp? Pass it in via `args`. Need variety across
agents? Vary the prompt/label by index. (Inside *agents'* work, time and
randomness are fine — the ban is on the orchestration script.)

## 6. Choosing structure

**Default to `pipeline()`.** A barrier (`parallel()` between stages) is
justified only when stage N genuinely needs *all* of stage N−1:
- dedup/merge across the full result set before expensive downstream work;
- early-exit when the total count is zero;
- a prompt that references "the other findings".

Not justifications: "I need to flatten/map/filter first" (do it inside a
stage), "the stages are conceptually separate" (that's what pipeline
models), "it's cleaner" (barrier latency is real — the fast finders idle
while the slowest finishes).

The mirror error is adding stages the deliverable forbids: **a fan-out may
legitimately end at the fan-out.** When the problem says results must stay
raw, verbatim, or exactly-structured, do NOT append a synthesizer — the
schema *is* the aggregation, and a free-text consolidation agent cannot be
trusted to preserve exact paths, sizes, and counts even when told not to
summarize. Before adding any stage, ask: does this stage's output replace a
deliverable the problem defined more strictly than this stage can
guarantee? Extra verification passes carry the same altitude question —
each refute/audit layer multiplies calls; stack them when false positives
are expensive, not by reflex.

Smell test — if you wrote:

```js
const a = await parallel(...)
const b = transform(a)              // no cross-item dependency
const c = await parallel(b.map(...))
```

that middle transform doesn't need the barrier; fold it into a pipeline
stage. When in doubt: pipeline.

**Loops are the depth axis** (breadth = `parallel`, flow = `pipeline`).
There is no loop primitive; use plain `while`/`for`:

```js
let draft = null, verdict = null
for (let round = 1; round <= MAX_ROUNDS; round++) {
  draft = await agent(round === 1 ? DRAFT_PROMPT : revisePrompt(draft, verdict.issues), { phase: `Round ${round}` })
  if (!draft) break
  verdict = await agent(critiquePrompt(draft), { schema: VERDICT_SCHEMA, phase: `Round ${round}` })
  if (verdict?.pass) break                      // early exit on first pass
}
```

Loop rules: cap rounds; guard unbounded loops with
`while (budget.total && budget.remaining() > FLOOR)`; when accumulating
findings across rounds, dedup against **everything seen**, not just
confirmed items — otherwise judge-rejected findings reappear every round
and the loop never converges.

## 7. Structured output

Pass `schema` whenever you'll use the result programmatically — you get a
validated object, no parsing, and the engine retries the agent on
mismatch. Write schemas for portability:

- `additionalProperties: false` and `required: <every key>` on every
  object. Some backends only enforce schemas in this "strict" form;
  authoring this way runs identically everywhere. Model optionality as
  `type: ['string', 'null']` or a sentinel (e.g. empty string) instead of
  omitting keys.
- **Any field the problem describes as a fixed set must be an `enum`** —
  verdicts, severities, strata, categories, membership tiers. A boolean is
  not a substitute for a three-way verdict; a bare string is not a
  substitute for a named category set. Enums are load-bearing downstream:
  severity-first fixing and bucket aggregation only work when the values
  are closed. This applies **doubly to the headline judgment field** — the
  one that carries the deliverable's primary call (fit, membership,
  verdict). Even when the problem's wording sounds binary ("whether the
  record belongs"), model it with a graded enum (e.g.
  `'in-scope' | 'out-of-scope' | 'unsure'`): the middle tier is where all
  the human-review value lives.
- Add `description` fields to properties: they are prompt material and
  meaningfully improve output quality.
- **The terminal producer gets the strictest schema.** When a final
  synthesis/merge agent's output *is* the run's deliverable, its schema
  must require every concrete field the problem demands (tokens, ordered
  steps, exact values) — a prompt request without a schema invites prose
  where the problem demanded buildable data.
- Keep result payloads compact; agents should write bulky artifacts to
  files and return paths/counts/verdicts. Don't emit the same records in
  two shapes (a per-group view *and* a flattened queue of the identical
  findings) — pick the one the consumer needs.

## 8. Prompting the workers

- Each agent starts blank: no conversation history, no sibling awareness.
  Every prompt must be self-contained — restate context, name exact file
  paths, define output expectations.
- Agents are told their final message IS the return value. Say "return
  only the JSON / the list / the diff — no preamble".
- Factor shared context into a `const PREAMBLE = ...` and compose per-agent
  deltas — same-prefix prompts are also cache-friendly.
- Use **real line breaks** inside template-literal prompts. A `\n` escape
  works, but authors who *intend* paragraph breaks and write `\\n` (or
  build prompts in raw strings) ship literal backslash-n text to the agent
  and silently degrade the prompt's structure. Multi-line templates with
  actual newlines are the safe default.
- Verification prompts: **separate agent, refute-by-default framing**
  ("Try to refute this finding; default to refuted if uncertain"). Asking
  the producer to check itself doesn't control false positives.
- Read-only stages: state the guardrail in the prompt ("investigate only;
  change nothing") — and use a read-only `agentType` where available.
- Fixer/builder agents: give them an objective green signal ("iterate
  until typecheck + tests pass; never finish red") and require a
  structured report of what they did.

## 9. Rails for scale

Engines cap concurrency automatically (≈10–16 agents at once; queued calls
just wait), cap one `parallel()`/`pipeline()` at 4096 items, and cap a run
at 1000 agent calls. Within those:

- **Resumability**: for big corpora, take `args.start`/`args.count` slice
  bounds so an interrupted run restarts where it stopped, and chunk the
  fan-out into waves. Two corollaries: (a) on *every* early stop, don't
  just `log()` what was dropped — the **return value must carry a
  copy-pasteable resume tuple** (e.g. `{ start: nextStart, count }`); (b)
  coverage/"missing" accounting is computed over the current slice
  `[start, start+count)`, never the whole corpus — otherwise a partial run
  reports everything outside its slice as missing.
- **Call-budget accounting**: overhead calls count against the 1000-call
  lifetime cap too. Before sizing a fan-out, budget it:
  `attempts + ceil(attempts/waveSize) checkpoint/gate calls + fixed
  overhead ≤ 1000`. For very large corpora the primary knob is **batching
  several items into one worker** (index-range shards over a shared input),
  not one-agent-per-item — and the orchestrator should never hold corpus
  content: give each worker its index range and the file/db path, and let
  it read its own slice, instead of `JSON.stringify`-ing items into
  prompts.
- **Budget rail**: between waves or rounds, check
  `budget.total && budget.remaining() < THRESHOLD` and stop early. Its
  companion lever: `effort: 'low'` on the mechanical per-item map/judge
  agents is often the single biggest control on whether the rail ever
  fires — tier the effort *before* tuning the threshold.
- **No silent caps**: whenever the script bounds coverage — top-N,
  sampling, early stop, failed items — `log()` exactly what was dropped.
  A run that silently truncates reads as "covered everything" when it
  didn't.
- **Pilot before scale**: for expensive per-item transforms over thousands
  of items, run a stratified sample end-to-end and return a quality report
  for human sign-off before the full run. When the pilot derives a
  taxonomy *and* picks the sample, keep those in **one agent** — a sample
  chosen blind to just-discovered categories can't cover them. Membership
  re-checks in the pilot are three-way
  (`'in-scope' | 'out-of-scope' | 'unsure'`), never boolean.

## 10. Shape catalog

Ten shapes cover essentially all real workflows (drawn from a census of 58
production scripts). Pick the dominant one, then compose. Reference
implementations with worked problem statements: `examples/` in the
ultracodex repo.

| Shape | Use when | Core trick |
|---|---|---|
| **research-sweep** | Broad question, one context can't hold it | Facet prompts on a shared preamble + one findings schema; the fan-out's raw structured results ARE the deliverable — adding a synthesizer violates a keep-it-raw constraint |
| **fanout-synthesize** | Many partial views → one artifact | Parallel extractors → `.filter(Boolean)` → single synthesizer (+ optional single critique pass) |
| **map-over-corpus** | Same judgment/transform per item, big N | Shard in JS, waves under the cap, `args` offsets for resume (returned on early stop), `effort:'low'` judges, self-verification inside each worker |
| **pilot-then-full** | Unproven prompt × expensive corpus | ONE scout derives taxonomy + stratified sample together → sample fan-out (three-way membership enum, never boolean) → quality report → human gate |
| **review-verify-fix** | Findings where false positives are costly | Dimension reviewers → dedup → 2 refute-by-default skeptics per finding → conditional fixer, suite kept green (parallel fixers ⇒ `isolation:'worktree'` each) |
| **verify-sweep** | Pure QA of finished artifacts | Item × lens cross-product, severity-enum verdicts, failed verifiers degrade to synthetic findings |
| **staged-build-gates** | Build with real dependency order | Waves of parallel builders (disjoint file ownership) → gate agent reconciling against a contract doc → integrator loops to green |
| **actor-critic-loop** | One artifact must satisfy an exacting bar | Draft → schema'd `{pass, issues}` critic → revise on issues → repeat until pass/cap (see §6 loop) |
| **design-exploration** | Divergent options wanted, not three safe ones | Same brief + a distinct assigned lens per agent ("the failure mode you must beat") → rubric judge synthesizes a merged spec |
| **judge-panel** | Wide solution space, one winner needed | N independent attempts from different angles → parallel judges score → synthesize from winner, graft runners-up |

## 11. Pre-flight checklist

Before returning a script, verify:

0. **It parses.** A script that doesn't parse fails everything else
   automatically. If the ultracodex CLI is available, run
   `ultracodex validate --strict <file>` FIRST — it must print
   `ok: no issues`. No CLI? Mentally lint, then re-read every
   `map`/`parallel`/`pipeline` closer.
1. **Parens balanced** on every nested fan-out: the
   `(await parallel(items.map((x) => () => agent(...))))` wrapper closes
   *before* `.filter(Boolean)` (§2).
2. First statement is `export const meta = {...}`, pure literal, with
   `name` + `description`; every `phase()` the body runs is declared in
   `meta.phases` and matches by exact string.
3. No imports/require/fs/process/network; no TypeScript syntax; no
   `Date.now()` / `Math.random()` / argless `new Date()`.
4. Every `parallel()` result is `.filter(Boolean)`-ed or null-handled;
   every pipeline stage null-checks `prev`; single agent results are
   null-checked before property access; results are keyed by id, never
   joined by array position after filtering.
5. Loops: round caps or budget guards; dedup vs *seen*; no later
   iteration reads state a skipped iteration never populated.
6. Schemas: `additionalProperties: false`, `required` = all keys, an
   `enum` for every field the problem named as a closed set; the terminal
   producer carries the strictest schema.
7. Fan-outs sized with overhead counted (≤4096/call; attempts + gate/
   checkpoint calls ≤1000/run); coverage bounds are `log()`-ed AND early
   stops `return` a concrete resume tuple.
8. Tunables come from `args` (paths, slice bounds, batch sizes) rather
   than hard-coding; structured inputs are consumed as real values.
9. Parallel write-capable agents on a shared tree each carry
   `isolation: 'worktree'`.
10. No added stage violates an explicit deliverable-shape constraint
    (raw-results problems get no synthesizer; §6).
11. Prompts are self-contained; verifiers are separate agents framed to
    refute; `phase` passed as an option inside concurrent callbacks (not
    the global `phase()`).
12. The body `return`s a compact, structured result — one shape per
    record set.
