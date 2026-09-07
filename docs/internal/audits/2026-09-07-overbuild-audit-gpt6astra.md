1. **OVERBUILT: yes, primarily org.**

Physical line counts include comments and blank lines; denominator is all 67 TypeScript/TSX files under `src/`.

| Surface | Dedicated source | Lines | Share |
|---|---|---:|---:|
| Org | `src/org/*` (4,458); `src/tui/org.ts` (1,012), `orgFiles.ts` (319), `OrgView.tsx` (372) | 6,161 | 32.5% |
| Loop | `src/tui/loops.ts` (469), `LoopView.tsx` (259), `loopFiles.ts` (31) | 759 | 4.0% |
| Schedule | `src/schedule/*` (1,141); `src/tui/schedules.ts` (268), `scheduleActions.ts` (202), `ScheduleDetail.tsx` (279) | 1,890 | 10.0% |
| Combined | Excludes feature wiring inside shared files | 8,810 | 46.5% |
| Entire source | `src/**/*.ts`, `src/**/*.tsx` | 18,930 | 100% |

The current tree does **not** substantiate 45% for org alone. Its additional wiring occupies portions of `src/cli.ts` (1,615 lines), `HomeView.tsx` (1,100), `onboarding.tsx`, and `skills.ts`.

Specific cut/freeze candidates:

- **Org’s second orchestration system:** four trigger classes, depth-ordered bounded wake batches, repeated trigger evaluation, ticket expiry, post-tick lint/repair, optional Git commits. `src/org/scheduler.ts:69,93,153,377`; 787 lines. Workflow execution needs none of these.
- **Durable organizational protocol:** hierarchical message authorization, rejection feedback, ticket lifecycle, memory/frontmatter contracts, coverage parser/scaffolding. `router.ts` 475 lines; `tickets.ts` 467; `lint.ts` 502; `scaffold.ts` 395.
- **Org quality-management subsystem:** claim sampling/audit feedback and historical replay with drop/duplicate/delay injection and pristine resets. `audit.ts` 276 lines; `replay.ts` 551; packaged audit/repair workflows another 329 lines.
- **Org dashboard:** tree, operations, briefs, unread tracking, audit trends, severity/freshness calculations: 1,703 dedicated TUI lines.
- **Loop as an independent product pillar:** journal-derived loop identities, verdict inference, trajectory displays and separate navigation. Iteration already executes through ordinary JavaScript; `workflows/goal.js` is a self-contained 171-line workflow.
- **Schedule expansion:** freeze additional scheduling platforms and general command-management growth. Current scope already includes arbitrary commands, crontab ownership, captured execution environment, overlap locks, stale-lock recovery, retirement and history. `src/schedule/exec.ts` alone is 487 lines.

2. **ENTANGLEMENT: execution boundaries are clean; product integration is concentrated and unconditional.**

