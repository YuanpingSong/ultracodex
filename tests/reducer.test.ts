import { describe, expect, it } from "vitest";
import { initialState, reduce, type TuiState } from "../src/tui/reducer.js";
import type {
  AgentEndEvent,
  AgentStartEvent,
  AgentStatus,
  JournalEvent,
  RunTotals,
  Usage,
  WorkflowMeta,
} from "../src/types.js";

function u(out: number, input = out * 10): Usage {
  return {
    totalTokens: input + out,
    inputTokens: input,
    cachedInputTokens: 0,
    outputTokens: out,
    reasoningOutputTokens: 0,
  };
}

const META: WorkflowMeta = {
  name: "demo",
  description: "demo flow",
  phases: [{ title: "Draft" }, { title: "Critique" }],
};

function runStart(ts = 1000, budgetTotal: number | null = 5000): JournalEvent {
  return {
    t: "run_start",
    ts,
    runId: "uc_test1",
    meta: META,
    scriptSha: "abc",
    argsRef: null,
    budgetTotal,
    concurrency: 4,
  };
}

function agentStart(
  n: number,
  label: string,
  phase: string | null,
  backend = "codex",
  ts = 1000 + n,
): AgentStartEvent {
  return {
    t: "agent_start",
    ts,
    n,
    label,
    phase,
    backend,
    model: "gpt-5.4",
    effort: "medium",
    promptSha: `sha${n}`,
    promptRef: `agents/${n}-${label}/prompt.md`,
    hasSchema: false,
  };
}

function agentEnd(
  n: number,
  status: AgentStatus,
  usage: Usage,
  ts: number,
  error: string | null = null,
  resultRef: string | null = null,
): AgentEndEvent {
  return { t: "agent_end", ts, n, status, ms: ts - 1000 - n, usage, resultRef, error };
}

function fold(events: JournalEvent[], from: TuiState = initialState()): TuiState {
  return events.reduce(reduce, from);
}

describe("initialState", () => {
  it("starts empty and running", () => {
    const s = initialState();
    expect(s.runId).toBeNull();
    expect(s.status).toBe("running");
    expect(s.paused).toBe(false);
    expect(s.agents.size).toBe(0);
    expect(s.phases).toEqual([]);
    expect(s.narrator).toEqual([]);
    expect(s.outputTokens).toBe(0);
    expect(s.usageByBackend).toEqual({});
    expect(s.budgetTotal).toBeNull();
    expect(s.totals).toBeNull();
  });
});

describe("run_start", () => {
  it("seeds runId/meta/budget and phases from meta in order", () => {
    const s = fold([runStart()]);
    expect(s.runId).toBe("uc_test1");
    expect(s.meta?.name).toBe("demo");
    expect(s.startTs).toBe(1000);
    expect(s.budgetTotal).toBe(5000);
    expect(s.phases.map((p) => p.title)).toEqual(["Draft", "Critique"]);
    expect(s.phases[0]).toEqual({ title: "Draft", done: 0, running: 0, failed: 0, total: 0 });
  });
});

describe("phase events", () => {
  it("unions phase events with meta phases, preserving order", () => {
    const s = fold([
      runStart(),
      { t: "phase", ts: 1001, title: "Draft" },
      { t: "phase", ts: 1002, title: "Extra" },
    ]);
    expect(s.phases.map((p) => p.title)).toEqual(["Draft", "Critique", "Extra"]);
    expect(s.currentPhase).toBe("Extra");
  });

  it("appends unseen agent phases too", () => {
    const s = fold([runStart(), agentStart(1, "oddball", "Surprise")]);
    expect(s.phases.map((p) => p.title)).toEqual(["Draft", "Critique", "Surprise"]);
    expect(s.phases[2]).toMatchObject({ running: 1, total: 1 });
  });
});

