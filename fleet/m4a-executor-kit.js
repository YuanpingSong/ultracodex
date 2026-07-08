// M4a step 2 — the fleet builds the executor conformance story (dogfood run).
//
// Arbiter: docs/executor-contract.md (Executor Contract v1, FROZEN before this
// run started). Shape: staged-build-gates — solo foundation wave, then a
// two-builder parallel wave with disjoint file ownership, then solo claude
// wiring; a gate agent runs the full typecheck + suite between waves and
// reconciles drift with the contract doc as arbiter; bounded fix loops.
// Every agent returns a `friction` list — raw material for the cookbook.
//
// Run it (from the repo root, under an INSTALLED ultracodex, never repo dist):
//   ultracodex run workflows/m4a-executor-kit.js --json
export const meta = {
  name: 'm4a-executor-kit',
  description: 'Extract src/executor/contract.ts, add capability declarations, build the 10-assertion conformance kit, bring both adapters through it — staged waves with full-suite gates, docs/executor-contract.md as arbiter',
  phases: [
    { title: 'Foundation', detail: 'contract.ts extraction + capability declarations + degradation-warning wiring' },
    { title: 'Gate1', detail: 'full typecheck+suite, field-for-field contract audit, bounded fix loop' },
    { title: 'KitWave', detail: 'parallel: conformance kit + codex wiring | shared fake-claude fixture' },
    { title: 'Gate2', detail: 'first full-suite meeting of the wave, 10-assertion coverage audit' },
    { title: 'ClaudeWiring', detail: 'claude adapter through the full kit' },
    { title: 'FinalGate', detail: 'M4a exit criterion: both adapters declare + pass, 20-entry coverage map' },
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
    notes: { type: 'string' },
    friction: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'checksRun', 'fixesApplied', 'remainingIssues', 'coverageMap', 'notes', 'friction'],
}

const COMMON = `You are one agent in a fleet upgrading ultracodex — the TypeScript ESM repo (Node 20+, pnpm, vitest) at your working directory (the repo root). The program: extract the executor seam into a versioned contract module, add capability declarations, and build a conformance kit that any backend adapter must pass.

THE ARBITER — read it before anything else: docs/executor-contract.md (Executor Contract v1, FROZEN). Every design decision resolves against that document. Where existing code and the contract disagree, the contract wins. Where the contract is ambiguous, do NOT silently improvise: pick the minimal compliant interpretation, record it in \`decisions\`, and flag anything genuinely blocking in \`friction\`.

HOUSE RULES:
- ESM + NodeNext: every relative import needs a .js suffix.
- Touch ONLY files in your assignment. Never edit docs/**, README.md, examples/**, skills/**, workflows/**, package.json, tsconfig.json. Never read or write .ultracodex/** (the engine running YOU keeps live state there). Never run git commit, git push, or pnpm build.
- Match the existing code style (read 2-3 neighboring files first): terse, small functions, comments only for non-obvious constraints.
- Commands: pnpm typecheck (tsc --noEmit) / pnpm test (full vitest suite) / npx vitest run tests/<file> (targeted). Your assignment says which you may run.
- Tests must stay hermetic: temp dirs via fs.mkdtempSync(path.join(os.tmpdir(), ...)), no network, never the real codex/claude binaries — scriptable fakes only.

RETURN raw data per your schema. \`decisions\` = choices you made where the contract left room. \`friction\` = anything unclear, awkward, or missing in this task's setup — prompt gaps, contract gaps, tooling annoyances. Be candid; friction reports steer the project's cookbook.`

