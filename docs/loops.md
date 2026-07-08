# Loops

Loops in Agent Script are plain JavaScript `while` and `for` loops. Ultracodex
does not add a loop primitive because the script format is meant to stay
dual-runnable: one JavaScript file, one set of globals, no engine-only syntax.
Breadth is `parallel()`, flow is `pipeline()`, and depth is ordinary JavaScript.

The package ships two reference loops:

- `goal` - a builder-verifier loop for one explicit task and acceptance rubric.
- `loop` - an until-dry finder loop for repeated discovery with deduplication.

## Vocabulary

| Claude Code loop taxonomy | Ultracodex expression | Notes |
|---|---|---|
| goal-based | `ultracodex run goal` | Builder rounds continue until a skeptical verifier approves, rounds cap, budget floor, or agent failure. |
| time-based | `ultracodex schedule` | Cron wakes the run. Add `--until-done` when the workflow returns `{ done: true }`; see [schedule.md](schedule.md). |
| turn-based | interactive sessions | Out of scope for packaged workflows; use the interactive agent surface directly. |

## Goal

`goal` runs one builder agent and one skeptical verifier agent per round. A
project-saved `.ultracodex/workflows/goal.js` shadows the packaged builtin, so
teams can override the default locally without changing commands.

| arg | required | default | notes |
|---|---:|---:|---|
| `task` | yes | - | What to build or do. |
| `criteria` | yes | - | Explicit verifier-checkable acceptance criteria. |
| `maxRounds` | no | `4` | Positive integer round cap. |
| `context` | no | - | Paths or notes included in builder and verifier prompts. |
| `builderModel` | no | engine default | Passed as `model` only when provided. |
| `verifierModel` | no | engine default | Passed as `model` only when provided. |
| `budgetFloor` | no | `20000` | If `--budget` is set and remaining output tokens are below this before a round, the loop stops exhausted. |

CLI:

```bash
ultracodex run goal --args '{"task":"Implement the CSV import UI","criteria":"Build passes. Vitest passes. Users can upload a CSV and see row-level validation errors.","context":"Relevant files: src/import/, tests/import.test.ts"}' --json
```

Nested from another workflow:

```js
const result = await workflow('goal', {
  task: 'Implement the CSV import UI',
  criteria: 'Build passes. Vitest passes. Users can upload a CSV and see row-level validation errors.',
  context: 'Relevant files: src/import/, tests/import.test.ts',
})
if (!result.done) return { done: false, result }
```

Return shape:

```js
{
  done: boolean,
  rounds: number,
  verdict: 'approved' | 'rejected' | 'exhausted',
  issues: string[],
  history: [{ round: number, verdict: 'approved' | 'rejected', issues: string[] }],
}
```

`done: true` means the verifier approved. A final rejected verifier at the round
cap returns `verdict: 'rejected'`; stopping on budget floor or a null agent
return is `verdict: 'exhausted'`.

## Loop

`loop` runs a finder until enough consecutive rounds produce zero fresh
findings. Deduplication is against everything seen, including findings later
rejected by the optional verifier, so the same rejected item cannot reappear
forever.

| arg | required | default | notes |
|---|---:|---:|---|
| `find` | yes | - | Finder instructions for one round. |
| `verify` | no | - | Optional adversarial verifier instructions. When omitted, fresh findings are accepted. |
| `dryRounds` | no | `2` | Consecutive zero-fresh rounds required to converge. |
| `maxRounds` | no | `8` | Positive integer round cap. |
| `dedupBy` | no | `title` | Finding field used as the dedup key; falls back to `title`, then JSON. |
| `finderModel` | no | engine default | Passed as `model` only when provided. |
| `verifierModel` | no | engine default | Passed as `model` only when provided. |
| `budgetFloor` | no | `20000` | If `--budget` is set and remaining output tokens are below this before a round, the loop stops. |

CLI:

```bash
ultracodex run loop --args '{"find":"Find one fresh correctness bug in src/ and tests/. Return precise locations.","verify":"Check each finding by reading the code. real=false when uncertain.","dryRounds":2,"dedupBy":"title"}' --json
```

Nested from another workflow:

```js
const sweep = await workflow('loop', {
  find: 'Find one fresh correctness bug in src/ and tests/. Return precise locations.',
  verify: 'Check each finding by reading the code. real=false when uncertain.',
  dryRounds: 2,
})
if (sweep.findings.length > 0) log(`confirmed ${sweep.findings.length} findings`)
return sweep
```

Return shape:

```js
{
  done: boolean,
  rounds: number,
  dry: boolean,
  findings: [{ title: string, detail: string, location?: string }],
  seenCount: number,
}
```

`done: true` means dry convergence. Hitting `maxRounds`, the budget floor, or a
null agent return gives `done: false`.

## Round Labels

Use one of two forms for loop agents:

| form | example | use |
|---|---|---|
| `<loop>:<role>-r<N>` | `goal:verify-r3` | Packaged or multi-loop scripts where the loop name matters. |
| `<role>-r<N>` | `critique-r3` | Single-loop scripts where the role alone is unambiguous. |

Round phases may be literal titles such as `Round 3`, or role phases such as
`Build`, `Verify`, and `Find`. Keep labels stable across rounds; route by the
role prefix when you want different backends for workers and evaluators.

## Convergence Discipline

Separate worker from evaluator. A builder or finder should not approve its own
work; use a verifier when false positives matter.

Make criteria deterministic. `goal.criteria` should be checkable by reading,
running, or inspecting the project. `loop.verify` should say what counts as real
and what should be rejected when uncertain.

Cap every loop. `maxRounds` is the hard ceiling; dry convergence and verifier
approval are early exits, not substitutes for a ceiling.

Use budget as a governor. With `--budget`, both packaged loops check
`budgetFloor` before each round so the next wave does not cross the hard token
ceiling.

Return `done: true` only on real convergence. That makes loops compose with
scheduled `--until-done` runs; see [schedule.md](schedule.md#the---until-done-contract--a-run-result-object-with-donetrue-retires-the-schedule).
