// M4b — the fleet builds the OpenCode backend (dogfood run #2).
//
// Arbiters, in order: docs/executor-contract.md (the executor seam, FROZEN)
// and docs/internal/research/opencode-probe.md (the opencode protocol,
// FROZEN, with raw captures in fixtures/opencode/). Shape: staged-build-gates
// with the step-2 friction lessons applied — gate schemas carry `decisions`,
// gates receive the CUMULATIVE in-scope allowlist and the baseline commit,
// and sandbox facts (no ps, no git restore) are stated up front.
//
// Run it (from the repo root, under an INSTALLED ultracodex, never repo dist):
//   ultracodex run workflows/m4b-opencode-adapter.js --json
export const meta = {
  name: 'm4b-opencode-adapter',
  description: 'Build the OpenCode backend from the frozen probe doc: scriptable fake serve, config surface, adapter with wire-fallback structured output, full 10-assertion kit wiring',
  phases: [
    { title: 'FakeWave', detail: 'parallel: scriptable fake-opencode serve | config surface (types/config/constants)' },
    { title: 'GateA', detail: 'full suite; fake-fidelity audit vs the frozen probe doc' },
    { title: 'Adapter', detail: 'src/executor/opencode.ts + router wiring + adapter tests' },
    { title: 'GateB', detail: 'full suite; adapter-vs-probe-doc audit' },
    { title: 'KitWiring', detail: 'opencode through the full 10-assertion conformance kit' },
    { title: 'FinalGate', detail: 'N=3 conforming backends; 10-entry opencode coverage map' },
  ],
}

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    verified: { type: 'string', description: 'the exact verify commands you ran and their real outcomes' },
    decisions: { type: 'array', items: { type: 'string' } },
    friction: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesTouched', 'verified', 'decisions', 'friction'],
}

const GATE = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    checksRun: { type: 'array', items: { type: 'string' }, description: 'every check with its real outcome, incl. final test counts' },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    remainingIssues: { type: 'array', items: { type: 'string' }, description: 'empty when pass=true' },
    coverageMap: { type: 'array', items: { type: 'string' }, description: 'assertion-to-test mapping where your instructions ask for one, else []' },
    decisions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    friction: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'checksRun', 'fixesApplied', 'remainingIssues', 'coverageMap', 'decisions', 'notes', 'friction'],
}

const SCOPE = `CUMULATIVE IN-SCOPE FILES for this whole program (the working tree started clean at the baseline commit; everything differing from HEAD is this program's own output — earlier phases' diffs are EXPECTED, judge only whether files are inside this list):
- tests/fake-opencode/** and tests/fake-opencode.test.ts
- src/types.ts, src/config.ts, src/constants.ts, tests/config.test.ts, tests/static.test.ts
- src/executor/opencode.ts, src/executor/router.ts, tests/router.test.ts, tests/executor-opencode.test.ts
- tests/executor-kit/opencode.kit.test.ts (and minimal recorded portability edits to tests/executor-kit/kit.ts)
The untracked workflows/ directory belongs to the run driving you — never read or edit it.`

const COMMON = `You are one agent in a fleet extending ultracodex — the TypeScript ESM repo (Node 20+, pnpm, vitest) at your working directory (the repo root) — with a third execution backend: OpenCode.

THE ARBITERS — read both before anything else:
1. docs/executor-contract.md — Executor Contract v1 (FROZEN): the seam every backend implements. The conformance kit at tests/executor-kit/ enforces it.
2. docs/internal/research/opencode-probe.md — the FROZEN opencode fixture contract, distilled from live probes; raw captures in fixtures/opencode/ (read the ones your assignment names). Where code-you-write and these docs disagree, the docs win. Where they are silent, pick the minimal compliant interpretation, record it in \`decisions\`, and flag anything genuinely blocking in \`friction\`.

HOUSE RULES:
- ESM + NodeNext: every relative import needs a .js suffix.
- Touch ONLY files inside the program scope (below) that your assignment names. Never edit docs/**, README.md, examples/**, skills/**, fixtures/**, package.json, tsconfig.json. Never read or write .ultracodex/**. Never run git commit, git push, or pnpm build.
- ${SCOPE}
- ENVIRONMENT FACTS (learned the hard way last run): your sandbox blocks \`ps\` and cannot take .git/index.lock (git reads work, git restore does not); \`git diff --stat\` omits untracked files — use \`git status --short -uall\` for hygiene checks.
- Match the existing code style (read the named neighboring files first): terse, small functions, comments only for non-obvious constraints.
- Tests must stay hermetic: temp dirs via fs.mkdtempSync, NO network, never the real opencode/codex/claude binaries — scriptable fakes only.

RETURN raw data per your schema. \`decisions\` = choices you made where the docs left room. \`friction\` = anything unclear, awkward, or missing in this task's setup — prompt gaps, doc gaps, tooling annoyances. Be candid; friction steers the cookbook.`

