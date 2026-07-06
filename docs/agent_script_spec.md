# Agent Script — Language & Runtime Specification

**Version 0.1 (draft) · 2026-07-03**

Agent Script is a portable format for multi-agent orchestration programs:
plain JavaScript over a small injected API, executable unmodified by any
conforming engine. It originated as the script format of Claude Code's
Workflow tool; this document derives from that tool's description
(`fixtures/workflow_schema.json`, snapshot 2026-07-06, verified against a
live session clause-by-clause — see ADR-0003 Phase A) and from the
ultracodex implementation and test suite.

**Authority.** The upstream Claude Code Workflow tool is the reference
implementation. Clauses below are transcriptions of upstream behavior unless
flagged:
- **[CLARIFICATION]** — upstream is silent; this is our ruling, believed
  compatible.
- **[EXTENSION]** — ultracodex-specific; MUST be invisible at the script
  level (config-side only) to preserve portability.

The key words MUST, MUST NOT, SHOULD, MAY are per RFC 2119.

---

## 1. Terminology

- **Script** — one Agent Script source file.
- **Engine** — a conforming runtime (upstream Workflow tool, ultracodex).
- **Agent call** — one `agent()` invocation: a prompt executed by a backend
  AI agent, returning text or a schema-validated object.
- **Backend** — the executor an engine routes an agent call to
  [EXTENSION: upstream has a single implicit backend].
- **Run** — one execution of a script; its result is the body's return value.

## 2. File grammar

1. A script is a UTF-8 text file parseable as an ECMAScript module
   (`ecmaVersion: "latest"`, `sourceType: "module"`).
2. The **first statement** MUST be exactly one export:
   `export const meta = <PureLiteral> ;`
3. **PureLiteral** — the initializer MUST consist only of these AST forms
   (recursively): `ObjectExpression` (non-computed keys),
   `ArrayExpression`, `Literal` (string / number / boolean / null),
   `TemplateLiteral` with **zero** interpolation expressions, and
   `UnaryExpression` `+`/`-` applied to a numeric literal. Identifiers,
   calls, member access, and spreads MUST be rejected at load time.
4. **meta fields** — `name` (required; SHOULD be kebab-case; for saved
   workflows MUST equal the filename stem), `description` (required),
   `whenToUse` (optional), `phases` (optional array of
   `{ title, detail?, model? }`). `phases[].title` values are matched
   exactly against `phase()` calls for progress grouping; `phases[].model`
   is display metadata, not a runtime model override (see §5.1).
5. **Body** — every statement after the meta export. Engines evaluate the
   body as the body of an async function receiving the host bindings (§3);
   consequently top-level `await` and top-level `return` are legal.
6. The body MUST NOT contain further `import` or `export` declarations.
   Dynamic `import()` MUST NOT be used (no module resolver is provided).
   [CLARIFICATION]
7. TypeScript syntax (annotations, interfaces, generics) MUST be rejected.

## 3. Host environment

1. **Injected bindings** (the complete API): `agent`, `parallel`,
   `pipeline`, `phase`, `log`, `args`, `budget`, `workflow` (§5).
2. **Available intrinsics**: the realm's standard ECMAScript built-ins
   (`JSON`, `Math`, `Promise`, `structuredClone`, …) plus `console`
   (diagnostic; MAY be redirected to stderr), timers
   (`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`),
   `queueMicrotask`, `URL`, `TextEncoder`/`TextDecoder`. [CLARIFICATION:
   exact list beyond ECMAScript built-ins]
3. **Not available**: `require`, `process`, filesystem, network, `Buffer`.
   Scripts do I/O only through their agents. [CLARIFICATION]
4. **Banned nondeterminism**: `Date.now()`, `Math.random()`, and `new
   Date()` with no arguments (resume determinism). Upstream throws at
   runtime unconditionally. ultracodex throws only in strict mode (§7) and
   otherwise warns via `validate` [EXTENSION: leniency]. The **portable
   subset** (§10) bans them.
5. A conforming script cannot detect which engine it is running on through
   the orchestration API. Engines MUST NOT add script-visible extensions.

## 4. Execution model

1. The run result is the body's return value (serialized as the run's
   `result`); an uncaught body throw fails the run.
2. **Concurrency**: agent calls are admitted by a counting semaphore,
   default `min(16, hostCores − 2)` (configurable); excess calls queue FIFO.
3. **Caps** (identical in all engines): at most **1000** agent calls per run
   lifetime — the 1001st throws; a single `parallel()`/`pipeline()` call
   accepts at most **4096** items — more throws synchronously.
4. Engines MAY expose pause/resume/skip/stop controls. Pause gates new
   admissions only (soft pause). A skipped agent call resolves `null`
   with status "skipped". After stop, pending and subsequent agent calls
   resolve `null`; engines MUST yield the event loop before resolving so
   null-tolerant loops cannot spin. [CLARIFICATION]

## 5. Host API semantics (normative core)

