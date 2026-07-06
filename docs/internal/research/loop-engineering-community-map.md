# Community Map of Loop Engineering

## Consensus Definition

The community model treats a loop as a recurring control system around agent runs. It is not just a prompt and not just cron. A real loop repeatedly discovers or selects work, delegates a bounded task, acts in a workspace or sandbox, verifies the result, persists state outside the model context, decides whether to continue, and runs again on a trigger, cadence, event, or goal condition.

The core boundary is verification. The community literature repeatedly says a loop needs something that can honestly say no: deterministic checks where possible, independent agentic checks where necessary, and human gates for high-risk or ambiguous decisions. Maker self-grading is treated as unreliable.

Durable memory is also part of the definition. Because context windows fill up and sessions disappear, loop state should live outside the model in files, git, tickets, PRs, event logs, JSON, markdown, Linear, or another durable system. That memory must be read at the start of the next turn and governed over time.

## Layer Taxonomy

The community stack is:

| Layer | Control surface |
| --- | --- |
| Prompt engineering | What is said to the model. |
| Context engineering | What the model sees. |
| Harness engineering | Tools, permissions, tests, sandboxes, hooks, and observability for one run. |
| Loop engineering | Recurrence, verification, memory, stop conditions, and re-entry across runs. |

ultracodex mostly lives at the harness-to-loop boundary: it gives a scriptable runtime for repeated agent calls, but it does not by itself define every operational lifecycle stage the community includes under loop engineering.

## Lifecycle Taxonomy

The unified community lifecycle is:

1. Trigger
2. Discover
3. Delegate
4. Act
5. Verify
6. Persist
7. Decide

The orange-book formulation compresses this into discovery, handoff, verification, persistence, and scheduling. The same shape is still present: loops must decide what work exists, hand it to agents, check outcomes, write durable state, and choose whether and when to continue.

## Trigger Taxonomy

The community trigger model includes:

| Trigger | Meaning |
| --- | --- |
| Fixed cadence | `/loop`, cron, scheduled tasks, GitHub Actions schedules, Codex Automations, cloud routines. |
| Event-driven | CI failures, PR events, webhooks, issue changes, Slack mentions, Sentry or PagerDuty events, file changes. |
| Adaptive cadence | The loop chooses the next interval based on what it found. |
| Run-until-goal | The loop continues until a verifier accepts a done condition. |

The community is clear that a timer alone is only a heartbeat. It becomes loop engineering when paired with discovery, state, verification, stop logic, and brakes.

## Role Taxonomy

The common role split is maker/checker. Variants include generator/evaluator, planner/worker/judge, explorer/implementer/verifier, planner/implementor/reviewer/judge, and many-readers-one-writer.

The main disagreement is how many roles are worth paying for. Some sources favor heterogeneous reviewers because different tools catch different failures. Others emphasize serializing writes and limiting fleets to human review bandwidth.

## Loop Type Taxonomy

| Type | Meaning |
| --- | --- |
| Agent loop | A model repeatedly calls tools until a task condition, limit, or human gate stops it. |
| Verification loop | A candidate is checked, rejected with evidence, retried, and stopped on pass, budget, stall, or escalation. |
| Cadence loop | A prompt or task recurs on a schedule; by itself this is close to cron. |
| Goal loop | The system iterates until a stated done condition is verified. |
| Event-driven loop | External events trigger agent runs that update repos, tickets, PRs, docs, or alerts. |
| Ralph loop | A shell repeatedly starts a fresh agent process while files carry state. |
| Hill-climbing loop | Production traces or previous trajectories improve prompts, tools, harnesses, scorers, or evals. |
| Operational repair loop | CI repair, PR babysitting, dependency triage, docs drift repair, flaky-test hunting, incident response. |

## Mechanisms

The iterating unit may be a scheduled run, headless CLI invocation, fresh-context shell cycle, CI repair attempt, PR review cycle, sub-agent handoff, or goal-directed maker turn.

Preferred verification is deterministic: tests, lint, typecheck, builds, schemas, link checks, CI exit codes, audit results, static analysis, live system state, and command exit status. When deterministic checks cannot express the target, the community uses LLM judges with rubrics, evidence, structured PASS/FAIL or APPROVE/REJECT/ESCALATE outputs, read-only permissions, and preferably a different or stronger model. For high-risk work, verification becomes a human approval gate.

Standard stop conditions are goal met, budget spent, stalled, and needs human. Budgets include iterations, tokens, runtime, retries, and dollars. Stall means repeated failure without new evidence or progress. Needs-human means ambiguity, missing credentials, destructive actions, security or production impact, architecture judgment, regulated signoff, or unclear intent.