| Seam | Exact coupling | Removal/extraction implication |
|---|---|---|
| Core execution | `runner.ts`, `runtime.ts`, `loader.ts`, `executor/*`, `appserver/*`, `journal.ts`, `control.ts`, and `rundir.ts` have no imports into org/loop/schedule modules. | None of the three pillars is required to execute a workflow. Keep budgets, semaphore, schemas, journal/control, routing and worktree support. |
| Org CLI | `src/cli.ts:70–78` imports ask, audit, lint, router, replay, scheduler, scaffold, tickets and wake. Org handlers/options occupy approximately lines 515–716; registration is 1487–1570. | Explicit, localized removal. Imports are eager even for workflow CLI commands. |
| Org → workflow execution | `src/org/wake.ts:134` generates a script and invokes `run … --json` in the agent directory; `ask.ts:126` does likewise. `audit.ts:89` invokes packaged `org-audit.js`; `scheduler.ts:579` invokes `run org-lint-repair`. | Org consumes the CLI contract. Extraction must replace relative `../cli.js`/package asset lookup with an explicit runner executable. `ULTRACODEX_BIN` already provides an override. |
| Org shared helpers | `org/audit.ts:6–8` imports `WORKFLOWS_DIR_NAME`, `stateDir`, `packageRootDir`. Wake reads workflow journals to recover thread IDs (`wake.ts:262`). | Small outgoing dependencies. Preserve generic helpers and journal/thread contracts; move org consumers/assets. |
| Org TUI | `HomeView.tsx:20–21` imports `OrgView` and `orgFiles`; state/loading at 231–292; render at 635–636. `orgFiles.ts:3–4` imports org state and coverage parsing. | Remove registration, detection, snapshot state and onboarding together. |
| Always-visible tabs | `HomeView.tsx:726–736` renders/cycles Runs, Loops, Schedules, Org unconditionally. `orgEnabled` controls content, not tab existence. | “Experimental” is a label, not an isolation boundary. |
| Org ↔ schedule | **No source imports between `src/org/` and `src/schedule/`.** `docs/org.md` schedules `ultracodex org tick` as an ordinary external command. | Org’s trigger scheduler and cron scheduler are separate systems. Removing org does not require removing `schedule/`. |
| Org → loop helper | `src/tui/org.ts:2` imports `valueSparkline` from `loops.ts`; used by `auditSparkline` at 487. | Move this generic formatter if loop code is removed while org remains. |
| Packaging/skills | `src/skills.ts:44,56` always installs `org-creation`; `package.json` ships org docs/templates/workflows. `HomeView.tsx:117,209` discovers packaged workflows, then excludes builtins from Runs and places `goal` on Loops. | Remove org skill registration and assets together; retain `packageRootDir`, which the runner uses. Missing registered org skill currently breaks `sync-skills`. |
| Loop observers | `HomeView.tsx:17–19,175,247`; `RunView.tsx:27–29,83–89,208,233`; `static.ts:11,116`; `cli.ts:43,827–829`. | Remove inference/views from both interactive and static inspection. No runner changes or persisted loop-state migration. `loopFiles.ts` also imports its size limit from `loops.ts`. |
| Schedule services | `schedule/add.ts:4–6` uses workflow resolution, budget parsing and `CliError`; `spec.ts:3–5` uses `stateDir`/time; `exec.ts:5` uses PID liveness. Scheduled workflows invoke CLI `run --json`. | Outgoing dependencies on core utilities; no executor coupling. |
| Schedule product hooks | CLI imports at 47–69; handlers around 414–512; registration 1448–1485. Ordinary `run`/`ls` call overdue checks at 310/734. Doctor checks scheduling at 1277–1334. Home imports schedule services/views, has forms/actions and eager warning checks. | More cross-cutting than org at the everyday-command level. |
| Schedule persistence | `ScheduleSpec` stores `projectDir`, `env.PATH`, `nodeBin`, `cliPath` (`spec.ts:13–36`); crontab rendering uses these (`crontab.ts:75`). | Extraction/command relocation requires migrating owned cron entries and specs. Simply deleting the command leaves scheduled callbacks broken. |

**Assessment:** org is cleanly removable with coordinated CLI/TUI/package edits; it has not become load-bearing in workflow execution. Loop is an observation layer. Schedule is also removable from execution, but carries external operational state requiring migration.

3. **CONCEPT COST**

None adds `[org]`, `[loop]` or `[schedule]` keys to `.ultracodex/config.toml`. The shared config remains routing, backends, concurrency and profiles (`src/config.ts:200–262`; `src/types.ts:329`). Their additional configuration lives elsewhere.