const FAKE_PROMPT = `${COMMON}

YOUR ASSIGNMENT — the scriptable fake of opencode's serve surface. A sibling agent is concurrently editing src/types.ts, src/config.ts, src/constants.ts and their tests — do NOT touch those files.

Read in order: docs/internal/research/opencode-probe.md (§"The adapter surface", §"Result envelope", §"Fake shape" — your requirements list); fixtures/opencode/fx-text-turn.json, fx-structured-deepseek-chat.json, fx-structured-map.json, fx-structured-turn.json (the live APIError wire-rejection), fx-session-create.json, fx-sse-events.jsonl (event shapes); tests/fake-codex/codex and tests/fake-claude/claude (the house scriptable-fake conventions: header comment documenting every directive, [[directive]] markers in the prompt text, env-var switches for process-level behavior, invocations.jsonl logging).

Deliverables — your files: tests/fake-opencode/**, tests/fake-opencode.test.ts:
1. tests/fake-opencode/opencode — an executable zero-dependency Node script (mode +x) faking \`opencode serve --port 0 --hostname 127.0.0.1\`: bind an ephemeral HTTP port, print the announce line ("opencode server listening on http://127.0.0.1:PORT") on stdout, then serve:
   - POST /session → {id: "ses_<random>", directory: cwd} (session-id controllable via directive/env for determinism where a test needs it);
   - POST /session/:id/message — SYNCHRONOUS turn driven by [[directives]] found in the request's text part, replying {info: AssistantMessage, parts: [...]} with the envelope fields the probe doc freezes (error/tokens/structured/finish + text parts);
   - POST /session/:id/abort → true, and any in-flight message settles with error {name:"MessageAbortedError", data:{message:"Aborted"}};
   - GET /event — SSE stream: server.connected on subscribe, then message.part.delta / message.updated (carrying per-step tokens) / session.idle around each turn, matching fx-sse-events.jsonl shapes;
   - GET /doc — minimal stub (200 JSON) so a curious client does not crash.
2. Directive repertoire (document every one in the header comment): [[reply:TEXT]]; [[structured:JSON]]; [[wire-reject]] → the APIError thinking-mode 400 shape captured in fx-structured-turn.json, EXACTLY when the request carries format.json_schema — a follow-up identical message WITHOUT format succeeds (that is the fallback path the adapter must exercise); [[invalid-first]] / [[always-invalid]] (structured replies that fail schema validation, for repair loops); one directive per remaining error class from the probe doc's typed union (ProviderAuthError, UnknownError, MessageOutputLengthError, StructuredOutputError, ContextOverflowError, APIError generic); [[slow:MS]] and [[hang]] (never finishes; process dies promptly on SIGTERM); [[crash-mid-turn]] (exit 1 after the turn starts); [[garbage]] (non-JSON HTTP body); [[usage:IN,OUT]] token-number control; [[reply2:TEXT]]-style second-turn control for same-session repair sequences.
3. tests/fake-opencode.test.ts — unit tests driving the fake DIRECTLY over HTTP (spawn it, parse the announce line, exercise every directive incl. every error class, abort settling, SSE event flow, SIGTERM-on-hang dying promptly, invocation logging).

Fake-fidelity rule (contract §5): every rejection class the adapter will branch on MUST be stageable here — the probe doc enumerates them; fx-structured-turn.json is the live wire-rejection you must mirror byte-shape-faithfully (name, data.message, data.statusCode).

Verify before returning (targeted only — a sibling's files are in flight, do NOT run the full suite): npx vitest run tests/fake-opencode.test.ts. Real outcomes into \`verified\`.`

