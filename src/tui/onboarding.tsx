import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { col } from "./colors.js";

// Contextual onboarding shown in a tab's empty state: a short "when to use it",
// an ASCII sketch of the concept, a few real commands, and a docs link. The
// docs URLs are GitHub blob/tree links — valid once the repo is public.

export interface Onboarding {
  intro: string;
  art: string[];
  commands: string[];
  docs: string;
}

const REPO = "https://github.com/YuanpingSong/ultracodex";

export const RUNS_ONBOARDING: Onboarding = {
  intro:
    "A workflow fans one task out to a fleet of agents — parallel reviewers, pipelined stages, phased builds — and hands back a single verified result. Describe the task to your coding agent, or run a script from the CLI.",
  art: [
    "        ┌─→ agent ─┐",
    " task ──┼─→ agent ─┼─→ verify ─→ result",
    "        └─→ agent ─┘",
  ],
  commands: [
    "ultracodex sync-skills                 # teach your coding agent to write one",
    "ultracodex run path/to/workflow.js --watch",
    "ultracodex validate --strict workflow.js",
  ],
  docs: `${REPO}/tree/main/examples`,
};

export const LOOPS_ONBOARDING: Onboarding = {
  intro:
    "Loops keep an agent working until the result is right — builder rounds gated by a skeptical verifier, or discovery that repeats until nothing new turns up. Reach for one when “done” is a judgment, not a fixed step count. Runs that iterate appear here as convergence trajectories.",
  art: [
    " round 1   round 2   round 3",
    "   ✗    →    ✗    →    ✔   converged",
  ],
  commands: [
    "ultracodex run goal --budget 200k --args '{\"task\":\"…\",\"criteria\":\"…\"}'",
    "ultracodex show <runId>          # view a run's round-by-round trajectory",
  ],
  docs: `${REPO}/blob/main/docs/loops.md`,
};

export const SCHEDULES_ONBOARDING: Onboarding = {
  intro:
    "The scheduler runs a workflow on a recurring clock — one tagged crontab line it owns, no daemon. Use it for digests, nightly checks, or a loop that reports done and retires itself. Always pass --budget so an unattended run can't drain your quota.",
  art: [
    " ─┬───────┬───────┬──▶  every 30m",
    "  ▶       ▶       ▶      a run each tick",
  ],
  commands: [
    "ultracodex schedule add digest --every 30m --budget 200k -- run path/to/digest.js",
    "ultracodex schedule add nightly --daily 18:30 --until-done --budget 500k -- run goal --args '{\"task\":\"…\",\"criteria\":\"…\"}'",
    "ultracodex schedule ls",
  ],
  docs: `${REPO}/blob/main/docs/schedule.md`,
};

// Shown in the always-on Org tab when the current project is NOT yet an org.
export const ORG_CREATE_ONBOARDING: Onboarding = {
  intro:
    "An org is a standing team of agents with durable memory — one seat per subject, briefs rolling up a tree, waking on triggers so judgment compounds over time. It is experimental. Stand one up from a coverage.toml with org init, or let the org-creation skill design it with you.",
  art: [
    " root",
    " ├─ group ─┬─ seat",
    " │         └─ seat",
    " └─ group ──── seat",
  ],
  commands: [
    "ultracodex sync-skills          # installs the org-creation skill",
    "ultracodex org init             # scaffold from coverage.toml",
    "ultracodex org lint             # check the fresh tree",
  ],
  docs: `${REPO}/blob/main/docs/org.md`,
};

// Shown inside OrgView when the org is scaffolded but has never run a tick.
export const ORG_ONBOARDING: Onboarding = {
  intro:
    "An org is a standing team of agents with durable memory — one seat per subject, briefs rolling up a tree. Each tick wakes the seats whose triggers fire, so judgment compounds over time. Your seats are scaffolded below; run a tick to bring them to life.",
  art: [
    " root",
    " ├─ group ─┬─ seat",
    " │         └─ seat",
    " └─ group ──── seat",
  ],
  commands: [
    "ultracodex org tick",
    "ultracodex org status --json",
    "ultracodex org ask <seat> \"what changed?\"",
  ],
  docs: `${REPO}/blob/main/docs/org.md`,
};

export function TabOnboarding({ o }: { o: Onboarding }): ReactElement {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={2}>
      <Text dimColor wrap="wrap">
        {o.intro}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {o.art.map((line, i) => (
          <Text key={i} color={col("cyan")}>
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Try:</Text>
        {o.commands.map((c, i) => (
          <Text key={i} color={col("green")} wrap="truncate-end">
            {"  $ "}
            {c}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Docs: {o.docs}</Text>
      </Box>
    </Box>
  );
}
