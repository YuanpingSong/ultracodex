# Executor Contract v1

**Audience:** backend adapter authors. This document is the complete contract for adding an execution backend to ultracodex — the M4a exit criterion is that a third adapter can be written from this document alone, without reading engine source. The Agent Script format itself never sees any of this (spec §3.5: engines must not add script-visible extensions); backends are pure engine configuration.

**Versioning.** The contract is versioned independently of the package. v1 freezes the shapes below; additive fields land as v1.x (adapters must tolerate unknown optional fields); breaking changes bump to v2 with a migration note. The TypeScript source of truth lives in `src/executor/contract.ts` (extracted from `src/types.ts` as part of M4a).

## 1. The interface

An adapter implements one class:

```ts
export interface Executor {
  readonly backend: string;                 // journal ledger key, route target name
  readonly capabilities: CapabilityDescriptor;   // §3 — NEW in v1
  run(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult>;
}

export interface ExecutorRequest {
  prompt: string;                    // final composed prompt (engine prepends the return-value contract; adapter prepends profile preamble)
  schema?: Record<string, unknown>;  // RAW authored JSON Schema — NOT strictified; schema handling is the adapter's job (§4)
  model?: string;                    // workflow-level tier name (opus/sonnet/haiku/fable/…) — adapter maps via ITS config (resolveXxxModel)
  effort?: Effort;                   // "low"|"medium"|"high"|"xhigh"|"max" — adapter maps via config (e.g. max→xhigh on codex)
  cwd: string;                       // working directory (projectDir, or the agent's private worktree when isolation was requested)
  label: string;                     // display/routing label — for diagnostics only; MUST NOT change behavior
  agentProfile?: string;             // opts.agentType from the script — resolves to a config profile (sandbox/preamble/networkAccess)
}

export interface ExecutorContext {
  signal: AbortSignal;               // §2.3 — abort means interrupt-then-kill and SETTLE
  onActivity(ev: ActivityEvent): void;  // streamed progress lines (throttled + truncated by the engine)
  onUsage(usage: Usage): void;       // CUMULATIVE usage for this call so far — monotonic ticks (§2.4)
  onThread?(threadId: string): void; // once, when the backend session/thread id is known (enables resume UX + repair-on-thread)
}

export type ExecutorResult =
  | { ok: true; text?: string; object?: unknown; usage: Usage; threadId?: string }
  | { ok: false; error: string; usage?: Usage; threadId?: string };
```

`Usage` is the codex-style breakdown (`totalTokens/inputTokens/cachedInputTokens/outputTokens/reasoningOutputTokens`); backends that only know a subset report what they have and zero the rest — **`outputTokens` is the field budgets meter**.

## 2. Division of responsibility

The engine owns everything around the call; the adapter owns everything inside it.

| the ENGINE does | the ADAPTER does |
|---|---|
| routing (label → backend), concurrency semaphore, lifetime/fan-out caps, budget check before dispatch | model/effort/profile resolution from its own config section |
| prompt/output snapshots, journal events, activity throttling + truncation, usage ledger | process/session management for its harness; emitting activity/usage/thread callbacks |
| worktree create/cleanup when the script asked for isolation (adapter just gets `cwd`) | schema delivery: wire schema, prompt contract, validation, repair (§4) |
| the abort race: on stop/skip it aborts the signal, then waits up to `INTERRUPT_GRACE_MS` (5s) for `run()` to settle before tearing down the slot/worktree | honoring the signal: interrupt gracefully if the harness supports it, else kill the process tree — and **settle the promise** |
| mapping the result to script-visible semantics: `ok:false` and rejects both become `null` in the script; usage folded into per-backend ledgers | returning honest results: `ok:true` with exactly one of `text`/`object`; `ok:false` with a human-useful `error` |

### 2.1 Settle, don't reject

`run()` must **never reject** in normal operation — every failure mode (spawn error, protocol error, timeout, validation exhaustion, kill) resolves `{ ok: false, error }`. The engine treats a rejection as a bug-but-survivable (caught and converted to `ok:false`); the conformance kit treats it as a failure.

### 2.2 One result shape per call

Schema-less call → `text` (the final message, verbatim). Schema call → `object` (validated against the **authored** schema, §4). Never both, never neither on `ok:true`.

### 2.3 Abort

When `ctx.signal` fires: stop the work (graceful interrupt where the harness supports it — declare which in the descriptor — otherwise kill the process tree), then settle `run()` promptly. The engine gives 5 seconds of grace before it frees the concurrency slot and cleans the worktree under you; an adapter that keeps running past settlement is corrupting shared state. Result after abort may be `ok:false` (typical) — the engine already decided the agent's status is `skipped` and ignores it.

### 2.4 Callback discipline

- `onUsage` ticks are **cumulative for the call** and must be monotonic — the engine journals them as-is and uses the LAST tick as the call's usage if the result carries none. Backends with only-final usage tick once before settling. Backends with none never call it (declare `usage: "none"`).
- `onThread` at most once, as early as known. It powers `codex resume <threadId>` UX and same-thread schema repair.
- Callbacks may be invoked any time before settlement; the engine ignores late callbacks after `agent_end`, but adapters must not rely on that.
- Activity text is best-effort; the engine truncates to 200 chars in the journal and streams raw lines to the per-agent events file.