describe("agent lifecycle", () => {
  it("tracks start → thread → activity → usage → end", () => {
    const events: JournalEvent[] = [
      runStart(),
      { t: "phase", ts: 1001, title: "Draft" },
      agentStart(1, "summarize", "Draft"),
      { t: "agent_thread", ts: 1010, n: 1, threadId: "thr-1" },
      { t: "agent_activity", ts: 1020, n: 1, kind: "exec", text: "Running command: ls" },
      { t: "agent_activity", ts: 1030, n: 1, kind: "exec", text: "Running command: pnpm test", phase: "verifying" },
      { t: "agent_usage", ts: 1040, n: 1, usage: u(50) },
      agentEnd(1, "ok", u(120), 1100, null, "agents/1-summarize/output.txt"),
    ];
    let s = fold(events.slice(0, 7));
    const a = s.agents.get(1)!;
    expect(a.status).toBe("running");
    expect(a.threadId).toBe("thr-1");
    expect(a.activityCount).toBe(2);
    // latest-wins
    expect(a.activity).toEqual({ kind: "exec", text: "Running command: pnpm test", phase: "verifying" });
    expect(a.usage.outputTokens).toBe(50);
    expect(s.phases.find((p) => p.title === "Draft")).toMatchObject({ running: 1, done: 0, total: 1 });
    // no backend ledger until agent_end
    expect(s.usageByBackend).toEqual({});
    expect(s.outputTokens).toBe(0);

    s = fold(events);
    const done = s.agents.get(1)!;
    expect(done.status).toBe("ok");
    expect(done.endTs).toBe(1100);
    expect(done.usage.outputTokens).toBe(120);
    expect(done.resultRef).toBe("agents/1-summarize/output.txt");
    expect(s.phases.find((p) => p.title === "Draft")).toMatchObject({ running: 0, done: 1, total: 1 });
    expect(s.usageByBackend["codex"]?.outputTokens).toBe(120);
    expect(s.outputTokens).toBe(120);
  });

  it("accumulates usageByBackend across backends and agents", () => {
    const s = fold([
      runStart(),
      agentStart(1, "a", "Draft", "codex"),
      agentStart(2, "b", "Draft", "codex"),
      agentStart(3, "c", "Critique", "claude"),
      agentEnd(1, "ok", u(100), 1100),
      agentEnd(2, "ok", u(30), 1110),
      agentEnd(3, "ok", u(7), 1120),
    ]);
    expect(s.usageByBackend["codex"]?.outputTokens).toBe(130);
    expect(s.usageByBackend["claude"]?.outputTokens).toBe(7);
    expect(s.outputTokens).toBe(137);
  });

  it("records failed agents with error, phase failed count", () => {
    const s = fold([
      runStart(),
      agentStart(1, "critic", "Critique"),
      agentEnd(1, "failed", u(5), 1100, "boom exploded"),
    ]);
    const a = s.agents.get(1)!;
    expect(a.status).toBe("failed");
    expect(a.error).toBe("boom exploded");
    expect(s.phases.find((p) => p.title === "Critique")).toMatchObject({ failed: 1, done: 0, total: 1 });
  });

  it("counts skipped agents as finished in phase counts", () => {
    const s = fold([runStart(), agentStart(1, "skippy", "Draft"), agentEnd(1, "skipped", u(0), 1100)]);
    expect(s.agents.get(1)?.status).toBe("skipped");
    expect(s.phases.find((p) => p.title === "Draft")).toMatchObject({ done: 1, running: 0, failed: 0, total: 1 });
  });

  it("ignores events for unknown agents", () => {
    const base = fold([runStart()]);
    const s = fold(
      [
        { t: "agent_activity", ts: 1, n: 9, kind: "exec", text: "x" },
        { t: "agent_usage", ts: 2, n: 9, usage: u(5) },
        { t: "agent_thread", ts: 3, n: 9, threadId: "t" },
        agentEnd(9, "ok", u(5), 4),
      ],
      base,
    );
    expect(s).toEqual(base);
  });
});

describe("paused / resumed", () => {
  it("toggles the paused flag", () => {
    let s = fold([runStart(), { t: "paused", ts: 2000 }]);
    expect(s.paused).toBe(true);
    s = reduce(s, { t: "resumed", ts: 2001 });
    expect(s.paused).toBe(false);
  });
});

describe("narrator", () => {
  it("appends log and warn lines with warn flags", () => {
    const s = fold([
      runStart(),
      { t: "log", ts: 1500, text: "starting draft" },
      { t: "warn", ts: 1600, text: "schema retry 1" },
    ]);
    expect(s.narrator).toEqual([
      { ts: 1500, text: "starting draft" },
      { ts: 1600, text: "schema retry 1", warn: true },
    ]);
  });

  it("caps narrator at 50 entries", () => {
    const events: JournalEvent[] = [runStart()];
    for (let i = 0; i < 60; i++) events.push({ t: "log", ts: 2000 + i, text: `line ${i}` });
    const s = fold(events);
    expect(s.narrator.length).toBe(50);
    expect(s.narrator[0]?.text).toBe("line 10");
    expect(s.narrator[49]?.text).toBe("line 59");
  });
});

