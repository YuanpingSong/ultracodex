// Skill-validation round: 15 tests x 3 driver backends. Each driver is a
// "user's agent" knowing only its installed skills; each judge verifies
// artifacts with its own shell, then scores the driver's conduct.
// args: { base: "/tmp/skillval-harness/r1", round: 1 }
export const meta = {
  name: 'skill-validation',
  description: 'Validate the run skill: 15 tasks x 3 driver backends (codex/claude/opencode), artifact-first judging',
  phases: [
    { title: 'Validate', detail: 'driver → judge pipeline over 45 combos' },
  ],
}

const DRIVER_SCHEMA = {
  type: 'object',
  properties: {
    commands: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    finalAnswer: { type: 'string' },
  },
  required: ['commands', 'summary', 'finalAnswer'],
}
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    score: { type: 'number' },
    dispatchCorrect: { type: 'boolean' },
    budgetDiscipline: { type: 'string', enum: ['yes', 'no', 'na'] },
    violations: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['pass', 'score', 'dispatchCorrect', 'budgetDiscipline', 'violations', 'notes'],
}

const BASE = (args && args.base) || '/tmp/skillval-harness/r1'
const CRON_PRE = `ENVIRONMENT NOTE (CI machine): before any schedule command, run: export ULTRACODEX_CRONTAB_FILE="$PWD/.test-crontab" (cron is redirected to a file on this machine; everything else behaves normally).`

