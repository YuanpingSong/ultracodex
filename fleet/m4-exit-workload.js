// M4 EXIT WORKLOAD — the recursive acceptance run for the whole arc.
//
// One script, one journal, three vendors, routed by .ultracodex/config.toml:
//   impl:*   → opencode (deepseek-chat)   — implementation
//   gate:*   → codex   (gpt-5.5)          — build gates + fixes
//   review:* → claude  (sonnet, read-only) — adversarial review
//
// The workload is real backlog: `ultracodex doctor` grows an opencode
// section (the probe doc's security-posture mandate). If this run goes
// green, the M4b exit criterion is met by demonstration: implementation on
// one vendor, verification on another, review on a third — on the engine's
// own repository.
//
// Run it (from the repo root, under the INSTALLED rc engine, never repo dist):
//   ultracodex run workflows/m4-exit-workload.js --json
export const meta = {
  name: 'm4-exit-workload',
  description: 'Mixed-routing acceptance run: opencode implements the doctor opencode section, codex gates it, claude reviews it — one journal, three backends',
  phases: [
    { title: 'Impl', detail: 'opencode/deepseek-chat: doctor opencode section + tests' },
    { title: 'Gate', detail: 'codex/gpt-5.5: full typecheck+suite, scope + convention audit' },
    { title: 'Review', detail: 'claude (read-only): adversarial review; codex fixes on request-changes' },
  ],
}

const REPORT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    verified: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    friction: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'filesTouched', 'verified', 'decisions', 'friction'],
}

const GATE = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    checksRun: { type: 'array', items: { type: 'string' } },
    fixesApplied: { type: 'array', items: { type: 'string' } },
    remainingIssues: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    friction: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'checksRun', 'fixesApplied', 'remainingIssues', 'decisions', 'notes', 'friction'],
}

const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'request-changes'] },
    findings: { type: 'array', items: { type: 'string' }, description: 'each finding prefixed [blocker]/[major]/[minor]/[nit]' },
    notes: { type: 'string' },
    friction: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'findings', 'notes', 'friction'],
}

const CONVENTIONS = `Repo facts: TypeScript ESM (NodeNext — every relative import needs a .js suffix), pnpm, vitest. Commands: pnpm typecheck / pnpm test / npx vitest run tests/<file>. Never run git commit, git push, or pnpm build. Never touch docs/**, README.md, examples/**, skills/**, workflows/**, fixtures/**, package.json, tsconfig.json, .ultracodex/**. Match existing code style: terse, small functions, comments only for non-obvious constraints.`

const TASK = `THE TASK — \`ultracodex doctor\` grows an opencode section. The normative source for every claim is docs/internal/research/opencode-probe.md (read its "Security posture" and "Headline findings" sections first). Current doctor code: src/cli.ts, function doctorAction (~line 682) — study its report()/info() helpers, the codex-binary block (~line 713-741, the pattern to mirror), TESTED_CODEX_VERSION usage, and DOCTOR_PROBE_TIMEOUT_MS.

Deliverables, exactly:
1. src/constants.ts: export const TESTED_OPENCODE_VERSION = "1.16.2"; (place beside TESTED_CODEX_VERSION).
2. src/cli.ts: export a helper so the logic is unit-testable without spawning anything:
   export async function opencodeDoctorReport(
     config: UltracodexConfig,
     probeVersion: (binary: string) => Promise<string>,
   ): Promise<{ lines: Array<{ kind: "ok" | "fail" | "info"; label: string; detail: string; hint?: string }>; hardFail: boolean }>
   Behavior:
   - Not routed (no config.route entry with backend "opencode"): return a single info line — label "opencode", detail "not routed; skipping checks" — and hardFail false. Do NOT probe the binary.
   - Routed: call probeVersion(config.opencode.binary). On rejection: one fail line (label "opencode binary", detail naming the binary and the error, hint "install opencode (https://opencode.ai) or set [backends.opencode].binary in config.toml") and hardFail true (a routed backend that cannot run IS a hard failure — same semantics as the codex binary check).
   - On success: one ok line (label "opencode binary", detail = trimmed version output + pin note in EXACTLY the codex style: "(matches tested pin X)" or "(tested against X)" using TESTED_OPENCODE_VERSION), plus — only when the version does not match the pin — one info line like the codex version drift note.
   - Always when routed and the binary responded, three info posture lines sourced from the probe doc (keep each to one line, doctor voice):
     label "opencode sandbox": agents run WITHOUT OS sandboxing — the engine warns and passes through; confinement is the per-call tools map only
     label "opencode permissions": headless default executes tools including shell with no approval gate
     label "opencode mcp": MCP servers from the user's opencode config are inherited into every agent session
3. src/cli.ts doctorAction: after the existing codex/app-server checks, call opencodeDoctorReport(config, <real probe using execFileP with DOCTOR_PROBE_TIMEOUT_MS>) when config loaded; map lines through the existing report()/info() helpers (kind ok/fail → report(true/false,...), info → info(...)); OR hardFail into the function's hardFail.
4. tests/cli.test.ts: unit tests for opencodeDoctorReport driving probeVersion with stubs (resolve / reject): not-routed → single info, no probe call; routed + probe rejects → fail line + hardFail true; routed + version matches pin → ok line says "matches tested pin", no drift info line, three posture lines present; routed + version differs → "tested against" + drift info line. Follow the file's existing describe/test style; never modify an existing test.

Verify before returning: pnpm typecheck && npx vitest run tests/cli.test.ts — both green; put the real output in \`verified\`. Then run pnpm test (full suite) and report its outcome too.`

