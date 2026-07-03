import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState, reduce, type TuiState } from "../src/tui/reducer.js";
import { renderRunStatic } from "../src/tui/static.js";
import type { JournalEvent, Usage, WorkflowMeta } from "../src/types.js";

const ANSI = /\u001b\[/;

function u(out: number): Usage {
  return {
    totalTokens: out * 11,
    inputTokens: out * 10,
    cachedInputTokens: 0,
    outputTokens: out,
    reasoningOutputTokens: 0,
  };
}

const META: WorkflowMeta = {
  name: "digest",
  description: "doc digest",
  phases: [{ title: "Summarize" }, { title: "Critique" }],
};

function midRunEvents(): JournalEvent[] {
  return [
    {
      t: "run_start",
      ts: 1000,
      runId: "uc_static1",
      meta: META,
      scriptSha: "s",
      argsRef: null,
      budgetTotal: 10_000,
      concurrency: 4,
    },
    { t: "phase", ts: 1001, title: "Summarize" },
    {
      t: "agent_start",
      ts: 1002,
      n: 1,
      label: "summarize-intro",
      phase: "Summarize",
      backend: "codex",
      model: "gpt-5.4",
      effort: "medium",
      promptSha: "p1",
      promptRef: "agents/1-summarize-intro/prompt.md",
      hasSchema: false,
    },
    {
      t: "agent_start",
      ts: 1003,
      n: 2,
      label: "summarize-body",
      phase: "Summarize",
      backend: "codex",
      model: "gpt-5.4",
      effort: "medium",
      promptSha: "p2",
      promptRef: "agents/2-summarize-body/prompt.md",
      hasSchema: false,
    },
    { t: "agent_thread", ts: 1004, n: 2, threadId: "thread-abc123" },
    {
      t: "agent_start",
      ts: 1005,
      n: 3,
      label: "watcher",
      phase: "Summarize",
      backend: "codex",
      model: "gpt-5.4",
      effort: null,
      promptSha: "p3",
      promptRef: "agents/3-watcher/prompt.md",
      hasSchema: false,
    },
    {
      t: "agent_start",
      ts: 1006,
      n: 4,
      label: "live-agent",
      phase: "Summarize",
      backend: "codex",
      model: "gpt-5.4",
      effort: null,
      promptSha: "p4",
      promptRef: "agents/4-live-agent/prompt.md",
      hasSchema: false,
    },
    { t: "agent_end", ts: 2000, n: 1, status: "ok", ms: 998, usage: u(150), resultRef: "agents/1-summarize-intro/output.txt", error: null },
    { t: "agent_end", ts: 2100, n: 2, status: "failed", ms: 1097, usage: u(20), resultRef: null, error: "ajv said no: missing property 'verdict'" },
    { t: "agent_end", ts: 2200, n: 3, status: "skipped", ms: 1195, usage: u(0), resultRef: null, error: null },
    { t: "agent_activity", ts: 2300, n: 4, kind: "exec", text: "Running command: pnpm vitest run", phase: "verifying" },
    { t: "agent_usage", ts: 2400, n: 4, usage: u(33) },
    { t: "log", ts: 2500, text: "summaries landing" },
    { t: "warn", ts: 2600, text: "schema retry 1/3" },
  ];
}

function fold(events: JournalEvent[]): TuiState {
  return events.reduce(reduce, initialState());
}

let savedNoColor: string | undefined;
beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
});
afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
});

describe("renderRunStatic — mid-run state", () => {
  it("renders header, phases, agent lines, glyphs and narrator without ANSI when color:false", () => {
    const out = renderRunStatic(fold(midRunEvents()), { color: false });
    expect(out).not.toMatch(ANSI);

    // header
    expect(out).toContain("digest");
    expect(out).toContain("uc_static1");
    expect(out).toContain("running");
    expect(out).toContain("3/4 agents");
    expect(out).toContain("budget");

    // phase strip (Critique seeded from meta even with zero agents)
    expect(out).toContain("Summarize 2/4");
    expect(out).toContain("Critique 0/0");

    // agent lines with status glyphs
    expect(out).toContain("✔ 1 summarize-intro");
    expect(out).toContain("✖ 2 summarize-body");
    expect(out).toContain("⊘ 3 watcher");
    expect(out).toContain("● 4 live-agent");
    expect(out).toContain("codex·gpt-5.4");

    // tokens + durations
    expect(out).toContain("150 tok");
    expect(out).toContain("33 tok");
    expect(out).toContain("1.0s"); // agent 1 duration

    // error snippet inline
    expect(out).toContain("ajv said no");

    // running agent's live activity
    expect(out).toContain("Running command: pnpm vitest run");

    // narrator tail
    expect(out).toContain("summaries landing");
    expect(out).toContain("schema retry 1/3");

    // resume hint for the failed agent with a known thread
    expect(out).toContain("codex resume thread-abc123");
  });

  it("shows PAUSED when paused", () => {
    const paused = reduce(fold(midRunEvents()), { t: "paused", ts: 3000 });
    expect(renderRunStatic(paused, { color: false })).toContain("PAUSED");
  });

  it("emits ANSI colors when color is on", () => {
    const out = renderRunStatic(fold(midRunEvents()), { color: true });
    expect(out).toMatch(ANSI);
  });

  it("respects NO_COLOR even when color:true", () => {
    process.env.NO_COLOR = "1";
    const out = renderRunStatic(fold(midRunEvents()), { color: true });
    expect(out).not.toMatch(ANSI);
  });

  it("defaults to color on (no opts)", () => {
    expect(renderRunStatic(fold(midRunEvents()))).toMatch(ANSI);
  });
});

describe("renderRunStatic — finished runs", () => {
  it("renders the result pointer for ok runs", () => {
    const events: JournalEvent[] = [
      ...midRunEvents(),
      { t: "agent_end", ts: 2900, n: 4, status: "ok", ms: 1894, usage: u(40), resultRef: null, error: null },
      {
        t: "run_end",
        ts: 3000,
        status: "ok",
        resultRef: "result.json",
        error: null,
        totals: { agents: 4, ok: 2, failed: 1, skipped: 1, usage: { codex: u(210) }, ms: 2000 },
      },
    ];
    const out = renderRunStatic(fold(events), { color: false });
    expect(out).toContain("ok");
    expect(out).toContain("result: result.json");
    expect(out).toContain("4/4 agents");
    expect(out).toContain("210 out tok");
  });

  it("renders the error for failed runs", () => {
    const events: JournalEvent[] = [
      ...midRunEvents(),
      {
        t: "run_end",
        ts: 3000,
        status: "failed",
        resultRef: null,
        error: "workflow threw: TypeError",
        totals: { agents: 4, ok: 1, failed: 2, skipped: 1, usage: { codex: u(170) }, ms: 2000 },
      },
    ];
    const out = renderRunStatic(fold(events), { color: false });
    expect(out).toContain("failed");
    expect(out).toContain("error: workflow threw: TypeError");
  });

  it("renders stopped runs", () => {
    const events: JournalEvent[] = [
      ...midRunEvents(),
      {
        t: "run_end",
        ts: 3000,
        status: "stopped",
        resultRef: null,
        error: null,
        totals: { agents: 4, ok: 1, failed: 1, skipped: 2, usage: { codex: u(170) }, ms: 2000 },
      },
    ];
    const out = renderRunStatic(fold(events), { color: false });
    expect(out).toContain("stopped by user");
  });

  it("renders an empty (pre-run_start) state without crashing", () => {
    const out = renderRunStatic(initialState(), { color: false });
    expect(out).toContain("(unknown workflow)");
    expect(out).toContain("0/0 agents");
  });
});
