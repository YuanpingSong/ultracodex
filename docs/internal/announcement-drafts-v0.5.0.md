# v0.5.0 announcement drafts — X · Reddit · HN (window: 7/9 night → 7/10 morning)

Post order suggestion: HN first (slowest burn, best feedback), X thread
minutes later, Reddit after the HN comments show which questions recur.
All three assume `git push` + `pnpm release minor` are done and npm shows
0.5.0.

---

## Show HN

**Title:**

> Show HN: Ultracodex – run Claude Code agent fleets on your Codex subscription

**Text (the maker's first comment):**

I kept hitting Claude rate limits while its agent workflows sat next to an
OpenAI subscription I wasn't using. So I built a runtime that runs Claude
Code workflow scripts, unmodified, on the Codex CLI (and on OpenCode — any
provider it speaks, local models included). Your Claude session writes the
script and reads the verified result; the fleet's heavy lifting lands on
the other meter.

The scripts are plain JavaScript where `await agent(prompt, { schema })`
is a function call with a typed, validated return. Once the agent is a
unit like that, there turned out to be three ways to scale it, and v0.5.0
ships all three: workflows (one script fans out a fleet), loops (builder
rounds gated by a skeptical verifier until the work holds — plus a cron
scheduler that owns its crontab lines, no daemon), and orgs (a directory
tree of agents with durable memory: one analyst per subject, briefs
rolling up the tree, woken by triggers).

Numbers, because claims are cheap: the same build script, configs one
`[route]` line apart, shipped the same 12/12-test module on four models —
gpt-5.6-sol in 107s with zero Claude quota; Claude Opus 4.8 in 219s,
Sonnet in 237s, and a deliberately-overkill frontier run in 246s, all on
the Claude meter. Raw journals are committed in the repo. The project
also builds itself: v0.5.0 was built by 14 ultracodex fleet runs (72
agents, 1.26M output tokens, all on Codex), with a per-run ledger
committed.

Honest trade-offs: each agent boots its own Codex app-server, so per-agent
latency is higher than upstream subagents — the point is whose meter
runs, not speed. Pre-1.0; the app-server protocol is experimental and
version-pinned (`doctor` reports drift). The org pillar ships explicitly
experimental — the runtime is tested end to end and its acceptance test
was an org watching this repo's own dependency tree (that org's briefs
are in the repo history), but the discipline is young and I expect it to
evolve with feedback.

https://github.com/YuanpingSong/ultracodex · npm: `ultracodex`

---

## X thread

**1/**
Claude Code taught us to program with agents. ultracodex makes the agent a
real unit of programming — and runs your Claude Code workflow scripts,
unmodified, on the Codex subscription you aren't rationing.

v0.5.0: Workflow 🌟 Loop 🌟 Scheduler 🌟 Org

**2/**
Same build script. Configs one [route] line apart. Same 12/12-test result
on every model tried:

gpt-5.6-sol — 107s, zero Claude quota
Opus 4.8 — 219s, Claude meter
Sonnet — 237s, Claude meter
frontier-overkill — 246s, priciest meter

Raw journals in the repo.

**3/**
Loops: `ultracodex run goal` — builder rounds against explicit criteria,
gated by a skeptical verifier. The TUI shows convergence as a trajectory:
✖ ✖ ✔ · converged after 3 rounds, cost per round trending down.

**4/**
Scheduler: `ultracodex schedule add nightly --daily 18:30 --budget 500k
-- run goal …` — one tagged crontab line it fully owns. No daemon.
--until-done retires the schedule the day the work reports done. Unbudgeted
scheduled runs warn loudly.

**5/**
Orgs: one analyst can't cover 500 stocks. A research desk can — one
analyst per name, each keeping notes, each writing a one-page brief their
lead actually reads. `ultracodex org init` builds that desk from agents.
Memory that compounds, audits that check citations, replay with fault
injection. Shipping it experimental — the newest pillar, feedback wanted.

**6/**
It builds itself: every feature in v0.5.0 was built by ultracodex fleets
running on ultracodex — 14 runs, 72 agents, 1.26M output tokens, all on
Codex, per-run ledger committed. The org runtime's acceptance test: an org
watching this repo's own dependency tree.

**7/**
Apache-2.0. Scripts stay byte-compatible with Claude Code's Workflow tool
— `validate --strict` checks the portable subset, so there's no lock-in
in either direction.

npm i -g ultracodex
https://github.com/YuanpingSong/ultracodex

---

## Reddit (r/ClaudeAI; trim the intro for r/ChatGPTCoding or r/LocalLLaMA)

**Title:**

> I built a runtime that runs Claude Code's agent workflows on your Codex subscription — v0.5.0 adds loops, a cron scheduler, and persistent agent orgs

**Body:**

Like a lot of people here I kept hitting weekly limits mid-fleet. Claude
Code's Workflow tool is the best agent-orchestration surface I've used —
so instead of rationing it, I built ultracodex: it runs the same workflow
scripts, byte-identical, on the OpenAI Codex CLI (or OpenCode → any
provider including local models). Claude authors the script and verifies
the result; execution lands on the other subscription.

**The 60-second version:**

    npm install -g ultracodex
    ultracodex doctor
    ultracodex sync-skills

then in Claude Code: *"Write a haiku that survives three rounds of
adversarial critique. Run it with ultracodex."* Claude writes the
workflow, Codex executes it, the verified result lands back in your
session.

**What's in v0.5.0** — the full set, one script format:

- **Workflows** — plain JS where `agent(prompt, {schema})` returns a
  validated object; `parallel`/`pipeline` compose fleets; a TUI watches
  live; runs are detached processes over plain files.
- **Loops** — `run goal`: builder rounds gated by a skeptical verifier
  until explicit criteria hold (completion criteria like "the backlog is
  empty" work too); the TUI folds rounds into a convergence trajectory
  with per-round cost.
- **Scheduler** — recurring runs via tagged crontab lines it fully owns
  (no daemon), `--until-done` retirement, loud warnings on unbudgeted
  scheduled runs so a 1-minute loop can't drain your quota overnight.
- **Orgs** — a directory tree of agents with durable memory: one seat per
  subject, inboxes and tickets, triggers (time/inbox/severity/dependency),
  ≤80-line briefs rolling up the tree, cross-model audits that verify
  citations, replay with fault injection. An org-creation skill designs
  one with you.

**Receipts** (all committed in the repo, raw journals included): the same
build script, configs one `[route]` line apart, shipped the same
12/12-test module — gpt-5.6-sol in 107s with zero Claude quota vs Opus 4.8
in 219s on the Claude meter (Sonnet and a deliberately-overkill frontier
run also converged; the overkill run was slowest, on the priciest meter —
which is the whole argument for routing). And v0.5.0 built itself: 14
fleet runs, 72 agents, 1.26M output tokens, all on Codex.

**Honest limitations:** per-agent latency is higher than native subagents
(each agent boots a codex app-server — the trade is whose meter runs);
pre-1.0 and pinned against codex-cli 0.144.0 (doctor reports drift); the
org pillar ships explicitly experimental — the runtime is tested, the
discipline is young, and it will evolve with feedback.

Apache-2.0. Would love feedback — especially from anyone who tries the
org runtime on a domain that isn't code.

https://github.com/YuanpingSong/ultracodex