## Safety And Cost Practices

The community practices are conservative:

- Write the done condition first, preferably as a machine-checkable command or explicit rubric.
- Use gate-before-acting checks so the loop exits if the state is already green.
- Separate maker and checker; do not let the maker declare itself done.
- Prefer deterministic verification over LLM judgment.
- Add hard brakes before unattended execution: max turns, max iterations, token, runtime, dollar and retry caps, scoped paths, branch limits, sandbox permissions, circuit breakers, and watchdog writes.
- Use worktrees, branches, sandboxes, and disposable environments.
- Persist state every turn and read it at the start of the next turn.
- Govern durable memory: version it, prune it, and review standing rules.
- Scale parallel agents to review bandwidth, not compute availability.
- Keep changes small, reviewable, and attributable.
- Preserve human decision authority for high-risk or intent-heavy decisions.

## Community-Admitted Gaps

The community says the hardest unsolved part is verification, not recurrence. LLM-as-judge is useful but biased. Makers can cheat checks by weakening tests, deleting failures, hard-coding behavior, changing graders, or narrowing scope. A bad harness gets worse when looped.

The literature also admits tooling gaps: watchdogs, branch limits, cumulative dollar budgets, external cost metering, and circuit breakers often require wrapper code. Local loops fail when the machine or session disappears. Cloud loops may lose local state, start from fresh clones, impose minimum intervals, or lack local files. Worktrees solve file collision, not correctness or review bandwidth. Connectors are necessary for operational loops but increase blast radius. Persistent memory drifts. Tests do not prove unspecified behavior. Agents cannot resolve intent debt.

# Comparison With ultracodex

## ultracodex Loop Model

ultracodex defines loops as ordinary JavaScript convergence patterns inside Agent Script. There is no dedicated loop primitive, and conforming engines must not add one. The composition model is:

| Axis | ultracodex primitive |
| --- | --- |
| Breadth | `parallel(thunks)` |
| Flow | `pipeline(items, ...stages)` |
| Depth | JavaScript loops around `agent()` calls |

The canonical loop is builder-verifier: build a candidate, run an adversarial verifier with a structured `{ pass, issues }` schema, feed issues back, and repeat until pass, max rounds, or budget floor.

The host primitives in the requested docs are:

- `agent(prompt, opts?)`, returning final text, a schema-validated object, or `null`.
- `parallel(thunks)`, a barrier over concurrent thunks.
- `pipeline(items, ...stages)`, independent per-item stage chains.
- `phase(title)` for progress grouping.
- `log(message)` for progress narration.
- `args` for structured run input.
- `budget` for an output-token ceiling across agent calls.
- `workflow(nameOrRef, args?)` for one-level child workflows.

ultracodex also provides runtime guardrails and operational surfaces: a 1000-agent lifetime cap, 4096-item caps for `parallel` and `pipeline`, a semaphore for concurrency, output-token budget enforcement, schema validation and repair, label and phase based backend routing, optional `isolation: "worktree"`, detached runs, plain-file run directories, an append-only journal, TUI and CLI inspection, live pause/resume/skip/kill controls, and cross-vendor judging by routing verifier labels to a different backend.

## Where They Agree

Both models treat loops as more than one prompt. They are repeated agent runs with a control system around them.

Both models center verification. The community calls the decisive boundary the ability to say no; ultracodex's main example is explicitly builder-verifier, with an adversarial judge and structured pass/issues output.

Both models understand that self-review is weak. The community recommends independent checkers; ultracodex makes cross-vendor verification a first-class routing use case by letting `"verify:*"` labels go to a different backend without changing the script.

Both models use budgets and brakes. The community asks for token, runtime, retry, dollar, and iteration caps. ultracodex has a hard output-token budget, a 1000-agent lifetime cap, per-script round caps in the example, pause/resume/skip/stop controls, and null semantics after failed, skipped, or stopped agents.

Both models value durable artifacts. The community wants state outside the model context. ultracodex records every run as plain files under `.ultracodex/runs/<runId>/`, including journal, prompts, events, outputs, pidfile, and `result.json`.

Both models use isolation. The community recommends worktrees, branches, sandboxes, and disposable environments. ultracodex supports `isolation: "worktree"` per agent call and backend sandbox configuration.

Both models separate roles through execution policy. The community names planner, maker, checker, judge, explorer, implementer, and reviewer roles. ultracodex uses labels, phases, model and effort tiers, `agentType` profiles, and backend routing to express similar splits without baking role names into the language.

## Where The Community Model Is Richer

