---
name: agent-script-authoring
description: >-
  Write Agent Script workflow files — deterministic multi-agent orchestration in one plain-JavaScript file, runnable unmodified by Claude Code's Workflow tool and by ultracodex. Use when asked to author, review, or fix a workflow script / Agent Script. Self-contained: no other document is required.
---

# Writing Agent Scripts

An Agent Script is one JavaScript file that orchestrates a fleet of AI agents deterministically: the script decides what fans out, what gets verified, and how results flow; the agents do all the actual reading, writing, and thinking. You are writing the harness, not the workers. The format is model-agnostic and engine-portable — the same file runs on Claude Code's Workflow tool and on ultracodex (engine-implementer spec: `docs/agent-script-spec.md` in the ultracodex repo).

**Part 1 is the contract — violating it breaks the script. Part 2 is the craft — what separates a good workflow from a merely valid one.**

## Part 1 — Core contract

### 1. File shape

- One plain-JavaScript ES module. TypeScript syntax is rejected. No `import`/`export` beyond the meta export, no dynamic `import()`, no `require`, `process`, filesystem, or network — the script itself cannot touch the outside world; only its agents can.
- The first statement is `export const meta = {...}`, and the initializer is a **pure literal**: objects, arrays, strings, numbers, booleans, null only — no variables, calls, spreads, or `${}` interpolation.
- meta fields: `name` (kebab-case) and `description` (one line) required; `whenToUse` and `phases` (array of `{ title, detail? }`) optional. Every `phases[].title` must exactly string-match a `phase()` call in the body, and every phase the body runs should be declared. A step deserves its own phase when it groups agent calls; bookkeeping gets a `log()` line instead.
- Everything after the meta export is evaluated as an async function body: top-level `await` and `return` are legal, and the return value is the run's result.
- Banned as nondeterministic (they break resume/replay): `Date.now()`, `Math.random()`, argless `new Date()`. Pass timestamps in via `args`; vary prompts by index when you need variety. Inside the agents' own work, time and randomness are fine — the ban is on the orchestration script.

### 2. Skeleton

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
  properties: { tests: { type: 'array', items: { type: 'string' } } },
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

The closer of the nested fan-out idiom is the single most common parse failure: in `(await parallel(items.map((x) => () => agent(...))))`, the wrapping paren closes **before** `.filter(Boolean)`. Count the parens on every multi-line `map`/`parallel`/`pipeline` close.

### 3. The eight globals — the complete API

There is nothing else. If you want another import or primitive, restructure so an agent does that work.

**`agent(prompt, opts?) → Promise<string | object | null>`** — spawns one agent. Without `schema` it resolves the agent's final message text; with `schema` (a JSON Schema object) it resolves a validated object, no parsing needed. `opts`:

- `label` — display name; use `verb:target` (`review:auth`, `fix:parser`).
- `phase` — assigns this call to a progress group. Use this **instead of global `phase()`** inside `pipeline`/`parallel` callbacks — the global mutates shared state and races across concurrent items.
- `model` / `effort` — advisory capability tiers (e.g. `'sonnet' | 'opus' | 'haiku' | 'fable'`; effort `'low' | 'medium' | 'high' | 'xhigh' | 'max'`), mapped by each engine, so scripts stay portable. Default: omit both. Override only for clearly mechanical stages (`effort: 'low'`) or the hardest verify/judge stages.
- `isolation: 'worktree'` — a fresh git worktree per agent; costly. The deciding test is **downstream visibility**: if a gate or integrator must see all the parallel agents' edits in one tree, keep them on the shared tree — safe exactly when their file ownership is disjoint. Worktree-isolating disjoint-ownership builders strands their edits where the gate never sees them. Isolate only when parallel writers touch the *same* files, and plan how the surviving worktree merges back.
- `agentType` — an engine-defined agent profile (e.g. a read-only explorer type); the script still runs on engines that map it differently.

**`parallel(thunks) → Promise<any[]>`** — runs an array of `() => Promise` thunks concurrently and waits for all of them (a barrier). A thunk that throws — or whose agent fails — yields `null` at its index; the call itself never rejects.

**`pipeline(items, ...stages) → Promise<any[]>`** — each item flows through all stages independently, with **no cross-item barrier**. Stage callbacks receive `(prev, item, index)`; the first stage's `prev` is the item itself. A stage that *throws* drops its item to null and skips its remaining stages; a stage that *resolves* null does NOT drop the item — later stages run with `prev === null`.