const FOUNDATION_PROMPT = `${COMMON}

YOUR ASSIGNMENT — foundation: extract the contract module and wire capability declarations. You work alone this phase; the whole repo must be consistent when you finish.

Read in order: docs/executor-contract.md (all of it — §1, §3, §6 especially), src/types.ts, src/executor/router.ts, src/executor/codex.ts, src/executor/claude.ts, src/runner.ts (the createExecutors call site near line 49 — note the journal is in scope there), tests/router.test.ts.

Deliverables:
1. NEW src/executor/contract.ts — the versioned contract module (v1). Move Executor, ExecutorRequest, ExecutorContext, ExecutorResult out of src/types.ts UNCHANGED IN SHAPE, define CapabilityDescriptor exactly as contract §3 writes it, and add \`readonly capabilities: CapabilityDescriptor\` to Executor (contract §1). Types that stay in types.ts (Effort, ActivityEvent, Usage) come in via \`import type\` from ../types.js — type-only cycles are fine, runtime cycles are not.
2. src/types.ts re-exports everything moved (export type { ... } from "./executor/contract.js") so every existing import in src/ and tests/ keeps compiling; do not chase import sites.
3. Capability declarations on both adapters, derived from their ACTUAL behavior — verify these hints against the code and record in \`decisions\` if you conclude differently:
   - CodexExecutor (src/executor/codex.ts): schema "wire" (strictifyForWire on the wire + prompt fallback when null), resume true (repair turns reuse the thread), interrupt "graceful" (turn/interrupt — see src/appserver/turn.ts), usage "per-turn" (tokenUsage ticks stream during the turn), activity true, sandbox = the exact sandbox policy names the codex config accepts (find them in src/types.ts / src/config.ts).
   - ClaudeExecutor (src/executor/claude.ts): schema "prompt-only", resume true (--resume <sessionId> repair turns), interrupt "kill-only" (SIGTERM), usage — choose "per-turn" or "final" per contract §3 semantics given that usage arrives once per CLI invocation at process exit, and justify the choice in \`decisions\`; activity true (coarse status lines), sandbox [] (the adapter cannot honor profile sandbox/networkAccess).
4. src/executor/router.ts createExecutors(): key the registry by each executor's \`backend\` field (assert uniqueness), validate every capability descriptor at construction (all fields present, enum/type-legal — throw on a malformed declaration), and compute the construction-time degradation warnings contract §3 mandates: one warn-once message per (backend, profile, field) whose sandbox/networkAccess that backend's descriptor cannot honor, plus the usage:"none"-with-budget warning (no shipped backend declares "none", so make the warning computation a PURE function over (executors, profiles, budgetSet) that a unit test can drive with a stub executor). Pick the signature change you prefer (e.g. return { executors, warnings }) — record it — and update src/runner.ts to append each warning to the journal as a {t:"warn", ts, text} event at startup, wiring budgetSet from the run's actual budget.
5. Tests for the new surface (extend tests/router.test.ts and/or add tests/contract.test.ts): descriptor validation throws on a malformed declaration (stub executor); both real adapters declare legal descriptors; the unsupported-profile warning fires for the claude adapter when a profile sets sandbox or networkAccess (the shipped default config has such profiles — check src/constants.ts); a backend that CAN honor its profiles produces no warning; usage:"none" + budget → warning (stub). Never weaken an existing assertion — extend.

Verify before returning: pnpm typecheck && pnpm test — the FULL suite green (you are solo; run it all). Put the real outcome in \`verified\`.`

const gate1Prompt = `${COMMON}

YOU ARE THE FOUNDATION GATE. A single builder just extracted src/executor/contract.ts, added capability declarations to both adapters, and wired construction-time degradation warnings through createExecutors into the runner's journal. Verify the phase is truly green and contract-faithful; fix surgically what is not.

1. RUN pnpm typecheck and pnpm test. Every error or failure: fix the code toward docs/executor-contract.md (the arbiter), never by weakening or deleting a test. Record every fix in fixesApplied.
2. Field-for-field audit: src/executor/contract.ts against contract §1 and §3 — every interface, field name, optionality, and union value EXACTLY as documented. Executor carries readonly capabilities. src/types.ts re-exports so pre-existing imports compile untouched.
3. Both adapters declare descriptors consistent with their code (spot-check: codex = wire schema + turn/interrupt + per-turn usage ticks; claude = prompt-only + --resume repair + SIGTERM + sandbox []).
4. createExecutors validates descriptors, keys by backend name, computes profile-degradation warnings; src/runner.ts journals them as warn events; the warning computation is unit-tested including the usage:"none"+budget case.
5. Hygiene: git status and git diff --stat — only in-scope files changed (src/executor/*, src/types.ts, src/runner.ts, tests/*); the untracked workflows/ directory belongs to the run driving you — ignore it, never edit it. No .only/.skip, no debug output, style matches the repo.
DECIDING TEST: could a third-party adapter author import src/executor/contract.ts alone and get every type and capability shape the contract doc promises — with typecheck and the full suite green? pass=true only then. coverageMap: leave [].
List every check you ran with its real outcome in checksRun (include final test counts). Unfixed problems go in remainingIssues (empty when pass=true).`

