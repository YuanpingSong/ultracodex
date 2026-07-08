// Loops pillar, run 3b — final verifier for loops-3-observability.
// Gate history: r1-r3 churned solely on a contract ambiguity (sparkline
// scaling) that the parent has since arbitrated in the contract text below
// (scale-to-max is final; the tree already implements it). All other checks
// passed in gate r3. This run executes the Verify phase that never ran.
export const meta = {
  name: 'loops-3b-verify',
  description: 'Fresh-eyes final verification of the loop observability build (build, suite, fixture frames, real-run fold)',
  phases: [ { title: 'Verify', detail: 'build + full suite + fixture frames + real journal fold' } ],
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
    summary: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          issue: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'file', 'issue', 'fix'],
      },
    },
  },
  required: ['pass', 'summary', 'issues'],
}
const VERIFY = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    buildOk: { type: 'boolean' },
    testsOk: { type: 'boolean' },
    smokeOk: { type: 'boolean' },
    details: { type: 'string' },
  },
  required: ['pass', 'buildOk', 'testsOk', 'smokeOk', 'details'],
}

const COMMON = `Working dir = the ultracodex repo root. TypeScript sources in src/, TUI is Ink+React in src/tui/, vitest tests in tests/. NO new runtime dependencies. Use package.json scripts for build/test. NEVER run git commit or touch the git index; check hygiene with git status --short -uall. Do not bump the package version. RETURN raw data per your schema — your final text is parsed, not read by a human.`

