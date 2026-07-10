// New-user simulation: two sol agents approach Loops and the Scheduler cold,
// armed only with what a real user has — the installed binary, the README,
// and the docs. They test logic AND the TUI (via tmux) and file friction
// reports. No gates: these agents ARE the gate.
export const meta = {
  name: 'user-sim-loops-sched',
  description: 'Fresh-eyes user simulation of the Loops and Scheduler pillars — logic + TUI, docs-only knowledge, friction reports',
  phases: [
    { title: 'Simulate', detail: 'two parallel new-user sessions: loops, scheduler' },
  ],
}

const REPORT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['ship', 'fix-first'] },
    worked: { type: 'array', items: { type: 'string' } },
    friction: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          area: { type: 'string', enum: ['logic', 'tui', 'docs'] },
          what: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'area', 'what', 'evidence'],
      },
    },
    tuiEvidence: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['verdict', 'worked', 'friction', 'tuiEvidence', 'notes'],
}

const PERSONA = `YOU ARE A NEW USER of ultracodex, not its developer. You just installed it (the \`ultracodex\` binary on PATH is your install). Your ONLY sources of knowledge are: README.md, the docs/ pages it links, and the product itself (--help, the TUI, error messages). You are FORBIDDEN from reading src/, tests/, fleet/, or any *.ts file — a user cannot see those. Judge everything by what a stranger would experience: if you needed knowledge the docs did not give you, that is friction to report, even if you eventually figured it out.

TUI DRIVING: use tmux (installed). Pattern:
  tmux new-session -d -s <name> -x 200 -y 50 'ultracodex'
  sleep 3 && tmux capture-pane -pt <name>        # read the screen
  tmux send-keys -t <name> <key> && sleep 2 && tmux capture-pane -pt <name>
Keys: Tab for tab, Up/Down, Enter, and plain letters ('L','e','p','x','S','q', Escape). ALWAYS capture-pane after each action and read it — the captures are your evidence (put the most telling excerpts, trimmed, in tuiEvidence). Kill your session when done: tmux kill-session -t <name>.

RULES: work in a scratch dir under /tmp (mkdir yourself); pass --budget on every run you start (the docs say to); be patient — live runs take 1-3 minutes (poll with sleep + ultracodex ls, or --watch); if something hangs >6 minutes, note it and move on. Report honestly: verdict "fix-first" ONLY for real blockers/majors a new user would hit. Your final text is parsed by schema, not read by a human.`

phase('Simulate')
const [loops, sched] = await parallel([
  () => agent(`${PERSONA}

YOUR SESSION — you heard ultracodex has "loops" and you want to try them.
1. Read README.md (repo root = your cwd) — just the parts a user skims: the top, the Loops section. Then docs/loops.md fully.
2. In a scratch dir: run the packaged goal loop on a small creative task with strict criteria (follow the docs' arg shapes; --budget 200k). Did it converge? Does the result JSON match what docs promised (done/rounds/verdict/history)?
3. Run the packaged until-dry loop with a small find task over your scratch dir's own files (create 2-3 text files with planted issues first, e.g. TODO markers or contradictions; find: "find planted TODO markers and contradictions in *.txt"; --budget 200k). Does it dedup and go dry as documented?
4. Inspect: ultracodex show <runId> on both — is the LOOPS section there and readable? ultracodex ls.
5. TUI via tmux FROM THE REPO ROOT (it has run history): the Loops tab (Tab key from home) — do rows make sense? Enter a loop — is the trajectory dashboard understandable to someone who has never seen it (hero chips, ledger, Up/Down round selection, Enter for agent detail, Escape back)? From the Runs tab, open a run and try the L key. Capture panes throughout.
6. Re-read docs/loops.md once more: list every claim you could NOT verify or that mismatched reality.
Return per schema.`, { label: 'usersim:loops', phase: 'Simulate', agentType: 'Networked', schema: REPORT, effort: 'xhigh' }),

  () => agent(`${PERSONA}

YOUR SESSION — you want recurring agent runs and heard ultracodex has a scheduler.
1. Read README.md's Scheduler section, then docs/schedule.md fully.
2. SAFE SANDBOX FIRST, exactly as the docs describe (ULTRACODEX_CRONTAB_FILE): in a scratch dir, do the full lifecycle — add an --every schedule wrapping a tiny run with --budget; cat the crontab file (is the line comprehensible?); add one WITHOUT --budget (what happens? is the warning clear?); ls; pause; resume; rm; confirm the file is clean. Also: add with --until-done --max-runs 2 wrapping a run whose workflow returns done (the packaged goal does) — trigger it via the TUI's exec-now later and check retirement.
3. Seed a foreign line in the crontab file first (echo a fake cron entry) and verify the tool never touches it through the whole lifecycle.
4. TUI via tmux from your scratch dir (so the Schedules tab shows YOUR schedules): Tab to Schedules — countdown sensible? Press Enter (detail), p twice (pause/resume glyphs), e (exec-now — then wait and check the Runs tab for the spawned run and the history strip), x (remove — is the confirm clear?), and from the Runs tab try S on a workflow (the schedule form: fill it, submit, does it land on the Schedules tab?). Capture panes throughout.
5. ultracodex doctor — is the schedules section meaningful to a user?
6. Re-read docs/schedule.md: list every claim you could NOT verify or that mismatched reality. Do NOT touch the real crontab (never unset ULTRACODEX_CRONTAB_FILE).
Return per schema.`, { label: 'usersim:sched', phase: 'Simulate', agentType: 'Networked', schema: REPORT, effort: 'xhigh' }),
])

return {
  loops: loops ?? { verdict: 'fix-first', notes: 'agent died', friction: [], worked: [], tuiEvidence: [] },
  sched: sched ?? { verdict: 'fix-first', notes: 'agent died', friction: [], worked: [], tuiEvidence: [] },
}