**`phase(title)` / `log(message)`** — progress grouping and narration. Neither affects results, but a script that narrates its coverage decisions is far more trustworthy to whoever is watching it run.

**`args`** — the run's input value, verbatim (`undefined` if none); how one script serves many runs. Read tunables defensively — `const DB = args?.dbPath ?? './data.db'` — a bare top-level `args.x` throws the moment the run launches without args. Structured inputs arrive as real JSON values, never re-encoded strings.

**`budget`** — `{ total: number|null, spent(), remaining() }`, counting output tokens across the whole run; `total` is null when no target was set (then `remaining()` is Infinity — guard loops on `budget.total` first). The ceiling is **hard**: once `spent() ≥ total`, every further `agent()` call throws.

**`workflow(nameOrRef, args?)`** — runs a saved workflow (by name) or a script file (`{ scriptPath }`) as a child sharing this run's caps and budget. Nesting is one level only. Throws catchably on unknown name/path or child syntax error.

Caps, identical on every engine: concurrency auto-capped around 10–16 agents (excess calls just queue), at most 4096 items per `parallel`/`pipeline` call, at most 1000 agent calls per run.

### 4. Nulls and joins — design around failure

The core invariant: **a failed agent call resolves `null`; it does not throw.** Only the budget ceiling and the two caps throw — so don't wrap `agent()` in try/catch: with budget guarded, a catch adds nothing, and a genuine cap overrun *should* abort the run.

- `.filter(Boolean)` after every `parallel()`; null-check `prev` in later pipeline stages and every single awaited result before property access.
- **Identify failures before you filter.** To *name* what failed ("tell me which probe came back empty"), compute identities from the unfiltered results — `ITEMS.filter((it, i) => !results[i])` — because filtering first destroys the index→identity mapping; a survivor count can never say which one is missing.
- **Key results by id, not position.** Put the item's id inside the result schema; never join by array position, `indexOf`, or by indexing two independently filtered arrays — filtering shifts indices and silently misaligns on the first null.
- In loops, the builder AND the verifier can both return null — decide explicitly whether null means retry, skip, or abort. Null-check into a temporary and commit only on success (`const next = await agent(...); if (next) draft = next`) — direct reassignment erases the prior good state exactly when a retry needs it. Guard anything a later iteration reads back; degrading a dead verifier to a synthetic failing verdict (`{ pass: false, issues: ['verifier failed'] }`) beats `continue`, and beats silently losing the item.

### 5. Pre-flight checklist

0. **It parses.** Run `ultracodex validate --strict <file>` FIRST when the CLI is available — it must print `ok: no issues`. Without it, mentally lint and re-read every fan-out closer.
1. Parens balanced on every nested fan-out (§2).
2. meta is a pure literal with name + description; every `phase()` declared in `meta.phases` and exact-matched.
3. No imports/require/fs/process/network, no TypeScript, no `Date.now()`/`Math.random()`/argless `new Date()`.
4. Every null path handled per §4; joins by id; failures identified before filtering.
5. Loops capped or budget-guarded; dedup vs everything *seen*; no later iteration reads state a skipped one never populated.
6. Schemas strict per §7: `additionalProperties: false`, `required` = all keys, closed sets as enums (headline field graded, derived enums gated), strictest schema on the terminal producer, no aggregate rows in item arrays.
7. Fan-outs sized with overhead counted; budget thresholds ≥ one wave's cost; early stops return a slice-bounded resume tuple; all coverage bounds logged.
8. Tunables via `args?.x ?? default` — never a bare top-level `args.x`.
9. Parallel same-file writers isolated per the §3 deciding test; write stages gated by an agent that runs the checks itself (§9).
10. No added stage violates a deliverable-shape constraint (§6).
11. Prompts self-contained; verifiers separate and framed to refute; `phase` passed as an option inside concurrent callbacks.
12. The body returns one compact structured result — one shape per record set.

## Part 2 — Craft reference

### 6. Choosing structure