The community model is broader than ultracodex's current loop model. It describes a full socio-technical lifecycle: trigger, discover, delegate, act, verify, persist, decide. ultracodex gives a strong executable substrate for delegate/act/verify inside one run, but trigger, discovery policy, persistence policy, and decision policy are mostly authored by the script or supplied by external systems.

The community has a richer trigger taxonomy. It covers fixed cadence, event-driven triggers, adaptive cadence, and run-until-goal loops. ultracodex can run detached and can be driven by another agent or scheduler, but the requested docs do not define native cron, webhook, CI, issue, Slack, Sentry, PagerDuty, file-watch, or adaptive rescheduling primitives.

The community is more explicit about deterministic verification. It prefers tests, lint, typecheck, build commands, schemas, CI status, static analysis, and command exit codes before LLM judgment. ultracodex has schema enforcement and adversarial LLM verification, and agents can run tools in their workspaces, but Agent Script does not expose a first-class deterministic `check(command)` primitive or gate-first verification API.

The community has a stronger human-gate model. It treats production changes, destructive actions, security, regulated signoff, architecture calls, credentials, and unclear intent as escalation points. ultracodex has live user controls and can stop or skip agents, but the loop language does not define approval gates, risk classes, or human signoff protocols.

The community has a more developed memory model. It says durable state is part of the loop definition and must be versioned, pruned, reviewed, and treated as a proposal when written by agents. ultracodex has durable run journals, but not a standing loop memory system with schemas, retention, pruning, review, and rehydration semantics.

The community has a richer stop-condition vocabulary. It distinguishes goal met, budget spent, stalled, and needs human. ultracodex has hard budget and lifetime caps plus script-authored loop exits, but it does not natively detect repeated identical failures, lack of progress, checker disagreement, or escalation conditions.

The community is more explicit about anti-cheat behavior. It warns that makers may weaken tests, delete failures, skip checks, hard-code outputs, or change graders. ultracodex can route verifiers independently and isolate worktrees, but it does not yet provide protected grader files, immutable check definitions, or anti-cheat diff review as built-in loop affordances.

The community covers operational loops beyond artifact convergence: CI repair, PR babysitting, dependency triage, docs drift, flaky-test hunting, incident response, and hill-climbing eval loops. ultracodex can express many of these as scripts, but the docs only make builder-verifier, until-dry, until-count, and budget-scaled fleets canonical.

The community is more explicit about review bandwidth and comprehension debt. ultracodex makes parallelism and fleets easy, but the community adds the management rule that parallelism should be capped by human review capacity and that passing code is not enough if humans no longer understand it.

## Where ultracodex Is Richer

ultracodex is more executable and precise than the community taxonomy. The community describes patterns across tools; ultracodex defines a concrete portable language and runtime contract.

ultracodex's "no dedicated loop primitive" stance is a real design advantage. Loops are normal JavaScript, so scripts can express convergence, dry spells, counters, budget-scaled fanout, retries, and custom stop logic without waiting for a product-specific `/loop` or `/goal` feature. The same script can run under compatible engines.

ultracodex has unusually crisp failure semantics. `agent()` returns `null` for terminal failure, skip, or schema repair exhaustion and only throws for budget exhaustion, lifetime cap, and fan-out cap. `parallel()` and `pipeline()` are also null-tolerant. This makes robust loop code easier to write because failures are values except for hard stop conditions.

ultracodex has shared budget semantics across nested workflows. A child workflow shares the parent run's agent ordinal counter, semaphore, budget, and journal. That is cleaner than ad hoc wrapper accounting for many local loop scripts.

ultracodex has strong structured-output enforcement. Schemas are passed to backends where supported, then enforced engine-side with validation and repair turns. The community asks for structured PASS/FAIL outputs; ultracodex gives that a concrete implementation path.

ultracodex has a strong inspection model. Every run is a detached process backed by a plain-file journal, and the TUI, CLI, and JSON output are folds over that journal. This directly supports debugging, audit, replay-like inspection, and machine consumption.

ultracodex has portable cross-vendor routing. Community sources recommend different or stronger models for judging; ultracodex lets labels such as `verify:*` route to another backend by config with no script change.

ultracodex has concise composition primitives. `parallel()` for breadth, `pipeline()` for flow, loops for depth, and `workflow()` for one-level reuse form a small surface that can express many community loop patterns.

## Main Divergences