const KIT_CODEX_PROMPT = `${COMMON}

YOUR ASSIGNMENT — the conformance-kit core + codex wiring. A sibling agent is concurrently building tests/fake-claude/** — do NOT create or edit any claude-related file; a later phase wires claude into your kit.

Read in order: docs/executor-contract.md §5 (the ten assertions — your requirements list, numbered) plus §2-§4 for semantics; src/executor/contract.ts; src/executor/codex.ts; tests/executor-codex.test.ts (how the existing tests drive the fake); tests/fake-codex/codex (its header comment documents the directive repertoire — [[reply]], [[slow]], [[fail]], [[usage]], [[midusage]], FAKE_CODEX_CRASH_MID_TURN, FAKE_CODEX_STALL_THREAD_START, FAKE_CODEX_ORPHAN_CHILD, …); tests/helpers.ts; src/constants.ts (INTERRUPT_GRACE_MS, DEFAULT_SCHEMA_RETRIES).

Deliverables — your files: tests/executor-kit/** (no claude files), tests/fake-codex/**, and minimal src/executor/codex.ts or src/appserver/** fixes ONLY if the kit exposes a real contract violation in the adapter (contract wins; record any such fix prominently in decisions):
1. tests/executor-kit/kit.ts — the reusable conformance suite: export a function that registers vitest describe/test blocks against ANY adapter, parametrized by a kit-adapter interface YOU design — roughly { name, makeExecutor(): Executor, stagers for each scenario: text success, schema-valid reply, invalid-then-valid repair sequence, always-invalid (retry exhaustion), harness failure, hang (for abort), mid-turn crash, usage ticks, session id, and — for wire adapters — a wire-schema rejection }. The suite implements ALL TEN assertions of contract §5, with the assertion number in each test name so coverage is auditable. Capability-driven applicability: an assertion that depends on a declared capability (e.g. #4 wire-rejection, only for schema:"wire") consults executor.capabilities and registers an explicitly-skipped test naming the reason — never silently absent.
   - #5 abort: assert run() settles within INTERRUPT_GRACE_MS of the signal firing AND no orphan processes survive (fake-codex's FAKE_CODEX_ORPHAN_CHILD + pid-file machinery shows the pattern — generalize it into a stager).
   - #6 usage: collect every onUsage tick; assert cumulative monotonic per field and the result's final usage consistent with the last tick.
   - #10 never-reject: run EVERY failure stager the adapter provides and assert the promise RESOLVES ok:false for each — a rejection is a kit failure.
2. tests/executor-kit/codex.kit.test.ts — CodexExecutor + tests/fake-codex through the full kit. Extend the fake's directive repertoire only where an assertion needs a behavior it cannot yet stage — the likely gap is #4: a wire-schema rejection class mirroring the live invalid_json_schema 400 (the fake-fidelity rule, contract §5, exists because of exactly that incident). Keep every pre-existing test green.

Verify before returning (targeted only — a sibling's files are in flight, do NOT run the full suite): npx vitest run tests/executor-kit/ tests/executor-codex.test.ts tests/appserver.test.ts tests/router.test.ts. Real outcomes into \`verified\`.`

const FAKE_CLAUDE_PROMPT = `${COMMON}

YOUR ASSIGNMENT — promote the claude fake to a first-class scriptable fixture. A sibling agent is concurrently building tests/executor-kit/** — do NOT touch tests/executor-kit/** or tests/fake-codex/**.

Read in order: src/executor/claude.ts (the exact CLI protocol you must fake: args \`-p --output-format json [--model M] [--resume ID]\` plus cfg.extraArgs, prompt on stdin, ONE JSON envelope on stdout: {type:"result", subtype, is_error, result, session_id, usage:{input_tokens, output_tokens, cache_read_input_tokens}} — and study parseEnvelope: its failure branches ARE your rejection-class list); tests/executor-claude.test.ts (an INLINE fake claude already lives in this file — it is your starting point, not something to invent from scratch); tests/fake-codex/codex (the house scriptable-fake conventions: header comment documenting every directive, [[directive]] markers in the prompt, env-var switches for process-level behaviors, invocations.jsonl logging).

Deliverables — your files: tests/fake-claude/**, tests/fake-claude.test.ts, tests/executor-claude.test.ts:
1. tests/fake-claude/claude — an executable zero-dependency Node script (mode +x; header comment in fake-codex's style documenting every directive) faking the claude CLI. Repertoire = everything the inline fake does today ([[reply]], [[nosession]], [[fail]], [[always-invalid]], [[invalid-first]], [[slow:MS]], --resume-aware repair replies, invocation logging) PLUS what the fake-fidelity rule (contract §5) demands — every rejection class parseEnvelope handles must be stageable: garbage/non-JSON stdout; empty stdout + nonzero exit with stderr text; mid-call crash (exit 1 partway through writing); an indefinite hang that never finishes but dies promptly on SIGTERM (for abort tests); usage-number control ([[usage:IN,OUT]] style); is_error / bad-subtype envelopes (exists today as [[fail]]). Spawn errors need no directive — tests stage those by pointing at a nonexistent binary. Make the invocation-log path controllable (env var) or per-copy so parallel tests don't share state — your call, record it.
2. tests/executor-claude.test.ts switches from its inline heredoc fake to the shared fixture. Every existing assertion stays; never weaken one.
3. tests/fake-claude.test.ts — unit tests driving the fake DIRECTLY (spawn it, feed directives, assert each staged behavior: every rejection class, the SIGTERM-on-hang dying promptly, session/--resume behavior, usage control, invocation logging).

Verify before returning (targeted only — a sibling's files are in flight, do NOT run the full suite): npx vitest run tests/executor-claude.test.ts tests/fake-claude.test.ts. Real outcomes into \`verified\`.`