**Default to `pipeline()`.** A barrier (`parallel()` between stages) is justified only when stage N genuinely needs *all* of stage N−1: dedup/merge across the full set, early-exit when the total is zero, or a prompt that references "the other findings". Not justifications: "I need to flatten/filter first" (do it inside a stage), "the stages are conceptually separate" (that's what pipeline models), "it's cleaner" (barrier latency is real — fast workers idle while the slowest finishes). Smell test: `await parallel(...)` → pure transform → `await parallel(...)` means the transform belongs inside a pipeline stage. When in doubt: pipeline.

The mirror error is adding stages the deliverable forbids: **a fan-out may legitimately end at the fan-out.** When results must stay raw, verbatim, or exactly structured, do not append a synthesizer — the schema *is* the aggregation, and a free-text consolidator cannot be trusted to preserve exact paths and counts even when told not to summarize. Before adding any stage, ask whether its output replaces a deliverable the problem defined more strictly than the stage can guarantee. Extra verification layers carry the same altitude question: stack refute passes when false positives are expensive, not by reflex.

**Loops are the depth axis** (breadth = `parallel`, flow = `pipeline`). There is no loop primitive; use plain `while`/`for`:

```js
let draft = null, verdict = null
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const next = await agent(round === 1 ? DRAFT_PROMPT : revisePrompt(draft, verdict.issues), { phase: `Round ${round}` })
  if (!next) break
  draft = next
  verdict = await agent(critiquePrompt(draft), { schema: VERDICT_SCHEMA, phase: `Round ${round}` })
  if (verdict?.pass) break                      // early exit on first pass
}
```

**Round labels.** Loop agents should be labeled `<loop>:<role>-r<N>`; single-loop scripts may use bare `<role>-r<N>`. Phase titles like `Round 3` fold into the same round view. Engines group these labels into round-based loop displays, and when a verifier returns a top-level `verdict`, `pass`, or `approved` field, that judgment is surfaced in trajectories. Return `{ done: true }` when the script has converged so scheduled `--until-done` runs compose cleanly. Packaged references: `ultracodex run goal` and `ultracodex run loop`.

Cap rounds; guard unbounded loops with `while (budget.total && budget.remaining() > FLOOR)`; and when accumulating findings across rounds, dedup against everything **seen**, not just confirmed — otherwise judge-rejected findings reappear every round and the loop never converges.

### 7. Schemas

Pass `schema` whenever the result is used programmatically: you get a validated object and the engine retries the agent on mismatch. Write for portability and downstream use:

- `additionalProperties: false` and `required` = every key, on every object — some backends only enforce schemas in this strict form. Model optionality as `type: ['string', 'null']` or a sentinel, not an omitted key.
- **Every field the problem names as a fixed set is an `enum`** — verdicts, severities, strata, categories. A boolean is not a three-way verdict; a bare string is not a category set; enums are load-bearing for sorting and bucketing. Doubly so for the *headline* judgment field: even when the wording sounds binary ("whether the record belongs"), grade it — `'in-scope' | 'out-of-scope' | 'unsure'` — the middle tier is where the review value lives.
- **Runtime-derived category sets are a two-part contract**: (a) the derived taxonomy still becomes a closed enum, never a free string; (b) gate on it being non-empty before building the dependent schema, or include an `'uncategorized'` escape member. An empty derived enum makes every downstream schema unsatisfiable and silently drops the whole corpus.
- Aggregates (totals, rollups) get their own top-level field — never a row inside the per-item array, where required judgment fields force meaningless values onto it and pollute every sort.
- **The terminal producer gets the strictest schema.** When a final agent's output *is* the deliverable, require every concrete field the problem demands — a prompt request without a schema invites prose where buildable data was required.
- Property `description`s are prompt material — use them. Keep payloads compact: agents write bulky artifacts to files and return paths/counts/verdicts, and each record set is emitted in exactly one shape.

### 8. Prompting the workers

- Each agent starts blank — no history, no sibling awareness. Every prompt restates context, exact file paths, and output expectations. Agents are told their final message IS the return value: say "return only the JSON — no preamble".
- Factor shared context into consts and compose per-agent deltas (same-prefix prompts are also cache-friendly). **One frozen source of truth**: a locked brief, rubric, or contract is one const interpolated verbatim at every call site — never let a pre-stage agent paraphrase it for some consumers while others get the original.
- Use real line breaks inside template literals — a written-out `\\n` ships literal backslash-n text and silently degrades the prompt's structure.
- Verifiers are **separate agents framed to refute** ("try to refute this finding; default to refuted if uncertain") — a producer checking itself controls nothing.
- Read-only stages state the guardrail in the prompt ("investigate only; change nothing") *and* use a read-only `agentType` where available.
- Builders/fixers get an objective green signal ("iterate until typecheck + tests pass; never finish red") and return a structured report — but **a fixer's self-reported `checksPassed: true` is not a gate**. When the problem demands the suite stays green, a separate gate agent runs the checks itself, and re-gates after any conditional fix stage before further work builds on top.
- **Never pre-author an agent's committed answer.** If a schema field exists to extract the agent's own defense against a named risk, name the trap but don't answer it — an injected defense turns the required field into an echo of your prose.

### 9. Rails for scale

- **Resumability**: take `args.start`/`args.count` slice bounds and chunk the fan-out into waves. On every early stop, `log()` is not enough — the return value carries a copy-pasteable resume tuple, with `count` bounded by the *original* slice end, never widened to the whole corpus. Coverage math runs over the slice `[start, start+count)`, never the full corpus, or a partial run reports everything outside its slice as missing.
- **Call-budget accounting**: overhead counts against the 1000-call cap — budget it as `attempts + ceil(attempts/waveSize) checkpoint/gate calls + fixed overhead ≤ 1000`. For large corpora, batch items into workers via index-range shards; the orchestrator never holds corpus content — each worker gets a range plus the file/db path and reads its own slice.
- **Budget rail**: between waves or rounds, check `budget.total && budget.remaining() < THRESHOLD`, with THRESHOLD ≥ one wave's worst-case output cost (≈ waveSize × items × tokens-per-item) — a magic number below that lets the next wave cross the hard ceiling and throw, the exact crash the rail exists to prevent. The rail is mandatory whenever the problem says the budget is tight or the run is unattended; a round cap alone is not a rail. Companion lever: `effort: 'low'` on mechanical map/judge agents is usually the biggest control on whether the rail ever fires.
- **No silent caps**: whenever coverage is bounded — top-N, sampling, early stop, failed items — `log()` exactly what was dropped. A run that silently truncates reads as "covered everything".
- **Pilot before scale**: for expensive per-item transforms over thousands of items, run a stratified sample end-to-end and return a quality report for human sign-off first. The scout derives the taxonomy AND picks the sample in one agent (a sample chosen blind to just-discovered categories can't cover them), and membership re-checks are three-way, never boolean.

### 10. Shape catalog

Ten shapes cover essentially all real workflows (from a census of 58 production scripts). Pick the dominant one, then compose. Worked examples ship alongside this skill: the `examples/` directory at the package root (two levels up from this file), one directory per shape — a README with the problem statement plus a reference `workflow.js`. Read one when you want a worked reference for your shape; the contract above is sufficient without them.

| Shape | Use when | Core trick |
|---|---|---|
| **research-sweep** | Broad question, one context can't hold it | Facet prompts on a shared preamble + one findings schema; the raw structured results ARE the deliverable — no synthesizer |
| **fanout-synthesize** | Many partial views → one artifact | Parallel extractors → `.filter(Boolean)` → single synthesizer (+ optional critique pass) |
| **map-over-corpus** | Same judgment per item, big N | Index-range shards, waves under the cap, `args` offsets with resume tuple on early stop, `effort:'low'` judges, self-verification in each worker |
| **pilot-then-full** | Unproven prompt × expensive corpus | ONE scout: taxonomy + stratified sample → sample fan-out (three-way membership enum) → quality report → human gate |
| **review-verify-fix** | Findings where false positives are costly | Dimension reviewers → dedup in plain JS by key (an agent asked to dedup *selects* ids, never re-emits records) → 2 refute-by-default skeptics per finding → conditional fixer, gate re-runs the suite |
| **verify-sweep** | Pure QA of finished artifacts | Item × lens cross-product, severity-enum verdicts, failed verifiers degrade to synthetic findings |
| **staged-build-gates** | Build with real dependency order | Waves of builders (disjoint ownership, shared tree) → gate agent that **runs** typecheck+tests (a source-text diff is not a gate) and fixes whichever side the contract deems wrong → re-verify → integrator loops to green |
| **actor-critic-loop** | One artifact must satisfy an exacting bar | Draft → schema'd `{pass, issues}` critic → revise on issues → repeat until pass/cap (§6 loop) |
| **design-exploration** | Divergent options, not three safe ones | Same brief + a distinct lens per agent ("the failure mode you must beat" — named, never answered for them) → one judge synthesizes a merged buildable spec |
| **judge-panel** | Wide solution space, one winner | N independent attempts from different angles → judges score → synthesize from winner, graft runners-up |

Ranking rule for the judged shapes: when the deliverable requires comparing, ranking, or merging candidates, judging happens in **one agent that sees all candidates together** — isolated per-candidate critics can score but cannot rank, pick, or merge.