const CONFIG_PROMPT = `${COMMON}

YOUR ASSIGNMENT — the OpenCode config surface (types, parsing, defaults). A sibling agent is concurrently building tests/fake-opencode/** — do NOT touch any fake or executor-kit file, and do NOT create src/executor/opencode.ts (a later phase builds the adapter; router wiring happens there too — leave src/executor/router.ts alone so typecheck stays green without the adapter).

Read in order: docs/internal/research/opencode-probe.md (§"The adapter surface", §"Capability descriptor", §"Security posture"); src/types.ts (CodexBackendConfig/ClaudeBackendConfig as the pattern); src/config.ts (how [backends.codex]/[backends.claude] parse, resolveCodexModel/resolveClaudeModel, route validation); src/constants.ts (DEFAULT_CODEX_CONFIG/DEFAULT_CLAUDE_CONFIG/DEFAULT_CONFIG); tests/config.test.ts.

Deliverables — your files: src/types.ts, src/config.ts, src/constants.ts, tests/config.test.ts, tests/static.test.ts (only if it asserts config shapes):
1. src/types.ts: OpencodeBackendConfig — binary (default "opencode"), model (a "provider/model" string; the adapter splits on the FIRST slash), modelMap (tier name → "provider/model", same shape as codex's), variantMap (Effort → provider variant string, the probe doc's \`variant\` field; empty default = omit variant), schemaRetries (default from DEFAULT_SCHEMA_RETRIES), extraArgs (string[], appended to the serve command), plus whatever the codex/claude config blocks carry that generalizes (follow the existing pattern, not invention). UltracodexConfig gains \`opencode: OpencodeBackendConfig\`.
2. src/config.ts: parse [backends.opencode] with the same validation strictness as the other two; resolveOpencodeModel/resolveOpencodeEffort helpers following the existing naming; the route table ("[route]") accepts "opencode" as a target.
3. src/constants.ts: DEFAULT_OPENCODE_CONFIG (binary "opencode", model "deepseek/deepseek-chat", empty modelMap/variantMap — shipped defaults are conservative; users override) folded into DEFAULT_CONFIG.
4. tests/config.test.ts: parsing round-trips, defaults, bad-value rejection, route-to-opencode acceptance — same granularity as the codex/claude config tests. Never weaken an existing assertion.

IMPORTANT SCOPE NOTE: createExecutors/router does NOT construct an opencode executor yet — that lands with the adapter phase. Nothing you write may reference src/executor/opencode.ts.

Verify before returning (targeted only — a sibling's files are in flight): pnpm typecheck && npx vitest run tests/config.test.ts tests/static.test.ts tests/router.test.ts. Real outcomes into \`verified\`.`

const gateAPrompt = `${COMMON}

YOU ARE GATE A. Two builders just finished in parallel: (1) tests/fake-opencode/ — the scriptable fake of opencode serve + its unit tests; (2) the OpenCode config surface in src/types.ts, src/config.ts, src/constants.ts + config tests. Reconcile and verify; fix surgically.

1. RUN pnpm typecheck and pnpm test — the FULL suite. Fix every failure toward the two arbiter docs; never weaken or delete an assertion. Record every fix in fixesApplied.
2. Fake-fidelity audit against docs/internal/research/opencode-probe.md: every typed error class stageable (ProviderAuthError, UnknownError, MessageOutputLengthError, MessageAbortedError, StructuredOutputError, ContextOverflowError, APIError); the wire-rejection directive mirrors fx-structured-turn.json's shape and clears on a format-less retry; SSE shapes match fx-sse-events.jsonl; abort settles typed; hang dies on SIGTERM; the announce line matches the probe doc byte-pattern.
3. Config audit: [backends.opencode] parses with the same strictness as codex/claude; route accepts "opencode"; defaults conservative per the doc; NOTHING references src/executor/opencode.ts yet (it must not exist).
4. Hygiene: git status --short -uall against the baseline — every path inside the program scope; no .only, no debug output, style consistent.
DECIDING TEST: could the adapter author (next phase) build src/executor/opencode.ts against this fake alone — every protocol behavior and rejection class they need stageable, config surface complete — with the full suite green? pass=true only then. coverageMap: [].`

