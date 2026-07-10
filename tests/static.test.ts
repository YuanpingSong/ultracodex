import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInEditor, parseEditorCommand } from "../src/tui/clipboard.js";
import {
  clampPhaseFilter,
  computeContentBudget,
  filterAgentsByPhase,
  phaseFilterTitle,
  RESULT_TAIL_MAX,
  windowAgents,
} from "../src/tui/format.js";
import { loadWorkflows, validateBudgetInput } from "../src/tui/HomeView.js";
import {
  initialState,
  reduce,
  type AgentView,
  type PhaseView,
  type TuiState,
} from "../src/tui/reducer.js";
import { RUNNER_START_GRACE_MS, runnerLooksDead } from "../src/tui/RunView.js";
import { renderRunStatic } from "../src/tui/static.js";
import { summarizeConfig } from "../src/tui/statusLine.js";
import { DEFAULT_CONFIG } from "../src/constants.js";
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

  it("renders the final phase as finished (✔), not active (●), after run_end", () => {
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
    // "Summarize" was the currentPhase when the run ended; it must show ✔.
    expect(out).toContain("✔ Summarize 3/4");
    expect(out).not.toContain("● Summarize");
  });

  it("appends a LOOPS section with loop and round ledgers", () => {
    const events: JournalEvent[] = [
      {
        t: "run_start",
        ts: 0,
        runId: "wf_7fk2qd",
        meta: { name: "goal", description: "goal loop" },
        scriptSha: "s",
        argsRef: null,
        budgetTotal: null,
        concurrency: 4,
      },
      {
        t: "agent_start",
        ts: 0,
        n: 1,
        label: "goal:build-r1",
        phase: null,
        backend: "codex",
        model: "gpt-5.5",
        effort: "medium",
        promptSha: "p1",
        promptRef: "agents/1/prompt.md",
        hasSchema: false,
      },
      {
        t: "agent_start",
        ts: 10_000,
        n: 2,
        label: "goal:verify-r1",
        phase: null,
        backend: "claude",
        model: "sonnet-5",
        effort: "medium",
        promptSha: "p2",
        promptRef: "agents/2/prompt.md",
        hasSchema: false,
      },
      { t: "agent_end", ts: 190_000, n: 1, status: "ok", ms: 190_000, usage: u(48_900), resultRef: "build-r1.json", error: null },
      { t: "agent_end", ts: 242_000, n: 2, status: "ok", ms: 232_000, usage: u(12_500), resultRef: "verify-r1.json", error: null },
      {
        t: "agent_start",
        ts: 250_000,
        n: 3,
        label: "goal:build-r2",
        phase: null,
        backend: "codex",
        model: "gpt-5.5",
        effort: "medium",
        promptSha: "p3",
        promptRef: "agents/3/prompt.md",
        hasSchema: false,
      },
      {
        t: "agent_start",
        ts: 260_000,
        n: 4,
        label: "goal:verify-r2",
        phase: null,
        backend: "claude",
        model: "sonnet-5",
        effort: "medium",
        promptSha: "p4",
        promptRef: "agents/4/prompt.md",
        hasSchema: false,
      },
      { t: "agent_end", ts: 450_000, n: 3, status: "ok", ms: 200_000, usage: u(40_000), resultRef: "build-r2.json", error: null },
      { t: "agent_end", ts: 478_000, n: 4, status: "ok", ms: 218_000, usage: u(12_700), resultRef: "verify-r2.json", error: null },
      {
        t: "agent_start",
        ts: 480_000,
        n: 5,
        label: "goal:build-r3",
        phase: null,
        backend: "codex",
        model: "gpt-5.5",
        effort: "medium",
        promptSha: "p5",
        promptRef: "agents/5/prompt.md",
        hasSchema: false,
      },
      {
        t: "agent_start",
        ts: 490_000,
        n: 6,
        label: "goal:verify-r3",
        phase: null,
        backend: "claude",
        model: "sonnet-5",
        effort: "medium",
        promptSha: "p6",
        promptRef: "agents/6/prompt.md",
        hasSchema: false,
      },
      { t: "agent_end", ts: 650_000, n: 5, status: "ok", ms: 170_000, usage: u(25_000), resultRef: "build-r3.json", error: null },
      { t: "agent_end", ts: 702_000, n: 6, status: "ok", ms: 212_000, usage: u(9_100), resultRef: "verify-r3.json", error: null },
      {
        t: "run_end",
        ts: 710_000,
        status: "ok",
        resultRef: null,
        error: null,
        totals: { agents: 6, ok: 6, failed: 0, skipped: 0, usage: { codex: u(148_200) }, ms: 710_000 },
      },
    ];
    const outputs: Record<string, string> = {
      "verify-r1.json": JSON.stringify({ verdict: "rejected", issues: ["tests missing", "no docs"] }),
      "verify-r2.json": JSON.stringify({ verdict: "rejected", reason: "still missing coverage" }),
      "verify-r3.json": JSON.stringify({ verdict: "approved", summary: "done" }),
    };
    const out = renderRunStatic(fold(events), { color: false, readAgentOutput: (ref) => outputs[ref] ?? null });
    const loops = out.slice(out.indexOf("LOOPS"));

    expect(loops).toContain("LOOPS");
    expect(loops).toContain("goal · ✔ converged after 3 rounds · ✖ ✖ ✔ · 148.2k tok · 11m 32s");
    expect(loops).toContain("r1 ✖ rejected · 2 agents · 61.4k tok · 4m02s");
    expect(loops).toContain("r2 ✖ rejected · 2 agents · 52.7k tok · 3m48s");
    expect(loops).toContain("r3 ✔ approved · 2 agents · 34.1k tok · 3m42s");
  });
});