describe("run_end", () => {
  const totals: RunTotals = {
    agents: 2,
    ok: 1,
    failed: 1,
    skipped: 0,
    usage: { codex: u(200), claude: u(50) },
    ms: 9000,
  };

  it("adopts status, resultRef, totals and authoritative usage", () => {
    const s = fold([
      runStart(),
      agentStart(1, "a", "Draft"),
      agentEnd(1, "ok", u(100), 1100),
      { t: "run_end", ts: 10_000, status: "ok", resultRef: "result.json", error: null, totals },
    ]);
    expect(s.status).toBe("ok");
    expect(s.endTs).toBe(10_000);
    expect(s.resultRef).toBe("result.json");
    expect(s.totals).toEqual(totals);
    expect(s.usageByBackend).toEqual(totals.usage);
    expect(s.outputTokens).toBe(250);
  });

  it("clears currentPhase so the final phase counts as finished, not active", () => {
    const s = fold([
      runStart(),
      { t: "phase", ts: 1001, title: "Critique" },
      agentStart(1, "critic", "Critique"),
      agentEnd(1, "ok", u(10), 1100),
      { t: "run_end", ts: 10_000, status: "ok", resultRef: "result.json", error: null, totals },
    ]);
    expect(s.currentPhase).toBeNull();
    // phase counts themselves are untouched
    expect(s.phases.find((p) => p.title === "Critique")).toMatchObject({ done: 1, running: 0, total: 1 });
  });

  it("records failed and stopped runs", () => {
    const sf = fold([runStart(), { t: "run_end", ts: 2, status: "failed", resultRef: null, error: "kaput", totals }]);
    expect(sf.status).toBe("failed");
    expect(sf.error).toBe("kaput");
    const ss = fold([runStart(), { t: "run_end", ts: 2, status: "stopped", resultRef: null, error: null, totals }]);
    expect(ss.status).toBe("stopped");
  });
});

describe("budget", () => {
  it("passes budgetTotal through (null when unset)", () => {
    expect(fold([runStart(1000, null)]).budgetTotal).toBeNull();
    expect(fold([runStart(1000, 123_000)]).budgetTotal).toBe(123_000);
  });
});

function fullSequence(): JournalEvent[] {
  return [
    runStart(),
    { t: "phase", ts: 1001, title: "Draft" },
    agentStart(1, "writer-a", "Draft"),
    agentStart(2, "writer-b", "Draft"),
    { t: "agent_thread", ts: 1010, n: 1, threadId: "thr-1" },
    { t: "agent_activity", ts: 1020, n: 1, kind: "exec", text: "Running command: rg -n foo" },
    { t: "agent_usage", ts: 1030, n: 1, usage: u(40) },
    { t: "log", ts: 1040, text: "drafting" },
    { t: "agent_activity", ts: 1050, n: 2, kind: "reasoning", text: "Thinking about structure" },
    agentEnd(1, "ok", u(90), 1100, null, "agents/1-writer-a/output.txt"),
    { t: "paused", ts: 1150 },
    { t: "resumed", ts: 1200 },
    agentEnd(2, "failed", u(10), 1250, "timeout"),
    { t: "phase", ts: 1300, title: "Critique" },
    agentStart(3, "critic", "Critique", "claude", 1310),
    { t: "agent_thread", ts: 1320, n: 3, threadId: "thr-3" },
    { t: "warn", ts: 1330, text: "schema retry" },
    { t: "agent_usage", ts: 1340, n: 3, usage: u(20) },
    agentEnd(3, "ok", u(60), 1400),
    {
      t: "run_end",
      ts: 1500,
      status: "ok",
      resultRef: "result.json",
      error: null,
      totals: { agents: 3, ok: 2, failed: 1, skipped: 0, usage: { codex: u(100), claude: u(60) }, ms: 500 },
    },
  ];
}

describe("attach-mid-run replay equivalence", () => {
  it("fold(all) === fold(rest, fold(prefix)) at every split point", () => {
    const events = fullSequence();
    const full = fold(events);
    for (let i = 0; i <= events.length; i++) {
      const prefix = fold(events.slice(0, i));
      const resumed = fold(events.slice(i), prefix);
      expect(resumed).toEqual(full);
    }
  });
});

describe("purity", () => {
  it("reduce never mutates its input state", () => {
    const events = fullSequence();
    let s = initialState();
    for (const ev of events) {
      const before = structuredClone(s);
      const next = reduce(s, ev);
      expect(s).toEqual(before);
      s = next;
    }
  });
});