const ADAPTER_PROMPT = `${COMMON}

YOUR ASSIGNMENT — the OpenCode adapter itself. You work alone; the fake (tests/fake-opencode/opencode), its unit tests, and the config surface all exist and are green.

Read in order: docs/internal/research/opencode-probe.md (every section — it IS your spec); docs/executor-contract.md §2-§4 (invariants: settle-don't-reject, one result shape, abort grace, cumulative monotonic usage, onThread once); src/executor/codex.ts (the sibling adapter: withAbort, turnWithWireFallback, repair loop, profile handling — mirror its structure where the protocols rhyme); src/executor/claude.ts (spawn/kill patterns); src/executor/contract.ts; tests/fake-opencode/opencode (directive header); tests/executor-codex.test.ts and tests/executor-claude.test.ts (test granularity to match).

Deliverables:
1. src/executor/opencode.ts — OpencodeExecutor implements Executor:
   - capabilities EXACTLY as the probe doc freezes: { schema:"wire", resume:true, interrupt:"graceful", usage:"per-turn", activity:true, sandbox:[] }.
   - run(): spawn \`<binary> serve --port 0 --hostname 127.0.0.1\` + cfg.extraArgs with cwd=req.cwd; parse the announce line for the port (bound startup timeout — a stalled serve must never hang the workflow; see codex.ts THREAD_START_TIMEOUT_MS); POST /session (emit onThread once with the id); subscribe GET /event and forward message.part.delta text to onActivity and message.updated tokens to onUsage as CUMULATIVE monotonic ticks (probe doc's usage mapping: output→outputTokens, reasoning→reasoningOutputTokens, cache.read→cachedInputTokens); POST /session/:id/message synchronously with {model:{providerID,modelID} (split cfg model on first slash), parts:[{type:"text",text:prompt}], variant (from effort via variantMap; omit when unmapped), tools: the disable-map WHEN the resolved profile requests read-only-ish confinement (probe doc §"Security posture"), format:{type:"json_schema",schema} on schema calls}.
   - Schema discipline (contract §4): send the RAW authored schema on the wire (the probe proved optionals and map-style pass); ALWAYS validate the reply engine-side with ajv against the authored schema (createValidator from ./schema.js on \`structured\` when present, else on the final text); on wire rejection (error name APIError or StructuredOutputError on a format-carrying turn) fall back: retry the SAME turn without format, prompt-embedding the schema contract via assemblePrompt — mirror codex's turnWithWireFallback shape; repair turns POST to the SAME session (resume:true) embedding the ajv errors, bounded by cfg.schemaRetries, exhaustion → ok:false carrying the last validation error.
   - Abort: on ctx.signal, POST /session/:id/abort, await the in-flight request settling (MessageAbortedError → ok:false "interrupted"), then SIGTERM the serve process; if the HTTP layer wedges, SIGTERM anyway and settle — run() must resolve within the engine's grace (contract §2.3). Always SIGTERM serve in a finally; never leave it running past settlement.
   - Every failure mode resolves { ok:false, error } with a human-useful message naming the error class (settle-don't-reject, §2.1). Map the typed union: MessageAbortedError→"interrupted"; others → their name + message.
2. src/executor/router.ts: createExecutors constructs OpencodeExecutor(config.opencode, config.profiles) alongside the other two (registry/validation/warnings machinery already generalizes).
3. tests/executor-opencode.test.ts — adapter through the fake at the same granularity as tests/executor-codex.test.ts: text call, structured call (optionals intact, map-style), wire-reject fallback path, repair-then-valid, retries-exhausted, abort settling within INTERRUPT_GRACE_MS with the serve process dead after, usage tick monotonicity, onThread once, announce-timeout, crash mid-turn, garbage body, every error class mapped to ok:false.
4. tests/router.test.ts: extend for the third backend (descriptor validation, registry, warnings with the claude+opencode sandbox:[] profiles) — never weaken an existing assertion.

Verify before returning: pnpm typecheck && pnpm test — FULL suite green (you are solo; run it all). Real outcomes into \`verified\`.`