describe("LaunchForm budget validation (HomeView.validateBudgetInput)", () => {
  it("accepts empty as 'no budget'", () => {
    expect(validateBudgetInput("")).toEqual({ ok: true, budgetTotal: null });
    expect(validateBudgetInput("   ")).toEqual({ ok: true, budgetTotal: null });
  });

  it("parses k/m suffixes and plain counts like the CLI", () => {
    expect(validateBudgetInput("500k")).toEqual({ ok: true, budgetTotal: 500_000 });
    expect(validateBudgetInput("1.5m")).toEqual({ ok: true, budgetTotal: 1_500_000 });
    expect(validateBudgetInput("12345")).toEqual({ ok: true, budgetTotal: 12_345 });
  });

  it("rejects garbage instead of silently launching without a ceiling", () => {
    const r = validateBudgetInput("5ook");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('invalid budget "5ook"');
    expect(validateBudgetInput("500 tokens").ok).toBe(false);
    expect(validateBudgetInput("0").ok).toBe(false); // CLI parity: non-positive is invalid
  });
});

describe("HomeView workflow listing", () => {
  it("lists package builtins after saved workflows and lets saved names shadow builtins", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-home-wf-"));
    try {
      const dir = path.join(projectDir, ".ultracodex", "workflows");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "goal.js"),
        "export const meta = { name: 'goal', description: 'local goal' }\n",
        "utf8",
      );
      const workflows = loadWorkflows(projectDir);
      const goalItems = workflows.filter((wf) => wf.name === "goal");
      const auditItem = workflows.find((wf) => wf.name === "org-audit");

      expect(goalItems).toHaveLength(1);
      expect(goalItems[0]?.builtin).toBeUndefined();
      expect(goalItems[0]?.description).toBe("local goal");
      expect(auditItem?.builtin).toBe(true);
      expect(workflows.findIndex((wf) => wf.name === "goal")).toBeLessThan(
        workflows.findIndex((wf) => wf.name === "org-audit"),
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe("dead-runner heuristic (RunView.runnerLooksDead)", () => {
  const base = { runStartTs: 10_000, attachedTs: 10_000 };

  it("pidfile present: dead iff the pid is gone", () => {
    expect(runnerLooksDead({ ...base, pid: 123, alive: true, now: 999_999 })).toBe(false);
    expect(runnerLooksDead({ ...base, pid: 123, alive: false, now: 10_001 })).toBe(true);
  });

  it("no pidfile: alive within the startup grace, dead after it", () => {
    const opts = { ...base, pid: null, alive: false };
    expect(runnerLooksDead({ ...opts, now: 10_000 + RUNNER_START_GRACE_MS })).toBe(false);
    expect(runnerLooksDead({ ...opts, now: 10_001 + RUNNER_START_GRACE_MS })).toBe(true);
  });

  it("no pidfile and no run_start yet: grace runs from attach time", () => {
    const opts = { pid: null, alive: false, runStartTs: null, attachedTs: 50_000 };
    expect(runnerLooksDead({ ...opts, now: 51_000 })).toBe(false);
    expect(runnerLooksDead({ ...opts, now: 50_000 + RUNNER_START_GRACE_MS + 1 })).toBe(true);
  });

  it("honors a custom grace", () => {
    const opts = { pid: null, alive: false, runStartTs: 0, attachedTs: 0, graceMs: 100 };
    expect(runnerLooksDead({ ...opts, now: 99 })).toBe(false);
    expect(runnerLooksDead({ ...opts, now: 101 })).toBe(true);
  });
});

describe("$EDITOR handling (clipboard)", () => {
  it("parseEditorCommand splits shell-style with quotes and escapes", () => {
    expect(parseEditorCommand("vi")).toEqual(["vi"]);
    expect(parseEditorCommand("code --wait")).toEqual(["code", "--wait"]);
    expect(parseEditorCommand('"/opt/My Editor/bin" -n')).toEqual(["/opt/My Editor/bin", "-n"]);
    expect(parseEditorCommand("emacsclient -c -a ''")).toEqual(["emacsclient", "-c", "-a", ""]);
    expect(parseEditorCommand("open\\ me now")).toEqual(["open me", "now"]);
    expect(parseEditorCommand("   ")).toEqual([]);
  });

  describe("openInEditor", () => {
    let tmp: string;
    let savedEditor: string | undefined;
    let savedVisual: string | undefined;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-editor-"));
      savedEditor = process.env.EDITOR;
      savedVisual = process.env.VISUAL;
      delete process.env.VISUAL;
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
      if (savedEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = savedEditor;
      if (savedVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = savedVisual;
      vi.restoreAllMocks();
    });

    it("supports a multi-word $EDITOR (command + args) and passes the file last", () => {
      const script = path.join(tmp, "fake-editor.cjs");
      const sentinel = path.join(tmp, "opened.json");
      fs.writeFileSync(
        script,
        `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, JSON.stringify(process.argv.slice(2)));\n`,
        "utf8",
      );
      const target = path.join(tmp, "output.txt");
      fs.writeFileSync(target, "hello", "utf8");
      process.env.EDITOR = `"${process.execPath}" "${script}" --wait`;
      expect(openInEditor(target)).toBe(true);
      expect(JSON.parse(fs.readFileSync(sentinel, "utf8"))).toEqual(["--wait", target]);
    });

    it("surfaces a missing editor (ENOENT) instead of failing silently", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.EDITOR = "definitely-not-a-real-editor-xyz --wait";
      expect(openInEditor(path.join(tmp, "whatever.txt"))).toBe(false);
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]?.[0])).toContain("failed to open $EDITOR");
    });

    it("surfaces an empty $EDITOR", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env.EDITOR = "''";
      expect(openInEditor(path.join(tmp, "whatever.txt"))).toBe(false);
      expect(err).toHaveBeenCalledTimes(1);
    });
  });
});

