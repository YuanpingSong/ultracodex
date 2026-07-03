import type { JournalEvent, RunTotals, Usage, WorkflowMeta } from "../types.js";
import { ZERO_USAGE, addUsage } from "../types.js";

export interface AgentView {
  n: number;
  label: string;
  phase: string | null;
  backend: string;
  model: string | null;
  status: "running" | "ok" | "failed" | "skipped";
  startTs: number;
  endTs: number | null;
  activity: { kind: string; text: string; phase?: string } | null;
  usage: Usage;
  threadId: string | null;
  error: string | null;
  resultRef: string | null;
  activityCount: number;
}

export interface PhaseView {
  title: string;
  done: number;
  running: number;
  failed: number;
  total: number;
}

export interface TuiState {
  runId: string | null;
  meta: WorkflowMeta | null;
  startTs: number | null;
  endTs: number | null;
  status: "running" | "ok" | "failed" | "stopped";
  paused: boolean;
  budgetTotal: number | null;
  outputTokens: number;
  usageByBackend: Record<string, Usage>;
  currentPhase: string | null;
  phases: PhaseView[];
  agents: Map<number, AgentView>;
  narrator: Array<{ ts: number; text: string; warn?: boolean }>;
  resultRef: string | null;
  error: string | null;
  totals: RunTotals | null;
}

const NARRATOR_MAX = 50;

export function initialState(): TuiState {
  return {
    runId: null,
    meta: null,
    startTs: null,
    endTs: null,
    status: "running",
    paused: false,
    budgetTotal: null,
    outputTokens: 0,
    usageByBackend: {},
    currentPhase: null,
    phases: [],
    agents: new Map(),
    narrator: [],
    resultRef: null,
    error: null,
    totals: null,
  };
}

function sumOutput(usage: Record<string, Usage>): number {
  let total = 0;
  for (const u of Object.values(usage)) total += u.outputTokens;
  return total;
}

function computePhases(titles: string[], agents: Map<number, AgentView>): PhaseView[] {
  const counts = new Map<string, PhaseView>();
  for (const title of titles) {
    counts.set(title, { title, done: 0, running: 0, failed: 0, total: 0 });
  }
  for (const a of agents.values()) {
    if (a.phase === null) continue;
    const c = counts.get(a.phase);
    if (!c) continue;
    c.total++;
    if (a.status === "running") c.running++;
    else if (a.status === "failed") c.failed++;
    else c.done++; // ok + skipped both count as finished
  }
  return titles.map((t) => counts.get(t)!);
}

function phaseTitles(state: TuiState): string[] {
  return state.phases.map((p) => p.title);
}

function pushNarrator(
  narrator: TuiState["narrator"],
  entry: { ts: number; text: string; warn?: boolean },
): TuiState["narrator"] {
  const next = [...narrator, entry];
  return next.length > NARRATOR_MAX ? next.slice(-NARRATOR_MAX) : next;
}

function updateAgent(state: TuiState, n: number, patch: Partial<AgentView>): TuiState {
  const a = state.agents.get(n);
  if (!a) return state;
  const agents = new Map(state.agents);
  agents.set(n, { ...a, ...patch });
  return { ...state, agents };
}

export function reduce(state: TuiState, ev: JournalEvent): TuiState {
  switch (ev.t) {
    case "run_start": {
      const titles: string[] = [];
      for (const p of ev.meta.phases ?? []) {
        if (!titles.includes(p.title)) titles.push(p.title);
      }
      return {
        ...state,
        runId: ev.runId,
        meta: ev.meta,
        startTs: ev.ts,
        budgetTotal: ev.budgetTotal,
        status: "running",
        phases: computePhases(titles, state.agents),
      };
    }
    case "phase": {
      let titles = phaseTitles(state);
      if (!titles.includes(ev.title)) titles = [...titles, ev.title];
      return { ...state, currentPhase: ev.title, phases: computePhases(titles, state.agents) };
    }
    case "agent_start": {
      const agent: AgentView = {
        n: ev.n,
        label: ev.label,
        phase: ev.phase,
        backend: ev.backend,
        model: ev.model,
        status: "running",
        startTs: ev.ts,
        endTs: null,
        activity: null,
        usage: ZERO_USAGE,
        threadId: null,
        error: null,
        resultRef: null,
        activityCount: 0,
      };
      const agents = new Map(state.agents);
      agents.set(ev.n, agent);
      let titles = phaseTitles(state);
      if (ev.phase !== null && !titles.includes(ev.phase)) titles = [...titles, ev.phase];
      return { ...state, agents, phases: computePhases(titles, agents) };
    }
    case "agent_thread":
      return updateAgent(state, ev.n, { threadId: ev.threadId });
    case "agent_activity": {
      const a = state.agents.get(ev.n);
      if (!a) return state;
      const activity: AgentView["activity"] = { kind: ev.kind, text: ev.text };
      if (ev.phase !== undefined) activity.phase = ev.phase;
      return updateAgent(state, ev.n, { activity, activityCount: a.activityCount + 1 });
    }
    case "agent_usage":
      return updateAgent(state, ev.n, { usage: ev.usage });
    case "agent_end": {
      const a = state.agents.get(ev.n);
      if (!a) return state;
      const agents = new Map(state.agents);
      agents.set(ev.n, {
        ...a,
        status: ev.status,
        endTs: ev.ts,
        usage: ev.usage,
        resultRef: ev.resultRef,
        error: ev.error,
      });
      const prev = state.usageByBackend[a.backend] ?? ZERO_USAGE;
      const usageByBackend = { ...state.usageByBackend, [a.backend]: addUsage(prev, ev.usage) };
      return {
        ...state,
        agents,
        usageByBackend,
        outputTokens: sumOutput(usageByBackend),
        phases: computePhases(phaseTitles(state), agents),
      };
    }
    case "log":
      return { ...state, narrator: pushNarrator(state.narrator, { ts: ev.ts, text: ev.text }) };
    case "warn":
      return {
        ...state,
        narrator: pushNarrator(state.narrator, { ts: ev.ts, text: ev.text, warn: true }),
      };
    case "paused":
      return { ...state, paused: true };
    case "resumed":
      return { ...state, paused: false };
    case "run_end":
      return {
        ...state,
        status: ev.status,
        endTs: ev.ts,
        resultRef: ev.resultRef,
        error: ev.error,
        totals: ev.totals,
        usageByBackend: ev.totals.usage,
        outputTokens: sumOutput(ev.totals.usage),
      };
    default:
      return state;
  }
}