const gateBPrompt = `${COMMON}

YOU ARE GATE B. The adapter phase just finished: src/executor/opencode.ts, router wiring for the third backend, and tests/executor-opencode.test.ts. Verify against both arbiter docs; fix surgically.

1. RUN pnpm typecheck and pnpm test — FULL suite. Fix failures toward the docs; never weaken an assertion. Record fixes in fixesApplied.
2. Adapter-vs-probe-doc audit, line by line against docs/internal/research/opencode-probe.md: capabilities EXACTLY the frozen six values; announce-line parsing with bounded startup timeout; onThread once from POST /session; sync message call carries model/parts/variant/format per the doc; RAW authored schema on the wire; ajv validation engine-side ALWAYS (authored schema); wire fallback on APIError/StructuredOutputError retries the same turn format-less; repair on the SAME session bounded by schemaRetries; abort → POST /abort then SIGTERM serve, settling within grace; usage mapping (output/reasoning/cache.read) cumulative monotonic; typed error union mapped to ok:false with useful messages; serve ALWAYS torn down in finally.
3. Contract-invariants spot check (docs/executor-contract.md §2): settle-don't-reject on every staged failure; exactly one of text/object on ok:true.
4. Hygiene: git status --short -uall — every path inside the program scope; no .only; no debug output; style matches the sibling adapters.
DECIDING TEST: does src/executor/opencode.ts implement the frozen probe doc faithfully enough that the kit wiring (next phase) should pass without adapter changes — full suite green? pass=true only then. coverageMap: [].`

const KIT_PROMPT = `${COMMON}

YOUR ASSIGNMENT — wire the OpenCode adapter into the conformance kit. You work alone; the adapter, the fake, and the kit (tests/executor-kit/kit.ts) all exist and are green.

Read in order: docs/executor-contract.md §5 (the ten assertions); tests/executor-kit/kit.ts and both existing wirings (codex.kit.test.ts, claude.kit.test.ts — the worked examples); tests/fake-opencode/opencode (directive header); src/executor/opencode.ts.

Deliverables:
1. tests/executor-kit/opencode.kit.test.ts — OpencodeExecutor + tests/fake-opencode through the FULL kit. Expected capability-driven shape: schema "wire" → assertion #4 is LIVE (the [[wire-reject]] directive: adapter degrades to prompt-only instead of failing — the second live #4 after codex); #5 abort exercises POST /abort + SIGTERM settling within grace with the serve process verifiably dead; #6 usage ticks from SSE message.updated events; #7 session id via POST /session.
2. You MAY minimally extend tests/fake-opencode/opencode (new directives) and adjust tests/executor-kit/kit.ts where a genuine portability gap surfaces — record every such change in decisions and keep the codex + claude kit wirings and the fake-opencode unit tests green.
3. If an assertion fails because src/executor/opencode.ts genuinely violates a frozen doc, fix the ADAPTER minimally (the docs win) and record it prominently in decisions.

Verify before returning: npx vitest run tests/executor-kit/ tests/executor-opencode.test.ts tests/fake-opencode.test.ts, then the FULL pnpm typecheck && pnpm test (you are solo — run it all). Real outcomes into \`verified\`.`

const finalGatePrompt = `${COMMON}

YOU ARE THE FINAL GATE — certify that ultracodex now has THREE conforming backends. In the tree: the fake, the config surface, src/executor/opencode.ts, router wiring, adapter tests, and the kit wiring.

1. RUN pnpm typecheck and pnpm test — full and green; final counts into checksRun. Fix surgically anything red (arbiters: the two frozen docs; never weaken a test).
2. COVERAGE AUDIT: for EACH of the ten contract §5 assertions name in coverageMap the opencode kit test covering it (or a declared-capability skip reason — expected: NONE skipped for opencode; #4 is live). Ten entries. A gap = fix it or fail the gate.
3. Frozen-descriptor audit: opencode capabilities are EXACTLY { wire, resume:true, graceful, per-turn, activity:true, sandbox:[] }; createExecutors registers three backends and the degradation warnings fire for opencode's sandbox:[] against the shipped read-only profiles.
4. Regression hygiene: git status --short -uall — every path inside the program scope; diff PRE-EXISTING test files and justify anything that reads as a weakened assertion; no .only; no debug output; style pass over new files.
DECIDING TEST (the M4b kit criterion): the OpenCode fake passes the conformance kit, all three backends declare capabilities and pass, full suite green — and a fourth adapter could be built from docs/executor-contract.md + tests/executor-kit/ alone. pass=true only then; remainingIssues empty.`

function fixPrompt(gateName, gate) {
  return `${COMMON}

YOU ARE A FIXER. The ${gateName} gate failed. Its remaining issues, verbatim:
${gate.remainingIssues.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Gate notes: ${gate.notes}

Fix ONLY these issues, minimally and surgically, with the two frozen docs as arbiters. Never weaken or delete a test to get green. Then RUN pnpm typecheck && pnpm test (full) and report the real outcome in \`verified\`.`
}