describe("phase filter helpers (format)", () => {
  const phase = (title: string, total: number): PhaseView => ({
    title,
    done: 0,
    running: 0,
    failed: 0,
    total,
  });
  const PHASES: PhaseView[] = [phase("Read", 2), phase("Synthesize", 1), phase("Critique", 1)];

  function agent(n: number, agentPhase: string | null): AgentView {
    return {
      n,
      label: `agent-${n}`,
      phase: agentPhase,
      backend: "codex",
      model: null,
      status: "running",
      startTs: 0,
      endTs: null,
      activity: null,
      usage: u(0),
      threadId: null,
      error: null,
      resultRef: null,
      activityCount: 0,
    };
  }
  const AGENTS: AgentView[] = [
    agent(1, "Read"),
    agent(2, "Read"),
    agent(3, "Synthesize"),
    agent(4, "Critique"),
    agent(5, null), // phase-less agent: visible only under "All"
  ];

  describe("clampPhaseFilter", () => {
    it("clamps at both ends without wrapping ('All' at 0, last phase at phaseCount)", () => {
      expect(clampPhaseFilter(0, 3)).toBe(0);
      expect(clampPhaseFilter(2, 3)).toBe(2);
      expect(clampPhaseFilter(3, 3)).toBe(3);
      expect(clampPhaseFilter(4, 3)).toBe(3); // → past the last tab stays put
      expect(clampPhaseFilter(-1, 3)).toBe(0); // ← past "All" stays put
    });

    it("zero phases: every step lands back on All, so ←/→ are no-ops", () => {
      expect(clampPhaseFilter(0 + 1, 0)).toBe(0); // → from All
      expect(clampPhaseFilter(0 - 1, 0)).toBe(0); // ← from All
      expect(clampPhaseFilter(99, 0)).toBe(0);
    });

    it("survives garbage indexes", () => {
      expect(clampPhaseFilter(Number.NaN, 3)).toBe(0);
      expect(clampPhaseFilter(1.9, 3)).toBe(1); // truncates, never invents a tab
    });
  });

  describe("phaseFilterTitle", () => {
    it("maps 0 → All (null) and i → phases[i-1]", () => {
      expect(phaseFilterTitle(PHASES, 0)).toBeNull();
      expect(phaseFilterTitle(PHASES, 1)).toBe("Read");
      expect(phaseFilterTitle(PHASES, 3)).toBe("Critique");
    });

    it("clamps out-of-range indexes instead of exploding", () => {
      expect(phaseFilterTitle(PHASES, 99)).toBe("Critique");
      expect(phaseFilterTitle(PHASES, -5)).toBeNull();
      expect(phaseFilterTitle([], 2)).toBeNull();
    });
  });

  describe("filterAgentsByPhase", () => {
    it("All (index 0) returns the identical unfiltered list", () => {
      expect(filterAgentsByPhase(AGENTS, PHASES, 0)).toBe(AGENTS);
    });

    it("a phase tab shows only that phase's agents", () => {
      expect(filterAgentsByPhase(AGENTS, PHASES, 1).map((a) => a.n)).toEqual([1, 2]);
      expect(filterAgentsByPhase(AGENTS, PHASES, 2).map((a) => a.n)).toEqual([3]);
      expect(filterAgentsByPhase(AGENTS, PHASES, 3).map((a) => a.n)).toEqual([4]);
    });

    it("null-phase agents appear only under All", () => {
      for (let i = 1; i <= PHASES.length; i++) {
        expect(filterAgentsByPhase(AGENTS, PHASES, i).some((a) => a.phase === null)).toBe(false);
      }
      expect(filterAgentsByPhase(AGENTS, PHASES, 0)).toContain(AGENTS[4]);
    });

    it("out-of-range indexes clamp: past the end → last phase, below zero → All", () => {
      expect(filterAgentsByPhase(AGENTS, PHASES, 42).map((a) => a.n)).toEqual([4]);
      expect(filterAgentsByPhase(AGENTS, PHASES, -3)).toBe(AGENTS);
    });

    it("no phases: every index behaves like All", () => {
      expect(filterAgentsByPhase(AGENTS, [], 0)).toBe(AGENTS);
      expect(filterAgentsByPhase(AGENTS, [], 1)).toBe(AGENTS);
    });

    // Regression: the cards tier renders the filtered list verbatim, so the
    // visible-list derivation must never drop finished agents (the old
    // ok-card collapse hid the oldest ✔ agents behind a "(N more ✔)" line).
    it("never drops ok agents — a card-tier list of 8 with 7 finished keeps all 8 by name", () => {
      const eight: AgentView[] = [
        ...Array.from({ length: 7 }, (_, i) => ({ ...agent(i + 1, "Read"), status: "ok" as const })),
        agent(8, "Read"),
      ];
      const onePhase = [phase("Read", 8)];
      expect(filterAgentsByPhase(eight, onePhase, 0)).toBe(eight); // All: identical list
      expect(filterAgentsByPhase(eight, onePhase, 1).map((a) => a.n)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });
  });

  it("works on state folded from real journal events (incl. a phase-less agent)", () => {
    const events: JournalEvent[] = [
      ...midRunEvents(),
      {
        t: "agent_start",
        ts: 2700,
        n: 5,
        label: "orphan",
        phase: null,
        backend: "codex",
        model: "gpt-5.4",
        effort: null,
        promptSha: "p5",
        promptRef: "agents/5-orphan/prompt.md",
        hasSchema: false,
      },
    ];
    const st = fold(events);
    const agents = [...st.agents.values()].sort((a, b) => a.n - b.n);
    // meta seeds [Summarize, Critique]; agents 1-4 are Summarize, 5 has no phase
    expect(filterAgentsByPhase(agents, st.phases, 0).map((a) => a.n)).toEqual([1, 2, 3, 4, 5]);
    expect(filterAgentsByPhase(agents, st.phases, 1).map((a) => a.n)).toEqual([1, 2, 3, 4]);
    expect(filterAgentsByPhase(agents, st.phases, 2)).toEqual([]); // Critique not started yet
  });
});

describe("run-view row budgeting (format.computeContentBudget)", () => {
  it("reserves fixed chrome and returns the rest to the agent list (running run)", () => {
    // header(1) + phase(1) + list-spacer(1) + footer(2) = 5 chrome, no narrator.
    expect(computeContentBudget(24)).toEqual({ agentRows: 19, resultRows: 0 });
    expect(computeContentBudget(10)).toEqual({ agentRows: 5, resultRows: 0 });
  });

  it("charges the runner-dead banner and the narrator strip (spacer + one row per line)", () => {
    // base chrome 5, + banner 1, + narrator spacer 1 + 4 lines = 11 → 24-11=13.
    expect(computeContentBudget(24, { runnerDeadBanner: true, narratorLines: 4 })).toEqual({
      agentRows: 13,
      resultRows: 0,
    });
    // narratorLines 0 hides the whole strip (no spacer charged).
    expect(computeContentBudget(24, { narratorLines: 0 }).agentRows).toBe(19);
  });

  it("splits content between the agent list and result pane on finished runs", () => {
    // 24 rows, chrome 5 → content 19. Result chrome 4; tail = min(20, floor(19/2)=9, 15) = 9.
    // agentRows = 19 - 4 - 9 = 6.
    expect(computeContentBudget(24, { hasResultPane: true })).toEqual({ agentRows: 6, resultRows: 9 });
  });

  it("caps the result tail at RESULT_TAIL_MAX even on very tall terminals", () => {
    const b = computeContentBudget(200, { hasResultPane: true });
    expect(b.resultRows).toBe(RESULT_TAIL_MAX);
    // The agent list soaks up the rest of the tall screen.
    expect(b.agentRows).toBeGreaterThan(RESULT_TAIL_MAX);
  });

  it("never returns negative rows and collapses gracefully at tiny sizes", () => {
    const tiny = computeContentBudget(3, { hasResultPane: true, narratorLines: 4 });
    expect(tiny.agentRows).toBeGreaterThanOrEqual(0);
    expect(tiny.resultRows).toBeGreaterThanOrEqual(0);
    expect(computeContentBudget(0)).toEqual({ agentRows: 0, resultRows: 0 });
    expect(computeContentBudget(Number.NaN)).toEqual({ agentRows: 0, resultRows: 0 });
    expect(computeContentBudget(-5)).toEqual({ agentRows: 0, resultRows: 0 });
  });

  it("agent list + result-pane (tail + its own chrome) fit inside the content budget", () => {
    for (let rows = 0; rows <= 120; rows++) {
      const b = computeContentBudget(rows, { hasResultPane: true, narratorLines: 4 });
      // Fixed chrome: header+phase+list-spacer(3) + narrator(spacer+4=5) + footer(2) = 10.
      const content = Math.max(0, rows - 10);
      const resultChrome = 4; // spacer + round border (2) + title
      // The two content consumers plus the pane's own chrome stay within the
      // content region — so the whole view fits once the terminal has ≥ ~14 rows.
      expect(b.agentRows + b.resultRows + resultChrome).toBeLessThanOrEqual(content + resultChrome);
      expect(b.agentRows + b.resultRows).toBeLessThanOrEqual(content);
      expect(b.agentRows).toBeGreaterThanOrEqual(0);
      expect(b.resultRows).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("agent-list windowing (format.windowAgents)", () => {
  const list = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  it("returns the whole list with no markers when capacity ≥ count", () => {
    expect(windowAgents(list(5), 0, 5)).toEqual({ slice: [0, 1, 2, 3, 4], above: 0, below: 0 });
    expect(windowAgents(list(5), 2, 99)).toEqual({ slice: [0, 1, 2, 3, 4], above: 0, below: 0 });
    // Identity when it fits: same array reference is fine for React keys.
    const items = list(3);
    expect(windowAgents(items, 1, 3).slice).toBe(items);
  });

  it("empty list and zero capacity render nothing", () => {
    expect(windowAgents([], 0, 10)).toEqual({ slice: [], above: 0, below: 0 });
    expect(windowAgents(list(5), 2, 0)).toEqual({ slice: [], above: 0, below: 0 });
  });

  it("selection near the top keeps the top edge and clips only below", () => {
    const w = windowAgents(list(10), 0, 4);
    expect(w.above).toBe(0);
    expect(w.slice[0]).toBe(0);
    expect(w.slice).toContain(0); // selected item present
    expect(w.below).toBeGreaterThan(0);
    // markers + slice fit the capacity
    expect(w.slice.length + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0)).toBeLessThanOrEqual(4);
  });

  it("selection near the bottom keeps the bottom edge and clips only above", () => {
    const w = windowAgents(list(10), 9, 4);
    expect(w.below).toBe(0);
    expect(w.slice[w.slice.length - 1]).toBe(9);
    expect(w.slice).toContain(9);
    expect(w.above).toBeGreaterThan(0);
    expect(w.slice.length + (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0)).toBeLessThanOrEqual(4);
  });

  it("selection in the middle clips both sides and stays centered around it", () => {
    const w = windowAgents(list(20), 10, 5);
    expect(w.above).toBeGreaterThan(0);
    expect(w.below).toBeGreaterThan(0);
    expect(w.slice).toContain(10);
    expect(w.slice.length + 2).toBeLessThanOrEqual(5); // two markers + slice ≤ cap
  });

  it("capacity 1 always shows the selected item (markers dropped, no overflow)", () => {
    const w = windowAgents(list(10), 5, 1);
    expect(w.slice).toEqual([5]);
    // No room for markers alongside the mandatory selected row.
    expect(w.above).toBe(0);
    expect(w.below).toBe(0);
  });

  it("out-of-range and fractional selection indexes clamp into the list", () => {
    expect(windowAgents(list(6), -3, 3).slice).toContain(0);
    expect(windowAgents(list(6), 99, 3).slice).toContain(5);
    expect(windowAgents(list(6), 2.9, 3).slice).toContain(2);
  });

  it("invariants hold for every list/selection/capacity combination", () => {
    for (let n = 0; n <= 24; n++) {
      const items = list(n);
      for (let sel = -1; sel <= n + 1; sel++) {
        for (let cap = 0; cap <= 26; cap++) {
          const { slice, above, below } = windowAgents(items, sel, cap);
          if (n === 0 || cap === 0) {
            expect(slice).toEqual([]);
            expect(above).toBe(0);
            expect(below).toBe(0);
            continue;
          }
          // Rendered rows (slice + one row per shown marker) never exceed cap.
          const rendered = slice.length + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0);
          expect(rendered).toBeLessThanOrEqual(cap);
          // The (clamped) selection is always visible.
          const s = Math.max(0, Math.min(n - 1, sel < 0 ? 0 : sel > n - 1 ? n - 1 : Math.trunc(sel)));
          expect(slice).toContain(s);
          // The slice is always a contiguous window whose first element sits at
          // the true count of items hidden above it.
          expect(slice.length).toBeGreaterThan(0);
          for (let i = 1; i < slice.length; i++) expect(slice[i]).toBe(slice[i - 1]! + 1);
          const trueAbove = slice[0]!;
          const trueBelow = n - (slice[slice.length - 1]! + 1);
          // above/below report marker counts: truthful whenever the marker would
          // fit, else suppressed to 0. Suppression is only allowed when there is
          // genuinely no room — the mandatory selected item plus the real markers
          // would exceed cap (the degenerate cap 1, or cap 2 clipped both sides).
          const trueMarkers = (trueAbove > 0 ? 1 : 0) + (trueBelow > 0 ? 1 : 0);
          if (slice.length + trueMarkers <= cap) {
            expect(above).toBe(trueAbove);
            expect(below).toBe(trueBelow);
          } else {
            // Forced suppression: only when the window is at its minimum.
            expect(slice.length).toBe(1);
            expect(above).toBe(0);
            expect(below).toBe(0);
          }
          if (cap >= n) {
            expect(above).toBe(0);
            expect(below).toBe(0);
            expect(slice.length).toBe(n);
          }
        }
      }
    }
  });
});

describe("status line summary (lightweight doctor)", () => {
  it("reports the catch-all backend and its default model for the default config", () => {
    const s = summarizeConfig(DEFAULT_CONFIG);
    expect(s.ok).toBe(true);
    expect(s.backend).toBe("codex");
    expect(s.model).toBe("gpt-5.6-sol");
    expect(s.extraBackends).toEqual([]);
  });

  it("surfaces extra routed backends distinct from the default", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      route: [
        { pattern: "judge:*", backend: "claude" },
        { pattern: "impl:*", backend: "opencode" },
        { pattern: "*", backend: "codex" },
      ],
    };
    const s = summarizeConfig(cfg);
    expect(s.backend).toBe("codex");
    expect(s.model).toBe("gpt-5.6-sol");
    expect(s.extraBackends).toEqual(["claude", "opencode"]);
  });

  it("uses the claude default model when claude is the catch-all", () => {
    const cfg = { ...DEFAULT_CONFIG, route: [{ pattern: "*", backend: "claude" }] };
    const s = summarizeConfig(cfg);
    expect(s.backend).toBe("claude");
    expect(s.model).toBe(DEFAULT_CONFIG.claude.defaultModel);
  });
});