// ————— FROZEN CONTRACT (parent-authored; the arbiter for the gate) —————
const CONTRACT = `
LOOP OBSERVABILITY CONTRACT v1 (frozen — deviations need a "decisions" entry):

A. DETECTION (src/tui/loops.ts, PURE — no fs, no Ink):
   detectLoops(state: TuiState, readAgentOutput: (resultRef: string) => string | null): LoopInstance[]
   Round markers, per agent:
     - LABEL form (wins when both match): label matches /^(.*?)(?:-r|:round-)(\\d+)$/
       → stem = capture 1, round = capture 2. Examples: "gate:scheduler-r2"
       → stem "gate:scheduler" round 2; "build:parser:round-3" → stem
       "build:parser" round 3.
     - PHASE form: phase title matches /^(?:(.+?)\\s*[·:–—-]?\\s*)?[Rr]ound[\\s-]?(\\d+)$/
       → stem = capture 1 (may be absent), round = capture 2. Examples:
       "Round 3" (no stem), "Review Round 2" (stem "Review").
   Loop identity: stem containing ":" → loopId = substring before the LAST
   ":" ("goal:build" and "goal:verify" join loop "goal"); stem without ":"
   present → loopId = stem for PHASE form, but for LABEL form bare stems all
   join ONE implicit loop whose id = state.meta?.name ?? "loop" (a script
   simple enough for bare -rN labels has one loop; multi-loop scripts use
   the <loop>:<role> form). Phase-form agents with no stem join the implicit
   loop too.
   A loop QUALIFIES when it has >=2 distinct round numbers, OR >=1 while
   state.status === "running".
   LoopInstance (FROZEN): { id: string, rounds: Round[], status: "running"|
   "converged"|"ended", convergedAt: number|null, totalTokens: number,
   totalDurationMs: number }. Round: { n: number, agents: AgentView[],
   outputTokens: number, durationMs: number (max end - min start, running
   agents use now via a nowMs parameter — keep the function deterministic
   for tests), verdict: { kind: "approved"|"rejected"|"unknown",
   text: string|null } }. Rounds sorted ascending by n.
   VERDICT EXTRACTION per round: walk the round's agents in DESCENDING
   ordinal order (the verifier runs last); first agent whose resultRef ends
   in ".json" and whose readAgentOutput returns parseable JSON decides:
   (1) top-level string field "verdict": lowercased value in
   {approved, pass, passed, ok, yes, done, converged} → approved; in
   {rejected, fail, failed, no} → rejected; any other string → unknown with
   that string as text. (2) else the FIRST PRESENT boolean among fields
   [approved, pass, passed, ok, real, isReal, converged, done] → true=
   approved / false=rejected. Verdict text: first present non-empty string
   among [issues (array → join "; "), note, reason, summary], truncated to
   120 chars. Unparseable/absent JSON → {kind: "unknown", text: null}.
   NEVER throw on malformed output. Callers cap file reads (skip > 256 KB).
   Loop status: run running → "running"; run ended with last round approved
   → "converged" (convergedAt = last n); otherwise "ended".
   Pure display helpers, exported and unit-tested: trajectoryStrip(rounds)
   → "✖ ✖ ✔" (glyphs: approved ✔, rejected ✖, unknown ·, running round
   uses the spinner char passed in), costSparkline(rounds) over
   outputTokens: ▁▂▃▄▅▆▇█ SCALED TO THE ROUND MAX (the max-cost round
   renders █; the mockup's low-height strip is illustrative, not normative
   — its normative content is the sparkline's placement and the Δ% figure),
   plus deltaPct(first, last) for the "↓44%" figure. Fixture
   61.4k/52.7k/34.1k renders "█▇▅" with ↓44%. [Arbitrated by the parent
   2026-07-08 after gate oscillation; scale-to-max is final.]

B. LoopView (src/tui/LoopView.tsx) — the owner-approved trajectory
   dashboard. THIS MOCKUP IS THE SPEC (information architecture exact;
   spacing adapts to width):

    goal · wf_7fk2qd · ✔ converged after 3 rounds · 148.2k tok · 11m 32s

      r1 ✖         r2 ✖         r3 ✔
     61.4k        52.7k        34.1k        cost/round ▂▂▁ ↓44%

    ROUND LEDGER
      rnd  verdict     agents  tok     Δtok    time
    ❯ r1   ✖ rejected  2       61.4k   —       4m 02s
      r2   ✖ rejected  2       52.7k   −14%    3m 48s
      r3   ✔ approved  2       34.1k   −35%    3m 42s

    ROUND r1 — 2 agents
      ✔ build-r1  · codex·gpt-5.5 · 3m 10s · 48.9k tok
      ✔ verify-r1 · claude·sonnet-5 · 52s · 12.5k tok
        └ verdict: rejected — "criteria 2/4: tests missing, no docs"

    ↑↓ rounds · ↵ agent detail · esc back · q quit

   Header status variants: "✔ converged after N rounds" / "● running
   (round N)" with spinner / "✖ ended after N rounds (not converged)".
   Hero strip: one chip per round (cap at the last 10 rounds with a leading
   "… " when more), tokens beneath each chip, cost/round sparkline + Δ%
   right-aligned. Ledger: selectable rows (❯ pointer, ↑↓), columns rnd /
   verdict / agents / tok / Δtok (vs previous round, signed %) / time.
   Below: selected round's agents in the EXISTING agent-row chrome (reuse
   the same glyph/format helpers as RunView), plus one dim
   "└ verdict: <kind> — \"<text>\"" line when the verdict has text. ↵ on the
   focused agent opens the existing AgentDetail. esc returns to wherever the
   view was opened from; q quits the TUI. Live runs update from the same
   journal-tail state source RunView uses (re-fold on state change; the
   running round shows the spinner in its chip and ledger row).
   Multi-loop runs: when a run has several LoopInstances, LoopView shows one
   at a time with a "loop 1/2 · L next" affordance (L cycles).

C. ENTRY POINTS.
   - RunView: when detectLoops() is non-empty, show a dim "⟳ N loop(s) · L"
     hint (header right or footer — match existing chrome) and key L opens
     LoopView for the run (esc returns to RunView). No other RunView change.
   - HomeView: a Runs | Loops tab strip above the lists ("tab" key toggles;
     style the active tab like the existing phase-strip active state). Runs
     tab = the existing HomeView content, unchanged. Loops tab = loop
     instances across the same recent runs listRuns() already returns
     (fold lazily on tab activation; cache per runId keyed by journal file
     mtime; skip runs with zero loops; cap 12 rows). Row format:
     "❯ ✔ wf_7fk2qd goal · ✖ ✖ ✔ · converged r3 · 148k · 11m"
     (status glyph = loop status; trajectory strip capped at 10). ↑↓ select,
     ↵ opens LoopView (esc back to the Loops tab). Empty state: dim one-liner
     "no loops detected in recent runs — see docs/loops.md".
   - HomeView workflows list: also list package-builtin workflows (the
     resolver's builtin dir) after project-saved ones, rendered with a dim
     "(builtin)" suffix, launchable exactly like saved ones (project-saved
     shadows the builtin name — show only the project one on collision).
   - static show (src/tui/static.ts): when loops are detected, append a
     LOOPS section — per loop: header line (id, status, trajectory strip,
     totals) + one line per round (rnd, verdict, agents, tok, time). Same
     glyph vocabulary.
D. TESTS (tests/loops.test.ts + extensions to existing suites): synthetic
   TuiState fixtures (build them via the real reducer over synthetic journal
   events where practical) + fake readAgentOutput covering: label-form
   detection; phase-form detection ("Round 1"/"Review Round 2"); colon
   grouping (goal:build-r1 + goal:verify-r1 → one loop "goal"); two loops
   via distinct prefixes (gate:a-r1/gate:a-r2 vs review:b-r1/review:b-r2 —
   NOTE these share no colon-parent so they are loops "gate:a"→"gate" and
   "review:b"→"review"... follow rule A exactly: before-last-colon); bare
   stems joining the implicit loop; single-round non-loop rejected unless
   running; verdict extraction for every branch in A (string enum, boolean
   priority order, text sources, malformed JSON, oversized skip);
   trajectoryStrip/costSparkline/deltaPct exact strings; ledger Δtok math;
   static show LOOPS section rendering from a fixture (exact-ish string
   assertions on a narrow fixture); HomeView loop-row formatting via
   whatever pure helper produces it (extract row text builders as pure
   functions so they are testable without Ink). If the repo has no Ink
   component test harness, do NOT add one — pure-helper coverage + static.ts
   coverage is the requirement. Full existing suite stays green.
E. HYGIENE: no fs reads inside render paths except through the existing
   state/tail hooks and the capped readAgentOutput closure (bind it to the
   run dir where TuiState is folded); no polling loops beyond existing
   journal tailing; 80-column terminals must not wrap (reuse the existing
   truncate/window helpers).
`

phase('Verify')
const verify = await agent(`${COMMON}

YOU ARE THE FINAL VERIFIER. Fresh eyes, no prior context. (1) Build — buildOk. (2) Full vitest suite — testsOk. (3) Smoke: build a synthetic run dir (journal.jsonl via the event shapes in src/journal.ts + agents/N-label/output.json files) for a 3-round loop with labels goal:build-r1..r3 / goal:verify-r1..r3 and verifier outputs rejected/rejected/approved; run the show command against it and confirm the LOOPS section reports "goal", trajectory ✖ ✖ ✔, converged r3; ALSO fold a run dir from this repo's own .ultracodex/runs (there are real fleet runs with gate:*-r1 labels — pick one) and confirm detection neither crashes nor mislabels a single-round gate as a loop unless it had >=2 rounds. (4) git status --short -uall — changes confined to src/tui/, tests/, docs/ if touched. pass = all four. Report exact failures in details.`, { label: 'verify:observability', phase: 'Verify', schema: VERIFY, effort: 'high' })

return { status: verify && verify.pass ? 'green' : 'needs-review', verify }