| Topic | Community model | ultracodex model |
| --- | --- | --- |
| Definition | A loop is a recurring control system spanning trigger, discovery, delegation, action, verification, persistence, and decision. | A loop is an ordinary JavaScript convergence pattern over Agent Script primitives inside a run. |
| Triggering | Native concern: cadence, event, adaptive cadence, and run-until-goal. | External concern: `run` can be detached or driven by another agent, but scheduling and events are outside the loop spec. |
| Verification | Deterministic checks first, independent LLM judges second, humans for high-risk cases. | Canonical builder-verifier uses LLM verifier with schema; deterministic checks are not a first-class host primitive. |
| State | Durable loop memory is definitional and must be governed. | Runs are durable and inspectable, but standing loop memory is script or workspace responsibility. |
| Stop conditions | Goal met, budget spent, stalled, needs human. | Budget, lifetime caps, explicit script breaks, max rounds in examples, and live pause/skip/stop. |
| Safety | Branch policies, anti-cheat rubrics, watchdogs, permission gates, dollar caps, approval gates. | Sandbox config, worktree isolation, token budget, caps, null handling, routing, and live controls. |
| Roles | Rich maker/checker/planner/worker/judge taxonomies with review-bandwidth cautions. | Labels, phases, agent profiles, advisory model tiers, and route config. |
| Operational scope | Includes CI repair, PR babysitting, dependency triage, docs drift, incidents, eval improvement. | General enough to express these, but docs emphasize convergence workflows and builder-verifier loops. |
| Product posture | Pattern language spanning many tools and deployment substrates. | Concrete runtime and CLI for portable Agent Script execution. |

# Tooling Gaps ultracodex Could Fill

## Highest-Leverage Gaps

1. Add a deterministic `check()` primitive.

   The community wants gate-first verification. ultracodex could expose a host primitive that runs a command or named check under controlled permissions, captures exit code, stdout, stderr, artifacts, runtime, and a stable check ID, then returns structured evidence. This would make "tests before agent calls" and "verifier can honestly say no" native rather than prompt-mediated.

2. Add a loop policy block or helper library.

   Scripts currently hand-roll max rounds, budget floors, and break conditions. A small policy helper could standardize max iterations, runtime ceilings, token floors, retry caps, stall detection, repeated-failure detection, and escalation reasons while keeping loops ordinary JavaScript.

3. Add first-class verifier profiles.

   ultracodex already supports label routing and `agentType`. It could ship a verifier profile convention: read-only workspace, separate backend default, required schema, evidence field, default-reject behavior, no write tools, and protected access to check artifacts.

4. Add human approval gates.

   A host primitive such as `approval(request)` or a CLI/TUI gate could pause the run, show evidence, and resume with approve/reject/escalate. This would cover the community's high-risk categories without turning every loop into unattended autonomy.

5. Add standing loop state.

   `.ultracodex/runs` solves run auditability. A separate `.ultracodex/state` API could solve durable memory: schema validation, versioning, run-to-run rehydration, pruning, review status, and "agent-written proposal" markings.

6. Add scheduler and event adapters.

   Keep the Agent Script language portable, but ship wrappers for cron, GitHub Actions, CI failure, PR events, issue changes, file watch, webhook, and adaptive next-run scheduling. The trigger should be outside the script but standardized around the same journal and result schema.

7. Add anti-cheat protections.

   For repair loops, ultracodex could pin protected files or check definitions, diff the grader, flag test weakening, detect skipped checks, and require checker approval when files under test infrastructure change.

8. Add dollar and wall-clock accounting.

   `budget` currently measures output tokens. The community also wants cumulative dollars, runtime, retry count, and model-specific spend. ultracodex could add ledgers and hard caps without changing the core loop syntax.

9. Add packaged operational loop workflows.

   Ship maintained templates for CI repair, PR babysitting, docs drift, flaky-test hunt, dependency triage, link checking, eval regression, and release-note verification. These are the community's concrete use cases and would show how the primitives compose beyond builder-verifier.

10. Add convergence and stall dashboards.

   The TUI already has a journal. It could visualize rounds, verifier issues, repeated failures, budget burn, check history, changed files, and reasons for stopping. That would turn loop debugging from log reading into loop inspection.

## Bottom Line

The community model is richer as a theory of real-world loop engineering. It covers triggers, discovery, durable memory, deterministic verification, human gates, anti-cheat rules, cost control, operational integrations, and review bandwidth. ultracodex does not yet cover all of that natively.

ultracodex is stronger as an executable substrate. It gives a small portable language, precise failure semantics, schema enforcement, shared budgets, cross-vendor routing, detached durable runs, worktree isolation, and live controls. The most useful next step is not to add a special loop syntax. It is to add the missing operational affordances around ordinary JavaScript loops: deterministic checks, loop policies, durable state, approvals, triggers, anti-cheat protections, and cost/watchdog accounting.