### 5.1 `agent(prompt, opts?) → Promise<string | object | null>`

- `prompt` is coerced with `String()`. [CLARIFICATION]
- `opts`: `{ label?, phase?, schema?, model?, effort?, isolation?,
  agentType? }`; `effort ∈ low | medium | high | xhigh | max`;
  `isolation` only value: `"worktree"`.
- Without `schema`: resolves the agent's **final message text** (string).
- With `schema` (JSON Schema object): resolves an object that **validates
  against the authored schema** (§6).
- **Failure semantics — the core invariant.** The promise resolves `null`
  when the agent fails terminally, is skipped, or exhausts schema repair.
  It MUST NOT reject, with exactly these exceptions, which THROW:
  budget exhaustion (§5.7), the lifetime cap, and the fan-out cap (§4.3).
  Engine-internal I/O errors (snapshots, bookkeeping) MUST degrade to
  `null` + diagnostic, never a throw. [CLARIFICATION]
- `model` and `effort` are **advisory tier names**, mapped to backend
  models by engine configuration; the semantic (relative capability/cost
  tier) is preserved, not the model identity. When omitted, the engine's
  default model/effort applies (upstream: the session model). `meta.
  phases[].model` does NOT set a runtime model (upstream treats it as
  display metadata; verified against the reference 2026-07-02).
