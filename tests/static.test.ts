import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openInEditor, parseEditorCommand } from "../src/tui/clipboard.js";
import { validateBudgetInput } from "../src/tui/HomeView.js";
import { initialState, reduce, type TuiState } from "../src/tui/reducer.js";
import { RUNNER_START_GRACE_MS, runnerLooksDead } from "../src/tui/RunView.js";
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
