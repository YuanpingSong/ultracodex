# OpenCode probe — frozen fixture contract (M4b)

**Probed live 2026-07-06** against opencode **1.16.2** (pin it: `~/.opencode/bin/opencode`),
providers `deepseek/deepseek-chat`, `deepseek/deepseek-v4-flash`, `cerebras/gemma-4-31b`.
Raw captures in `fixtures/opencode/` (fx-* = HTTP server surface; probe1 = CLI quirk
evidence). This document + those fixtures are the arbiter for the fake and the adapter —
the same role `docs/executor-contract.md` played for M4a. FROZEN for fleet purposes;
anything marked TO-VERIFY is a build-time check, not a licence to improvise.

## Headline findings (each one moved the plan)

1. **The M4b plan's `schema: "prompt-only"` assumption is WRONG.** opencode has native
   wire structured output: `format: {type:"json_schema", schema:…, retryCount?}` on the
   message endpoint; the parsed object comes back in `AssistantMessage.structured`
   (fx-structured-deepseek-chat, fx-structured-gemma-4-31b). Authored optionality is
   honored (optional prop omitted freely) and **map-style `additionalProperties` schemas
   pass on the wire** (fx-structured-map) — opencode's wire path is more permissive than
   OpenAI strict mode.
2. **Wire support is provider-dependent.** deepseek-v4-flash (thinking mode) 400s:
   `APIError: "Thinking mode does not support this tool_choice"` (fx-structured-turn).
   The adapter needs per-call wire→prompt-only degradation — exactly the
   `turnWithWireFallback` pattern the codex adapter gained in M4a.
3. **The CLI is not the adapter surface in 1.16.2.** `run --format json` emits ONLY the
   first event (`step_start`) then exits 0 (probe1-text.json); `--format default` writes
   ZERO bytes to a piped stdout (text renders only in a TTY; banner goes to stderr). The
   HTTP server is the real API (the TUI itself is a client of it).
4. **Headless default is fully permissive.** A turn asked to run a shell command
   executed it with NO permission gate (nonce round-trip proved real execution). The
   per-call `tools: {name: false}` map verifiably blocks builtin tools
   (fx-tools-disabled) — but user-config MCP tools remain available (doctor-divergence
   note, same class as codex MCP inheritance).

## The adapter surface (frozen)

Spawn per call, like the codex adapter spawns its app-server:

- `opencode serve --port 0 --hostname 127.0.0.1` with `cwd = req.cwd`; parse the port
  from stdout line `opencode server listening on http://127.0.0.1:PORT`. Single process
  (bun binary), no child tree; SIGTERM kills it cleanly, nothing orphaned.
- `POST /session` body `{}` → `{id: "ses_…", directory, …}`; session inherits the serve
  process cwd. Emit `onThread(id)` here (sessions persist on disk; `opencode export <id>`
  / `run -s <id>` make resume real).
- `POST /session/{id}/message` — SYNCHRONOUS: blocks for the whole turn, returns
  `{info: AssistantMessage, parts: Part[]}` (fx-text-turn). No HTTP timeout on the
  client side, or generously long — turns can run minutes.
  Body fields the adapter uses:
  - `model: {providerID, modelID}` (split `provider/model` config strings on first `/`)
  - `parts: [{type:"text", text: prompt}]`
  - `format: {type:"json_schema", schema}` for schema calls (raw authored schema — no
    strictification; probe shows optionals + map-style pass)
  - `variant` — provider-specific effort mapping (config-owned, like codex effort map)
  - `system` — profile preamble injection (TO-VERIFY at build time; documented in
    the OpenAPI request schema, not probed)
  - `tools: {bash:false, edit:false, write:false, patch:false, …}` — the read-only
    profile lever (verified working for builtins; MCP names unknown at config time)
- `GET /event` — SSE (`data: {…}` lines). Observed types: `server.connected`,
  `server.heartbeat`, `message.part.delta` (streamed text → onActivity),
  `message.part.updated`, `message.updated` (carries per-step `tokens` → LIVE usage
  ticks), `session.status`, `session.idle` (turn-complete signal), `session.error`,
  `session.updated`, `session.diff`. One subscription serves both activity and usage.