- Engines MAY prepend prompt contracts (e.g. "your final message IS the
  return value"); scripts MUST NOT depend on exact prompt bytes.
- `isolation: "worktree"`: the agent runs in a fresh detached git worktree.
  After the call the engine MUST remove the worktree iff it is pristine
  (no uncommitted changes AND no commits beyond its base); otherwise keep
  it and report its path.
- `agentType` selects an engine-defined agent profile (upstream: subagent
  registry; ultracodex: config profiles — sandbox + preamble). Profiles
  are engine configuration; the same script runs regardless.

### 5.2 `parallel(thunks) → Promise<any[]>`

- Barrier: resolves only when all thunks settle. Result order = input
  order. Thunks are invoked eagerly at call time.
- A thunk that throws or rejects yields `null` at its index; the
  `parallel()` promise itself MUST NOT reject.
- \>4096 thunks: throws synchronously.

### 5.3 `pipeline(items, ...stages) → Promise<any[]>`

- Each item flows through all stages **independently — no cross-item
  barrier**: stage k+1 for item i starts when stage k for item i settles,
  regardless of other items' progress.
- Stage callback signature: `(prevResult, originalItem, index)`. For the
  **first** stage, `prevResult` is the item itself. [CLARIFICATION]
- A stage that **throws** drops that item to `null` and skips its remaining
  stages. A stage that **resolves `null`** — notably a failed `agent()` call
  (§5.1) — does NOT drop the item: subsequent stages run and receive
  `prev = null`, and SHOULD null-check it. [CLARIFICATION]
- Result order = input order. >4096 items: throws synchronously.

### 5.4 `phase(title)`

Sets the current phase for subsequently started agent calls (mutable global
state); `opts.phase` overrides per call. Engines use phases for progress
grouping; phases have no effect on results.

### 5.5 `log(message)`

Emits a `String()`-coerced narrator line to the run's progress surface.

### 5.6 `args`

The run's input value, verbatim; `undefined` when absent. Engines MUST pass
structured inputs as real values, never re-encoded strings.

### 5.7 `budget`

`{ total: number | null, spent(): number, remaining(): number }`.
- `spent()` = **output tokens** consumed by the run's agent calls across all
  backends. `remaining()` = `max(0, total − spent())`, or `Infinity` when
  `total` is `null`.
- Hard ceiling: the engine MUST check before dispatch; once
  `spent() ≥ total`, every subsequent `agent()` call THROWS.
- Per-backend ledgers and `--budget` interpretation are engine configuration
  [EXTENSION].

### 5.8 `workflow(nameOrRef, args?) → Promise<any>`

- `nameOrRef`: a saved workflow name, or `{ scriptPath }`.
- The child shares the parent run's agent-ordinal counter, semaphore,
  budget, and journal; child phases are namespaced under the child's name.
- **Nesting depth is exactly 1**: a child calling `workflow()` throws.
- Unknown name / unreadable path / child syntax error: throws (catchable).
- Returns the child body's return value; child failures propagate as throws.

### 5.9 Loops (convergence patterns)

Loops are ordinary JavaScript — there is no dedicated loop primitive, and
conforming engines MUST NOT add one (it would break portability). The
format's three composition axes are: `parallel()` for breadth, `pipeline()`
for flow, and **loops for depth** — iterating until a result converges.

Normative requirements:
- Engines MUST support long-running loops: agent admission is governed only
  by the semaphore (§4.2) and caps (§4.3), and post-stop `null` resolution
  MUST yield the event loop (§4.4) so `while (true)` loops cannot starve it.
- Scripts SHOULD guard unbounded loops on `budget.total` — with no budget
  set, `remaining()` is `Infinity` and the loop runs to the lifetime cap.
- Loop bodies MUST null-check every agent result before use (§5.1): both
  the builder and the verifier can resolve `null`.

Canonical forms (non-normative): **builder–verifier** (draft → adversarial
judge with a `{pass, issues}` schema → feed issues back → repeat until pass,
max rounds, or budget floor); **until-dry** (keep spawning finders until K
consecutive rounds surface nothing new); **until-count** (accumulate to a
target); **budget-scaled fleet** (size the fan-out from `budget.total`).
Reference implementation: `examples/03-builder-verifier.js`. Routing the
verifier label to a different backend (§9) yields cross-vendor judging with
no script change.

## 6. Structured output

1. `schema` is a JSON Schema (draft-07-compatible subset: `type`,
   `properties`, `required`, `items`, `enum`, `anyOf`/`oneOf`/`allOf`,
   `$defs`/`definitions`, `additionalProperties`).
2. Contract: the resolved object MUST validate against the **authored**
   schema. Optional properties stay optional at the contract level.
3. Engines MAY transform the schema for backend wire formats (e.g. OpenAI
   strict mode requires `required` = all keys + `additionalProperties:
   false`; schemas not expressible strictly — e.g. map-style
   `additionalProperties` — are carried by prompt contract alone), MAY
   enforce via prompt-inlined instructions, and SHOULD repair invalid
   replies via continuation turns embedding the validation errors, up to an
   engine-configured retry cap. Retries exhausted → the call resolves
   `null`. [CLARIFICATION: mechanism; the contract is (2)]

## 7. Strict mode & determinism

Strict mode is the enforcement of §3.4 at runtime (`Date.now`,
`Math.random`, argless `new Date()` throw). Upstream is always strict;
ultracodex enables it with `run --strict` and lints it with
`validate --strict`. Scripts targeting portability MUST be strict-clean.

## 8. Observability (engine-side; non-normative for scripts)

Engines SHOULD record a replayable event journal per run (run/phase/agent
lifecycle, activity, usage, warnings, result). Scripts cannot observe the
journal. The ultracodex event schema is defined in
`docs/product_context.md` §4. [EXTENSION]

## 9. Backend abstraction (engine implementers) [EXTENSION]

An engine routes each agent call to a backend executor selected by
configuration (never by script content). Executors declare capabilities:

| capability | values | engine degradation when absent |
|---|---|---|
| `schema` | `wire` / `prompt-only` | prompt contract + validation + repair |
| `resume` | bool | repair via fresh call embedding errors |
| `interrupt` | `graceful` / `kill-only` | process-tree termination |
| `usage` | `per-turn` / `final` / `none` | budget counts 0; engine warns |
| `activity` | bool | status-only progress |
| `sandbox` | profile list | backend default |

Every adapter MUST ship a scriptable fake of its harness that mirrors every
live-API rejection class the adapter depends on, and MUST pass the engine's
executor conformance suite.

## 10. Conformance

- **Script conformance**: parses per §2, uses only §3 bindings, is
  strict-clean (§7). Operationally: `ultracodex validate --strict` reports
  no issues.
- **Engine conformance**: executes the conformance corpus — a suite of
  scripts run under the reference implementation and the candidate engine —
  with identical *semantic* outcomes (§5 invariants: null/throw behavior,
  ordering, caps, budget), not identical agent output content.
- **Compatibility direction**: reference-runnable ⇒ conforming-engine-
  runnable, unconditionally. The converse holds for strict-clean scripts.

## 11. Versioning

- This spec is versioned independently of any engine. v0.x: drafts tracking
  the upstream snapshot; v1.0: frozen portable subset.
- `meta.spec` (integer) is RESERVED for scripts to declare a target spec
  version; engines MUST ignore it today. [EXTENSION, proposed]
- Upstream evolution is tracked by re-snapshotting the reference tool
  description and diffing against §2–§7; divergences become corpus entries.

## Appendix A — rulings index

| § | flag | ruling |
|---|---|---|
| 2.6 | CLARIFICATION | no imports/exports in body; no dynamic `import()` |
| 3.2–3.3 | CLARIFICATION | intrinsic surface; no process/fs/require |
| 3.4 | EXTENSION | non-strict leniency for banned time/random calls |
| 4.4 | CLARIFICATION | post-stop null resolution yields the event loop |
| 5.1 | CLARIFICATION | `String()` prompt coercion; engine I/O errors → null |
| 5.3 | CLARIFICATION | first-stage `prev` = item; resolved `null` flows through stages (only a throw drops the item) |
| 5.1 | (verified) | `meta.phases[].model` is display metadata, not override |
| 5.7 | EXTENSION | per-backend ledgers/config |
| 6.3 | CLARIFICATION | wire strictification + repair mechanism |
| 8–9 | EXTENSION | journal schema; capability descriptor |
| 11 | EXTENSION | reserved `meta.spec` field |