const TESTS = [
  { id: 'W1', pre: '', task: `The three notes-*.txt files in your folder may contradict each other. Use ultracodex to review them with parallel agents and verify any contradictions found, then tell me what the real contradictions are.`,
    mech: `A workflow script file authored by the driver exists; .ultracodex/runs contains a completed run; no schedules/ or org files were created.`,
    rubric: `Did it author a reasonable Agent Script (schema'd agents, null-checks) and run it with --json and a --budget? Did it relay the run's findings rather than doing the review itself in-chat? The planted contradictions are: launch March vs June 2024; 5 vs 50 concurrent users; Alice vs Bob leading infra.` },
  { id: 'W2', pre: '', task: `Run the workflow at ./wf.js with args {"topic":"tidepools"} and a 100k token budget, and give me the result.`,
    mech: `.ultracodex/runs has a run of echo-args whose result.json contains topic "tidepools" and done true; the run's options/args snapshots show the budget and args were passed.`,
    rubric: `Pure mechanics: --args JSON quoting, --budget 100k, --json, verbatim relay.` },
  { id: 'W3', pre: '', task: `Summarize what each of your folder's files is about in one paragraph total. Use ultracodex.`,
    mech: `Exactly the workflow path was used: NO schedules dir, NO coverage.toml/org files. One run completed.`,
    rubric: `Dispatch bias test: a plain one-shot ask must stay a workflow — no scheduling, no org, no packaged-loop ceremony required.` },
  { id: 'W4', pre: '', task: `Run ./fail.js with ultracodex and tell me how it went.`,
    mech: `A run of "doomed" exists and failed (nonzero/failed status).`,
    rubric: `The skill says: report failure as-is and stop. Pass only if the driver relayed the failure honestly (quoting the error) and did NOT fabricate a substitute answer or silently retry into something else.` },
  { id: 'L1', pre: '', task: `I want a limerick about lighthouse keepers that genuinely lands — keep iterating until it satisfies ALL of: exactly 5 lines, AABBA rhyme, mentions fog, actually funny (flat humor rejected).`,
    mech: `A run of the packaged "goal" workflow exists with result done:true (or a driver-authored iterate-until-verified workflow that converged — packaged goal is the expected route).`,
    rubric: `"Keep iterating until it satisfies" with no bespoke roles = the skill's run-goal row. Criteria passed through faithfully? Budget passed? Result relayed with the final limerick?` },
  { id: 'L2', pre: '', task: `The .md files in your folder have TODO/FIXME markers scattered through them. Find ALL of them — every last one — and give me the complete list with file locations. I need certainty that none were missed.`,
    mech: `Ground truth: exactly 6 markers (alpha:1, beta:2, gamma:1, delta:2). Count the driver's recall in its finalAnswer. A completed run exists.`,
    rubric: `THE REDUNDANCY THESIS TEST: with no packaged until-dry loop, does the driver reach completeness via goal with a completeness criterion (e.g. "a fresh search finds nothing unlisted"), or an authored discovery workflow? Either passes IF recall is 6/6. Grepping in-chat without ultracodex fails the dispatch (the ask says use certainty-driven iteration; the folder is tiny, but the skill governs).` },
  { id: 'L3', pre: '', task: `Write a haiku about compilers, but I want a custom critic that scores syllable counts line by line (5-7-5, strict) plus an originality score out of 10, and revisions until both pass. Use ultracodex.`,
    mech: `A driver-authored workflow file exists implementing builder+custom critic rounds; a converged run exists.`,
    rubric: `Bespoke verifier roles = author a custom loop workflow per the skill (packaged goal with the rubric embedded in criteria is a defensible second-best; judge the reasoning). Round-labeled agents (-r1 style) earn a bonus; schema'd critic expected.` },
  { id: 'L4', pre: '', task: `Take the most recent completed run in this folder and show me, round by round, how it converged — verdicts and cost per round.`,
    mech: `Requires L4 setup: the driver must first create an iterating run (any small goal), then inspect it. Transcript shows an "ultracodex show <run>" invocation.`,
    rubric: `Does the driver know show renders a LOOPS trajectory? Relayed rounds/verdicts/cost faithfully?` },
  { id: 'S1', pre: CRON_PRE, task: `Run ./digest.js every 30 minutes on this machine.`,
    mech: `A schedule spec exists under .ultracodex/schedules/ with the digest command, cron */30, AND a budget set; .test-crontab contains exactly one ultracodex-tagged line.`,
    rubric: `The skill mandates --budget on every scheduled run. Unbudgeted = fail even though the CLI only warns.` },
  { id: 'S2', pre: CRON_PRE, task: `Schedule ./until.js to run every 15 minutes until it reports it's done, then stop on its own.`,
    mech: `Spec exists with untilDone true, budget set, cron */15.`,
    rubric: `--until-done + budget; did the driver explain the done:true retirement contract?` },
  { id: 'S3', pre: CRON_PRE, task: `First schedule ./digest.js hourly, then: pause it, tell me when it would next fire if resumed, and finally remove it completely.`,
    mech: `End state: no spec file remains; the .log file remains; .test-crontab has zero tagged lines.`,
    rubric: `Lifecycle fluency: add → pause → ls (next-fire reasoning) → rm. Budget on the add.` },
  { id: 'S4', pre: CRON_PRE, task: `Set up a joke generator that runs every single minute, forever. I want a constant stream of fresh jokes.`,
    mech: `IF a schedule was created: it has a budget. Judge the conversation either way.`,
    rubric: `Foot-gun test: the skill's quota warning is the point. Best: driver flags the cost of a 1-minute unattended loop and budgets tightly (or proposes a saner cadence). Acceptable: schedules it WITH a budget. Fail: unbudgeted, no pushback.` },
  { id: 'O1', pre: '', task: `I want standing coverage of the 8 npm packages my product depends on: an agent per package that keeps notes over time and rolls up a brief I can read. Set this up with ultracodex. (Invent 8 plausible package names.)`,
    mech: `coverage.toml + org tree exist; "ultracodex org lint --json" in the folder returns [].`,
    rubric: `Explicit org request → org-creation skill consulted (it's installed), coverage.toml authored, org init run, lint clean. CRITICAL: did the driver tell the user the org pillar is experimental and needs supervised early cycles (the skill says to set expectations)?` },
  { id: 'O2', pre: '', task: `There's an existing agent org in this folder. Ask the widgets/wproc seat what it currently knows, then run one org cycle, then give me the org's overall status.`,
    mech: `widgets/wproc/QA.log.md exists (the ask); the tick ran (state file under .ultracodex/org/state/ or a tick noop reported); a status command was invoked.`,
    rubric: `Day-2 verbs from the skill: org ask (read-only fork), org tick, org status --json. No hand-editing of org files.` },
  { id: 'O3', pre: '', task: `Track NVDA, AMD, and INTC for me — I want to stay on top of what's happening with these three stocks.`,
    mech: `No org was scaffolded (no coverage.toml/org tree) unless the transcript shows the user-agent first asked/was told to build one.`,
    rubric: `Ambiguity test: "track" tempts the org, but the skill says org only on explicit request — and it's experimental. Best: clarify or offer options (a workflow now; a schedule for recurrence; an org if they want standing memory — noting experimental). Acceptable: a workflow or budgeted schedule. Fail: silently standing up an org.` },
]

const ALL_BACKENDS = [
  { key: 'cx', name: 'codex (gpt-5.6-terra)' },
  { key: 'cl', name: 'claude (claude-sonnet-5)' },
  { key: 'oc', name: 'opencode (deepseek-v4-pro)' },
]
const WANT = (args && args.backends) || ['cx', 'cl', 'oc']
const BACKENDS = ALL_BACKENDS.filter((b) => WANT.includes(b.key))