## 3. Capability descriptor

Adapters declare what they can do; the engine supplies written degradation for everything they can't. **Degradation lives in the engine, once — adapters never reimplement it.**

```ts
export interface CapabilityDescriptor {
  schema: "wire" | "prompt-only";
  resume: boolean;                    // same-session continuation turns (schema repair quality)
  interrupt: "graceful" | "kill-only";
  usage: "per-turn" | "final" | "none";
  activity: boolean;                  // streamed events for the TUI
  sandbox: string[];                  // supported sandbox profile names, [] = none
}
```

Degradation rules (normative):

| capability | declared | engine behavior |
|---|---|---|
| `schema` | `"wire"` | adapter sends `strictifyForWire(schema)` on the wire **and** the engine-side contract still applies: prompt instruction + ajv validation against the authored schema + repair. Belt and suspenders. |
| | `"prompt-only"` | schema rides the prompt as an instruction block; ajv validates the extracted JSON; repair per below. Proven path (claude backend; codex map-style fallback). |
| `resume` | `true` | schema repair happens as continuation turns on the same session, embedding the validation errors. |
| | `false` | repair is a fresh call whose prompt embeds the previous reply + validation errors. Costlier, weaker — set expectations in the capability matrix. |
| `interrupt` | `"graceful"` | adapter's interrupt path runs first; kill is its own escalation. |
| | `"kill-only"` | adapter kills the process tree on abort; the engine's 5s grace still applies. |
| `usage` | `"per-turn"` | budget rails see live spend; `--budget` fully effective. |
| | `"final"` | budget checks lag by one call; still enforced between dispatches. |
| | `"none"` | ledger records zero; the engine emits a **warning** when `--budget` is set on a run that routes to this backend (the ceiling cannot meter what it cannot see). |
| `activity` | `false` | TUI shows status-only progress for these agents (start/end, no live lines). |
| `sandbox` | `[]` or missing profile | the engine warns and passes through; profile `sandbox`/`networkAccess` fields that the adapter cannot honor MUST be reported via a warn-once at construction, never silently ignored. |

Retry cap: schema repair attempts are bounded by the backend's `schemaRetries` config (default 3); exhaustion → `ok:false` with the last validation error in `error`.

## 4. Schema discipline (the part adapters get wrong)

The contract is with the **authored** schema: the object the script receives must validate against what the script passed, with authored optionality intact. Everything else is transport detail:

- `strictifyForWire()` produces the OpenAI-strict wire form (`required` = all keys, `additionalProperties: false`) — or **null** when the schema isn't strictly representable (e.g. map-style `additionalProperties`), in which case wire-capable adapters fall back to prompt-only for that call.
- Always validate engine-side with ajv against the authored schema, regardless of wire support. Wire acceptance is not validation.
- Repair prompts embed the ajv errors verbatim and demand only the corrected JSON.

## 5. Fake-fidelity rule and the conformance kit

Every adapter ships a **scriptable fake of its harness** (the `tests/fake-codex/codex` pattern): an executable the adapter spawns in tests, driven by a per-test script of canned protocol turns.

**Fake-fidelity rule (learned live, 2026-07-02, `invalid_json_schema`):** every rejection class of the live API that the adapter's behavior depends on MUST be mirrored in its fake. A fake that only models success validates nothing — our schema-strictness regression shipped precisely because the fake accepted what the live API rejected.

The conformance kit (`tests/executor-kit/`, built in M4a-3) runs the same suite against any `Executor` + its fake, asserting at minimum:

1. text call → `ok:true` with `text`, no `object`;
2. schema call → validated `object` (authored schema), including optional-properties round-trip and the map-style/non-strict fallback path;
3. repair loop: first reply invalid → repair turn(s) → valid object; retries exhausted → `ok:false` carrying the validation error;
4. wire-rejection class (for `schema:"wire"` adapters): the fake rejects a non-strict wire schema the way the live API does; the adapter degrades to prompt-only rather than failing the call;
5. abort: signal mid-call → `run()` settles within the grace window; no orphan processes;
6. usage: cumulative monotonic ticks (per declared mode) and a final usage consistent with the last tick;
7. `onThread` emitted once when the harness exposes a session id;
8. mid-turn harness crash → `ok:false` with diagnostic, no reject, no hang;
9. profile application: `agentProfile` resolving to a preamble visibly alters the prompt; unsupported sandbox warns, doesn't throw;
10. never-reject: fuzz the fake's failure scripts; `run()` resolves `ok:false` for all of them.

Kit + descriptor together are the exit gate: **both existing backends (codex, claude) must declare capabilities and pass, and the OpenCode adapter must be buildable from this doc + the kit alone.**

## 6. What this replaces

Spec §9 (backend abstraction) remains the format-level summary; this document is its full normative expansion. `src/types.ts`'s executor block moves to `src/executor/contract.ts` unchanged in shape, plus `CapabilityDescriptor`; `createExecutors()` keys the registry by `backend` name and asserts capability declarations at construction.