| Pillar | Added states/configuration | Added commands and surfaces |
|---|---|---|
| Org | Roles `root/group/entity`; four severities; four confidence values; `QUERY/NOTIFY/REQUEST/REPLY`; tickets `open/done/declined/expired`; four trigger classes; wake cycles, audit verdicts and unread briefs. `coverage.toml`: `[groups.<name>]`, `title`, `entities` (`scaffold.ts:245`). Memory metadata: `updated/sources/confidence/next_review`. `ORG_WAKE_CAP` defaults to 8 (`wake.ts:296,330`). Persistent inboxes, tickets, ingest ledger/cache, `.thread`, last-wake, audit-history and briefs-read files. | **10 subcommands:** `init`, `tick`, `wake`, `send`, `ask`, `tickets`, `lint`, `status`, `replay`, `audit`. Flags introduce root/date/reason, concurrency, repair/commit, message refs/deadlines, ticket filters, sample size and replay faults/pristine resets (`cli.ts:1487`). Always-visible Org tab, create onboarding, tree/ops/briefs navigation; viewing briefs writes read stamps (`OrgView.tsx:63`; `orgFiles.ts:83`). |
| Loop | Inferred `running/converged/ended`; round verdicts `approved/rejected/unknown`; round-label and phase regex conventions; boolean/verdict-field synonyms (`loops.ts:4–37`). `goal` args: `task`, `criteria`, `maxRounds`, `context`, `builderModel`, `verifierModel`, `budgetFloor`; returned verdict also includes `exhausted`. No independent durable loop store. | **No loop subcommand.** `run goal`, separate Loops launcher/list/detail, run-view `L`, static `show` LOOPS block. “Loop” is another presentation/classification of existing runs. |
| Schedule | `active/paused/retired`; retirement `done/max-runs`; `every/daily/cron`; execution/running/overdue outcomes. Spec adds cadence, command, budget, lifetime limits, execution counts, last result and captured paths/environment. `.json`, `.log`, `.lock` and stale-lock claim files; `ULTRACODEX_CRONTAB_FILE` override. | **Five visible subcommands:** `add`, `ls`, `pause`, `resume`, `rm`; hidden `exec`. Schedules tab/detail/history/countdown, exec-now/pause/remove controls, seven-field scheduling form and Runs-tab `S` shortcut (`tui/schedules.ts:14`; `HomeView.tsx:393`). |

Costs paid without adopting these features:

- **Navigation and discovery:** four equally available tabs and four-pillar README positioning; all static skills installed. Org snapshots load only on its active tab, but org detection runs during normal Home refreshes.
- **Background reads:** Home polls every two seconds and eagerly examines up to 60 runs for loops, with mtime caching (`HomeView.tsx:54–60,215,246–250`). Schedule counts and overdue warnings also refresh outside the Schedules tab (`253–266`).
- **CLI diagnostics:** normal non-JSON `run` and `ls` check schedule state. Doctor probes crontab even when no schedules exist; these scheduling reports do not themselves set `hardFail`.
- **Documentation maintenance:** `docs/org.md` 245 lines, `loops.md` 111, `schedule.md` 185—541 dedicated public-document lines, plus README/skills/operations cross-references.
- **Existing drift:** README line 42 advertises packaged `goal` and `loop`; only `goal.js` and two org workflows exist. `docs/README.md:10` still advertises until-dry loops; `docs/loops.md:100,106` references `loop.verify` and “both packaged loops.” Its line 28 says budgets are mandatory, while `schedule/add.ts:130` merely warns when omitted.

4. **TOP THREE MOVES, RANKED**

Sizes below are rough source scope, including shared wiring; not additive precision estimates.

| Rank | Concrete move | Rough size | Risk |
|---|---|---|---|
| **1** | **Archive/extract org from the default package.** Remove its CLI family, Home tab/onboarding, automatic skill installation and bundled assets. Keep an experimental companion using `run --json`. Freeze residency, per-role policy and live TUI triggers proposed in `docs/internal/v0.6-backlog.md:48–60,99`. | Approximately **6.5–6.8k source lines**, plus approximately **1.2k lines** of shipped workflows/templates/skill/docs. | **Low workflow risk; moderate packaging/migration risk.** Preserve existing org directories. Explicitly resolve companion assets and runner executable; update any scheduled org command paths. |
| **2** | **Make loops ordinary workflows throughout the product.** Keep `goal.js`, JavaScript iteration, budgets and existing run inspection. Remove separate Loops navigation/detail and heuristic convergence inference from Home/Run/static output. Put `goal` in the normal workflow launcher and reconcile its documentation. | Approximately **0.9–1.1k source lines** removed. | **Low execution risk; moderate display compatibility risk.** Round trajectories disappear, but scripts, journal data and results remain valid. Move `valueSparkline` if org survives independently. |
| **3** | **Freeze schedule as an advanced CLI utility.** Remove the dedicated scheduling TUI/form; confine overdue checks to schedule commands and doctor checks to configured schedules. Preserve current cron execution, budgets, locking and retirement. Defer launchd/systemd expansion (`v0.6-backlog.md:84`). | Approximately **1.0–1.2k source lines** removed; retain the **1,141-line** scheduler implementation and CLI management. | **Low runner risk; moderate UX risk.** Existing schedules keep firing and remain manageable. Retaining command paths avoids a cron migration. |