const gate2Prompt = `${COMMON}

YOU ARE THE KIT-WAVE GATE. Two builders just finished in parallel: (A) the tests/executor-kit/ conformance suite + codex wiring (possibly extending tests/fake-codex), and (B) the shared tests/fake-claude/ fixture + migration of tests/executor-claude.test.ts onto it. This is the first time their work meets. Reconcile and verify; fix surgically.

1. RUN pnpm typecheck and pnpm test — the FULL suite. Fix every failure toward docs/executor-contract.md (the arbiter); cross-builder drift (kit API vs fixture conventions) resolves toward the contract first, then toward the smaller change. Never weaken or delete an assertion to get green. Record every fix in fixesApplied.
2. Coverage audit: map contract §5 assertions 1-10 to the codex kit tests BY NAME in coverageMap (e.g. "#5 abort → <exact test name>"). An assertion missing or watered down → fix the kit. Capability-conditional skips must name their reason in the test itself.
3. Fake-fidelity audit: tests/fake-claude/claude can stage every rejection class src/executor/claude.ts's parseEnvelope handles (is_error envelope, bad subtype, non-JSON stdout, nonzero exit, mid-call crash, hang); tests/fake-codex covers the wire-rejection class assertion #4 needs.
4. Hygiene: git status and git diff --stat — only in-scope files (tests/executor-kit/*, tests/fake-codex/*, tests/fake-claude/*, tests/fake-claude.test.ts, tests/executor-claude.test.ts, plus any recorded minimal src/executor fix); the untracked workflows/ directory belongs to the run driving you — ignore it. No .only, no debug output, style consistent.
DECIDING TEST: does pnpm test run the whole ten-assertion kit against the real CodexExecutor via its fake — green, every assertion exercised or explicitly capability-skipped — and is the claude fixture proven ready for wiring (its unit tests exercise every scriptable behavior)? pass=true only then.
checksRun gets every check with its real outcome incl. final test counts; remainingIssues empty when pass=true.`

const CLAUDE_WIRING_PROMPT = `${COMMON}

YOUR ASSIGNMENT — wire the claude adapter into the conformance kit. You work alone; tests/executor-kit/kit.ts, the codex wiring, and the shared tests/fake-claude/claude fixture all exist and are green.

Read in order: docs/executor-contract.md §3-§5; tests/executor-kit/kit.ts and tests/executor-kit/codex.kit.test.ts (the worked example); tests/fake-claude/claude (directive header); tests/fake-claude.test.ts; src/executor/claude.ts.

Deliverables:
1. tests/executor-kit/claude.kit.test.ts — ClaudeExecutor + tests/fake-claude through the FULL kit. Expected capability-driven shape: schema "prompt-only" → assertion #4 explicitly skipped with reason; #5 abort exercises the SIGTERM path settling within the grace window with no orphans; #6 usage per the adapter's declared mode; #7 session id via the envelope's session_id.
2. You MAY minimally extend tests/fake-claude/claude (new directives) and adjust tests/executor-kit/kit.ts where a genuine portability gap surfaces (something codex-specific leaked into the kit's design) — record every such change in decisions and keep the codex kit tests and fake-claude unit tests green.
3. If an assertion fails because src/executor/claude.ts genuinely violates the contract, fix the ADAPTER minimally (the contract wins) and record it prominently in decisions.

Verify before returning: npx vitest run tests/executor-kit/ tests/executor-claude.test.ts tests/fake-claude.test.ts, then the FULL pnpm typecheck && pnpm test (you are solo — run it all). Real outcomes into \`verified\`.`