const RECHECK = `

NOTE: a previous gate round failed and a fixer has since applied changes — trust nothing from before; verify everything from scratch.`

const reports = []
const frictionLog = []

function harvest(name, r) {
  if (!r) return
  reports.push({ agent: name, summary: r.summary ?? r.notes ?? '', decisions: r.decisions ?? [], fixesApplied: r.fixesApplied ?? [] })
  for (const f of r.friction ?? []) frictionLog.push(`[${name}] ${f}`)
}

async function gateLoop(phaseTitle, gateName, gatePrompt) {
  let gate = await agent(gatePrompt, { label: `gate:${gateName}`, phase: phaseTitle, schema: GATE })
  harvest(`gate:${gateName}`, gate)
  let round = 0
  while (gate && !gate.pass && round < 2) {
    round += 1
    log(`gate:${gateName} RED (round ${round}) — ${gate.remainingIssues.length} issue(s), dispatching fixer`)
    const fixer = await agent(fixPrompt(gateName, gate), { label: `fix:${gateName}-${round}`, phase: phaseTitle, schema: REPORT })
    harvest(`fix:${gateName}-${round}`, fixer)
    gate = await agent(gatePrompt + RECHECK, { label: `gate:${gateName}-r${round}`, phase: phaseTitle, schema: GATE })
    harvest(`gate:${gateName}-r${round}`, gate)
  }
  return gate
}

function blocked(at, extra) {
  log(`BLOCKED at ${at} — returning partial state for parent verification`)
  return { status: 'blocked', at, reports, friction: frictionLog, ...extra }
}

// ---- Phase 1: fake + config, disjoint parallel builders
phase('FakeWave')
log('Fake wave: scriptable fake-opencode serve || config surface')
const [fake, cfg] = await parallel([
  () => agent(FAKE_PROMPT, { label: 'impl:fake-opencode', phase: 'FakeWave', schema: REPORT }),
  () => agent(CONFIG_PROMPT, { label: 'impl:config', phase: 'FakeWave', schema: REPORT }),
])
harvest('impl:fake-opencode', fake)
harvest('impl:config', cfg)
if (!fake || !cfg) return blocked('FakeWave', { fake, cfg })
log(`Fake wave done: fake=${fake.filesTouched.length} file(s), config=${cfg.filesTouched.length} file(s)`)

phase('GateA')
const gateA = await gateLoop('GateA', 'fake-wave', gateAPrompt)
if (!gateA || !gateA.pass) return blocked('gate:fake-wave', { gateA })
log('Gate A GREEN — fake proven, config surface in')

// ---- Phase 2: the adapter (solo)
phase('Adapter')
const adapter = await agent(ADAPTER_PROMPT, { label: 'impl:adapter', phase: 'Adapter', schema: REPORT })
harvest('impl:adapter', adapter)
if (!adapter) return blocked('impl:adapter', {})
log(`Adapter done — ${adapter.summary.slice(0, 120)}`)

phase('GateB')
const gateB = await gateLoop('GateB', 'adapter', gateBPrompt)
if (!gateB || !gateB.pass) return blocked('gate:adapter', { gateB })
log('Gate B GREEN — adapter faithful to the frozen probe doc')

// ---- Phase 3: kit wiring (solo)
phase('KitWiring')
const wiring = await agent(KIT_PROMPT, { label: 'impl:kit-opencode', phase: 'KitWiring', schema: REPORT })
harvest('impl:kit-opencode', wiring)
if (!wiring) return blocked('impl:kit-opencode', {})
log(`Kit wiring done — ${wiring.summary.slice(0, 120)}`)

// ---- Final gate
phase('FinalGate')
const finalGate = await gateLoop('FinalGate', 'final', finalGatePrompt)
if (!finalGate || !finalGate.pass) return blocked('gate:final', { finalGate })
log('FINAL GATE GREEN — three conforming backends')

return {
  status: 'green',
  exitCriterion: 'opencode fake passes the 10-assertion kit; three backends declare capabilities and pass; full suite green',
  coverageMap: finalGate.coverageMap,
  gates: { gateA, gateB, finalGate },
  reports,
  friction: frictionLog,
}