const IMPL_PROMPT = `You are implementing one feature in the ultracodex repo (your working directory is the repo root). ${CONVENTIONS}

${TASK}

RETURN raw data per your schema: summary, filesTouched, verified (exact commands + real outcomes), decisions (choices where instructions left room), friction (anything unclear or awkward about this task's setup — be candid).`

const GATE_PROMPT = `You are the build gate for a one-feature change in the ultracodex repo (working directory = repo root). An implementation agent (a different vendor's model) just added an opencode section to \`ultracodex doctor\`. ${CONVENTIONS}

The spec it worked from is reproduced here verbatim between the markers:
---SPEC---
${TASK}
---END SPEC---

1. RUN pnpm typecheck and pnpm test (full). Fix every failure minimally — toward the spec and docs/internal/research/opencode-probe.md; never weaken or delete a test.
2. Audit the diff (git status --short -uall; the untracked workflows/ directory belongs to the run driving you — ignore it): only spec-scoped files changed (src/cli.ts, src/constants.ts, tests/cli.test.ts); helper signature and behaviors match the spec exactly (not-routed short-circuit, routed hardFail semantics, pin-note wording matches the codex style, three posture lines); posture wording is accurate per the probe doc; doctorAction wiring maps kinds correctly and propagates hardFail; style matches the file.
3. Sanity-run the real thing: node dist is NOT built — instead verify by unit tests plus reading doctorAction's wiring carefully.
Record every check with its real outcome in checksRun; fixes in fixesApplied; unfixed problems in remainingIssues (empty when pass=true).`

const reviewPrompt = (files) => `You are an adversarial code reviewer. You have READ-ONLY access (Read/Glob/Grep — no shell, no git). Review a just-implemented feature in the ultracodex repo: \`ultracodex doctor\` grew an opencode section.

Read, in order:
1. docs/internal/research/opencode-probe.md — sections "Security posture" and "Headline findings" (the normative source for every claim the feature makes)
2. src/cli.ts — find opencodeDoctorReport and its call site in doctorAction; also read the neighboring codex-binary block for the conventions it should mirror
3. src/constants.ts — TESTED_OPENCODE_VERSION
4. tests/cli.test.ts — the new opencodeDoctorReport tests
Files the implementers report touching: ${files.join(', ')}

Hunt for real problems, hardest first:
- FACTUAL: does any doctor line overstate or understate the probe doc? (e.g. claiming a sandbox exists, wrong version pin, posture wording that would mislead an operator)
- SEMANTIC: hardFail semantics (not-routed must never fail; routed-but-broken must fail); the not-routed path must not probe; pin-drift info line only on mismatch
- TEST QUALITY: do the tests actually pin the behaviors above, or would a subtle regression pass? Any weakened/removed existing assertion?
- CONVENTIONS: output voice/format consistent with the sibling codex checks; ESM .js import suffixes; style
Do not review anything outside this feature. verdict: "approve" only if nothing [blocker] or [major] remains; otherwise "request-changes". findings: each prefixed [blocker]/[major]/[minor]/[nit] with file:line where possible. Return raw data per your schema.`