- `POST /session/{id}/abort` → acks `true` fast (0.31s observed); the in-flight message
  settles with `error: {name:"MessageAbortedError", data:{message:"Aborted"}}`.
  Interrupt story: abort the turn, then SIGTERM the serve process on settle.
- `POST /session/{id}/prompt_async` exists (empty response, fire-and-forget) — the
  sync endpoint + abort is sufficient for the adapter; async is not needed for v1.

## Result envelope (what the fake must reproduce)

`AssistantMessage` fields the adapter reads:
- `error: null | {name, data}` — the typed union, enumerated by the OpenAPI doc:
  **ProviderAuthError, UnknownError, MessageOutputLengthError, MessageAbortedError,
  StructuredOutputError, ContextOverflowError, APIError**. Fake-fidelity rule: every
  one of these must be stageable in the fake (APIError and MessageAbortedError are
  captured live in fixtures; shape the rest from the OpenAPI schemas).
- `tokens: {total, input, output, reasoning, cache:{read, write}}` — per-turn, in the
  sync response and in `message.updated` SSE ticks. Usage mapping:
  outputTokens=output, reasoningOutputTokens=reasoning, cachedInputTokens=cache.read,
  inputTokens=input, totalTokens=total.
- `structured: <object>` on wire-schema turns; final `parts[]` text part(s) otherwise.
  Multi-step turns emit several `message.updated` events (finish:"tool-calls" steps)
  before the final one — the adapter reads the sync response, not intermediate events.
- `finish: "stop" | "tool-calls" | …`.

## Capability descriptor (frozen for the adapter)

```
{ schema: "wire",          // + per-call fallback to prompt-only on APIError/StructuredOutputError
  resume: true,            // sessions persist; repair turns POST to the same session
  interrupt: "graceful",   // /abort acks, message settles typed; SIGTERM serve after settle
  usage: "per-turn",       // message.updated SSE ticks; sync response is the authoritative final
  activity: true,          // message.part.delta stream
  sandbox: [] }            // NO OS sandbox — engine warns per contract §3; the adapter
                           // additionally applies the tools-disable map for read-only-ish
                           // profiles as defense-in-depth (documented, not a sandbox claim)
```

## Security posture (must be in the adapter's config docs)

Headless opencode executes tools including shell BY DEFAULT with no approval gate, and
inherits user-config MCP servers. The adapter ships with the same discipline as codex
(`approvalPolicy: never` analog): default profile disables nothing (workspace-write
equivalent — it IS the opencode default), read-only profiles send the tools-disable map,
and doctor grows an opencode section flagging: no OS sandbox, MCP inheritance, and the
permissive default. Config isolation via a generated minimal config (`OPENCODE_CONFIG`
env — TO-VERIFY) is the candidate hardening for hermetic agents.

## Fake shape (for the fleet)

`tests/fake-opencode/opencode` — zero-dependency Node HTTP server script, house
conventions (header comment documenting directives, `[[directive]]` markers in the
prompt text, env switches for process-level behavior, invocations log):
- speaks the subset above: announce line on stdout, `/session`, `/session/:id/message`
  (sync, directive-driven), `/abort`, `/event` SSE, minimal `/doc`;
- directives stage: text reply, structured reply, wire rejection (APIError
  thinking-mode shape from fx-structured-turn), StructuredOutputError, invalid-then-
  valid repair sequences, always-invalid, each remaining error class, slow/hang (abort
  tests — dies on SIGTERM), mid-turn crash (exit 1 after step_start), garbage/non-JSON
  HTTP body, usage-number control, session-id control;
- kit wiring: `tests/executor-kit/opencode.kit.test.ts` through the FULL 10-assertion
  suite (assertion #4 wire-rejection is LIVE here, unlike claude).

## Open items (not blockers, tracked)

- CLI `--format json` single-event bug: revisit on version bumps; if fixed upstream the
  CLI becomes a viable fallback surface. Pin 1.16.2 meanwhile.
- `system` field and `OPENCODE_CONFIG` isolation: TO-VERIFY during the fleet build
  (probe them in the fake's unit tests against the real binary only if cheap).
- Model availability drifts with provider auth; the adapter's config carries explicit
  `provider/model` strings, no auto-discovery.