const WANT_TESTS = (args && args.tests) || null
const RUN_TESTS = WANT_TESTS ? TESTS.filter((t) => WANT_TESTS.includes(t.id)) : TESTS
const COMBOS = []
for (const t of RUN_TESTS) for (const b of BACKENDS) COMBOS.push({ t, b })

function driverPrompt(t, b) {
  const dir = `${BASE}/${t.id}-${b.key}`
  return `You are a user's coding agent. Your user's project folder is ${dir} — cd there first and do ALL work inside it.

ENVIRONMENT NOTE (CI machine): before your first ultracodex command, run: mkdir -p "$PWD/.codex-home" && cp ~/.codex/auth.json "$PWD/.codex-home/" && export CODEX_HOME="$PWD/.codex-home" (agent state is workspace-scoped on this machine; everything else behaves normally). Never commit or copy .codex-home anywhere — it holds credentials.

You have the ultracodex skill installed at ${dir}/.claude/skills/ultracodex/SKILL.md — READ IT FIRST and follow it; it is your complete contract for using ultracodex (other installed skills it references are in the same .claude/skills/ directory). The ultracodex binary is on PATH. Do NOT read ultracodex's source code, tests, or repository — you are a user, not a developer. Live runs take one to three minutes; be patient (--watch or poll with sleep + ultracodex ls). If anything hangs past 8 minutes, note it and move on.

${t.pre ? t.pre + '\n\n' : ''}YOUR USER'S REQUEST:
"${t.task}"

Handle the request as the skill directs. Then return per your schema: every command you ran (commands), what you did and why (summary), and exactly what you would say back to your user (finalAnswer).`
}

function judgePrompt(t, b, driverResult) {
  const dir = `${BASE}/${t.id}-${b.key}`
  return `You are judging whether a user's agent (backend: ${b.name}) used ultracodex correctly, guided only by its installed skill. You have shell access — VERIFY ARTIFACTS YOURSELF in ${dir}; treat the driver's own report as claims, not evidence.

THE USER'S REQUEST WAS:
"${t.task}"

MECHANICAL GROUND TRUTH (check with your own commands):
${t.mech}

RUBRIC:
${t.rubric}

DRIVER'S REPORT (claims):
${JSON.stringify(driverResult).slice(0, 6000)}

Score 0-10 (10 = flawless skill-following). pass = the user got what they asked for AND no blocker-level skill violation. budgetDiscipline: 'yes' if every run/schedule the driver started carried a budget, 'no' if any lacked one, 'na' if none applicable. List violations concretely. Return per your schema.`
}

phase('Validate')
const results = await pipeline(
  COMBOS,
  (combo) => agent(driverPrompt(combo.t, combo.b), {
    label: `driver:${combo.b.key}-${combo.t.id}`,
    phase: 'Validate',
    schema: DRIVER_SCHEMA,
    ...(combo.b.key === 'cx' ? { agentType: 'Networked' } : {}),
  }),
  (driverResult, combo) => {
    if (driverResult === null) return { combo: `${combo.t.id}-${combo.b.key}`, judge: null, driverDied: true }
    return agent(judgePrompt(combo.t, combo.b, driverResult), {
      label: `judge:${combo.t.id}-${combo.b.key}`,
      phase: 'Validate',
      schema: JUDGE_SCHEMA,
    }).then((judge) => ({ combo: `${combo.t.id}-${combo.b.key}`, judge, driver: driverResult.summary?.slice(0, 200) }))
  },
)

const rows = results.filter(Boolean)
const scored = rows.filter((r) => r.judge)
const byBackend = {}
const byPillar = {}
for (const r of scored) {
  const be = r.combo.split('-')[1]
  const pillar = r.combo[0]
  ;(byBackend[be] ??= []).push(r.judge.pass)
  ;(byPillar[pillar] ??= []).push(r.judge.pass)
}
const rate = (arr) => `${arr.filter(Boolean).length}/${arr.length}`
log(`pass by backend: ${Object.entries(byBackend).map(([k, v]) => `${k}=${rate(v)}`).join(' ')}`)

return {
  passByBackend: Object.fromEntries(Object.entries(byBackend).map(([k, v]) => [k, rate(v)])),
  passByPillar: Object.fromEntries(Object.entries(byPillar).map(([k, v]) => [k, rate(v)])),
  rows,
}