const fixPrompt = (review) => `You are fixing review findings in the ultracodex repo (working directory = repo root). ${CONVENTIONS}

An adversarial reviewer returned request-changes on the doctor opencode section. Findings, verbatim:
${review.findings.map((f, i) => `${i + 1}. ${f}`).join('\n')}
Reviewer notes: ${review.notes}

Fix the [blocker] and [major] findings minimally (apply [minor]/[nit] only where trivial); the arbiter for factual claims is docs/internal/research/opencode-probe.md. Never weaken or delete a test. Then RUN pnpm typecheck && pnpm test (full) and report real outcomes in \`verified\`.`

const reports = []
const frictionLog = []
function harvest(name, r) {
  if (!r) return
  reports.push({ agent: name, summary: r.summary ?? r.notes ?? '', decisions: r.decisions ?? [], fixesApplied: r.fixesApplied ?? [] })
  for (const f of r.friction ?? []) frictionLog.push(`[${name}] ${f}`)
}

// ---- Impl (opencode)
phase('Impl')
log('Impl on opencode: doctor grows its opencode section')
const impl = await agent(IMPL_PROMPT, { label: 'impl:doctor-opencode', phase: 'Impl', schema: REPORT })
harvest('impl:doctor-opencode', impl)
if (!impl) return { status: 'blocked', at: 'impl:doctor-opencode', reports, friction: frictionLog }
log(`Impl done: ${impl.filesTouched.length} file(s) — ${impl.summary.slice(0, 100)}`)

// ---- Gate (codex)
phase('Gate')
const gate = await agent(GATE_PROMPT, { label: 'gate:verify', phase: 'Gate', schema: GATE })
harvest('gate:verify', gate)
if (!gate || !gate.pass) return { status: 'blocked', at: 'gate:verify', gate, reports, friction: frictionLog }
log('Gate GREEN (codex) — full suite + spec audit')

// ---- Review (claude) with bounded fix loop
phase('Review')
const files = [...new Set([...(impl.filesTouched ?? []), ...(gate.fixesApplied ?? []).length ? ['src/cli.ts'] : []])]
let review = await agent(reviewPrompt(files.length ? files : ['src/cli.ts', 'src/constants.ts', 'tests/cli.test.ts']), { label: 'review:doctor', phase: 'Review', schema: REVIEW })
harvest('review:doctor', review)
let rounds = 0
while (review && review.verdict === 'request-changes' && rounds < 2) {
  rounds += 1
  log(`Review requested changes (round ${rounds}): ${review.findings.length} finding(s) — codex fixes`)
  const fixer = await agent(fixPrompt(review), { label: `gate:fix-${rounds}`, phase: 'Review', schema: REPORT })
  harvest(`gate:fix-${rounds}`, fixer)
  review = await agent(reviewPrompt(['src/cli.ts', 'src/constants.ts', 'tests/cli.test.ts']) + '\n\nNOTE: a fixer has since applied changes for your previous findings — review from scratch.', { label: `review:doctor-r${rounds}`, phase: 'Review', schema: REVIEW })
  harvest(`review:doctor-r${rounds}`, review)
}
if (!review || review.verdict !== 'approve') {
  return { status: 'blocked', at: 'review', review, reports, friction: frictionLog }
}
log('Review APPROVED (claude) — three vendors, one journal, green')

return {
  status: 'green',
  exitCriterion: 'mixed-routing workload: impl on opencode, gate on codex, review on claude — one script, one journal, all green',
  reviewVerdict: review.verdict,
  reviewFindings: review.findings,
  gate,
  reports,
  friction: frictionLog,
}