const finalGatePrompt = `${COMMON}

YOU ARE THE FINAL GATE — the M4a exit criterion is yours to certify. The full program is in the working tree: src/executor/contract.ts, capability declarations on both adapters, degradation-warning wiring, the tests/executor-kit/ suite, both adapter wirings, and the shared fakes.

1. RUN pnpm typecheck and pnpm test — full and green; put the final counts in checksRun. Fix surgically anything red (arbiter: docs/executor-contract.md; never weaken a test).
2. EXIT-CRITERION AUDIT: for EACH of the ten contract §5 assertions × EACH adapter (codex, claude) name in coverageMap the covering test or the declared-capability skip reason ("#4 claude → skipped: schema=prompt-only"). Twenty entries. A gap = fix it or fail the gate.
3. Contract-faithfulness spot checks: contract.ts fields verbatim against §1/§3; each descriptor matches its adapter's actual behavior; createExecutors validates + computes warnings; src/runner.ts journals them.
4. Regression hygiene: git status and git diff --stat — every changed/added file inside the build's scope (src/executor/*, src/types.ts, src/runner.ts, tests/*); the untracked workflows/ directory belongs to the run driving you — ignore it. Diff every PRE-EXISTING test file and justify anything that reads as a weakened assertion. No .only, no skipped test without a capability reason, no debug output.
5. Style pass over the new files: repo idiom — terse, constraint-comments only.
DECIDING TEST (the M4a exit criterion, contract §5): both adapters declare capabilities and pass the conformance kit, the full suite is green, and a third-party adapter author could build from docs/executor-contract.md + tests/executor-kit/ alone. pass=true only then; remainingIssues empty.`

function fixPrompt(gateName, gate) {
  return `${COMMON}

YOU ARE A FIXER. The ${gateName} gate failed. Its remaining issues, verbatim:
${gate.remainingIssues.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Gate notes: ${gate.notes}

Fix ONLY these issues, minimally and surgically, with docs/executor-contract.md as the arbiter. Never weaken or delete a test to get green. Then RUN pnpm typecheck && pnpm test (full) and report the real outcome in \`verified\`.`
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

// ---- Phase 1: foundation (solo)
phase('Foundation')
log('Foundation: contract.ts extraction + capability declarations + warning wiring')
const foundation = await agent(FOUNDATION_PROMPT, { label: 'impl:contract', phase: 'Foundation', schema: REPORT })
harvest('impl:contract', foundation)
if (!foundation) return blocked('impl:contract', {})
log(`Foundation done: ${foundation.filesTouched.length} file(s) — ${foundation.summary.slice(0, 120)}`)

phase('Gate1')
const gate1 = await gateLoop('Gate1', 'foundation', gate1Prompt)
if (!gate1 || !gate1.pass) return blocked('gate:foundation', { gate1 })
log('Gate 1 GREEN — contract module + declarations are in')

// ---- Phase 2: kit + fixture, disjoint parallel builders
phase('KitWave')
log('Kit wave: conformance kit + codex wiring || shared fake-claude fixture')
const [kitCodex, fakeClaude] = await parallel([
  () => agent(KIT_CODEX_PROMPT, { label: 'impl:kit-codex', phase: 'KitWave', schema: REPORT }),
  () => agent(FAKE_CLAUDE_PROMPT, { label: 'impl:fake-claude', phase: 'KitWave', schema: REPORT }),
])
harvest('impl:kit-codex', kitCodex)
harvest('impl:fake-claude', fakeClaude)
if (!kitCodex || !fakeClaude) return blocked('KitWave', { kitCodex, fakeClaude })
log(`Kit wave done: kit=${kitCodex.filesTouched.length} file(s), fixture=${fakeClaude.filesTouched.length} file(s)`)

phase('Gate2')
const gate2 = await gateLoop('Gate2', 'kit-wave', gate2Prompt)
if (!gate2 || !gate2.pass) return blocked('gate:kit-wave', { gate2 })
log('Gate 2 GREEN — codex passes the kit; claude fixture proven')

// ---- Phase 3: claude wiring (solo)
phase('ClaudeWiring')
const wiring = await agent(CLAUDE_WIRING_PROMPT, { label: 'impl:kit-claude', phase: 'ClaudeWiring', schema: REPORT })
harvest('impl:kit-claude', wiring)
if (!wiring) return blocked('impl:kit-claude', {})
log(`Claude wiring done — ${wiring.summary.slice(0, 120)}`)

// ---- Final gate
phase('FinalGate')
const finalGate = await gateLoop('FinalGate', 'final', finalGatePrompt)
if (!finalGate || !finalGate.pass) return blocked('gate:final', { finalGate })
log('FINAL GATE GREEN — M4a exit criterion certified by the fleet')

return {
  status: 'green',
  exitCriterion: 'both adapters declare capabilities and pass the 10-assertion conformance kit; full suite green',
  coverageMap: finalGate.coverageMap,
  gates: { gate1, gate2, finalGate },
  reports,
  friction: frictionLog,
}
