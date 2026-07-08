import { describe, expect, it } from "vitest";
import {
  costSparkline,
  deltaPct,
  detectLoops,
  extractRoundVerdict,
  formatLoopHeaderLine,
  formatLoopListRow,
  formatLoopStatus,
  formatLoopTotals,
  formatRoundLedgerRow,
  roundVerdictLabel,
  tokenDeltaPct,
  trajectoryStrip,
  type Round,
} from "../src/tui/loops.js";
import { initialState, reduce, type AgentView, type TuiState } from "../src/tui/reducer.js";
import type {
  AgentEndEvent,
  AgentStartEvent,
  AgentStatus,
  JournalEvent,
  RunStatus,
  Usage,
  WorkflowMeta,
} from "../src/types.js";

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
  name: "demo",
  description: "loop fixture",
  phases: [{ title: "Round 1" }, { title: "Round 2" }],
};

function runStart(meta: WorkflowMeta = META, ts = 1000): JournalEvent {
  return {
    t: "run_start",
    ts,
    runId: "wf_test",
    meta,
    scriptSha: "abc",
    argsRef: null,
    budgetTotal: null,
    concurrency: 4,
  };
}

function agentStart(
  n: number,
  label: string,
  phase: string | null = null,
  ts = 1000 + n * 100,
): AgentStartEvent {
  return {
    t: "agent_start",
    ts,
    n,
    label,
    phase,
    backend: n % 2 === 0 ? "claude" : "codex",
    model: n % 2 === 0 ? "sonnet-5" : "gpt-5.5",
    effort: "medium",
    promptSha: `sha${n}`,
    promptRef: `agents/${n}/prompt.md`,
    hasSchema: false,
  };
}

function agentEnd(
  n: number,
  out: number,
  ts = 2000 + n * 100,
  resultRef: string | null = `agents/${n}/output.json`,
  status: AgentStatus = "ok",
): AgentEndEvent {
  return {
    t: "agent_end",
    ts,
    n,
    status,
    ms: 0,
    usage: u(out),
    resultRef,
    error: status === "failed" ? "failed" : null,
  };
}

function agentUsage(n: number, out: number, ts = 1500): JournalEvent {
  return { t: "agent_usage", ts, n, usage: u(out) };
}

function runEnd(status: RunStatus = "ok", ts = 5000): JournalEvent {
  return {
    t: "run_end",
    ts,
    status,
    resultRef: status === "ok" ? "result.json" : null,
    error: status === "failed" ? "boom" : null,
    totals: { agents: 0, ok: 0, failed: 0, skipped: 0, usage: { codex: u(0) }, ms: ts - 1000 },
  };
}

function fold(events: JournalEvent[]): TuiState {
  return events.reduce(reduce, initialState());
}

function outputs(map: Record<string, string | null>): (resultRef: string) => string | null {
  return (resultRef) => map[resultRef] ?? null;
}

function detected(
  events: JournalEvent[],
  out: Record<string, string | null> = {},
  nowMs?: number,
) {
  return detectLoops(fold(events), outputs(out), nowMs);
}

function agentsWithRefs(refs: Array<string | null>): AgentView[] {
  const events: JournalEvent[] = [runStart()];
  refs.forEach((ref, index) => {
    const n = index + 1;
    events.push(agentStart(n, `agent-r1-${n}`), agentEnd(n, 1, 2000 + n, ref));
  });
  return [...fold(events).agents.values()].sort((a, b) => a.n - b.n);
}

function round(n: number, outputTokens: number, kind: Round["verdict"]["kind"]): Round {
  return { n, agents: [], outputTokens, durationMs: 0, verdict: { kind, text: null } };
}

describe("detectLoops", () => {
  it("detects label-form rounds and puts bare label stems in the implicit loop", () => {
    const loops = detected([
      runStart(),
      agentStart(1, "build-r1"),
      agentEnd(1, 100, 2100, "r1.json"),
      agentStart(2, "build-r2"),
      agentEnd(2, 50, 2200, "r2.json"),
      runEnd(),
    ]);

    expect(loops).toHaveLength(1);
    expect(loops[0]?.id).toBe("demo");
    expect(loops[0]?.rounds.map((r) => r.n)).toEqual([1, 2]);
    expect(loops[0]?.rounds.map((r) => r.outputTokens)).toEqual([100, 50]);
    expect(loops[0]?.totalTokens).toBe(150);
  });

  it("detects phase-form rounds with and without a stem", () => {
    const loops = detected([
      runStart(),
      agentStart(1, "alpha", "Round 1"),
      agentEnd(1, 10, 2100, "implicit-r1.json"),
      agentStart(2, "beta", "Round-2"),
      agentEnd(2, 20, 2200, "implicit-r2.json"),
      agentStart(3, "review-a", "Review Round 1"),
      agentEnd(3, 30, 2300, "review-r1.json"),
      agentStart(4, "review-b", "Review — Round 2"),
      agentEnd(4, 40, 2400, "review-r2.json"),
      runEnd(),
    ]);

    expect(loops.map((loop) => loop.id)).toEqual(["demo", "Review"]);
    expect(loops.find((loop) => loop.id === "demo")?.rounds.map((r) => r.n)).toEqual([1, 2]);
    expect(loops.find((loop) => loop.id === "Review")?.rounds.map((r) => r.n)).toEqual([1, 2]);
  });

  it("uses the label marker when both label and phase match", () => {
    const loops = detected([
      runStart(),
      agentStart(1, "goal:build-r1", "Review Round 7"),
      agentEnd(1, 10, 2100, "r1.json"),
      agentStart(2, "goal:build-r2", "Review Round 8"),
      agentEnd(2, 10, 2200, "r2.json"),
      runEnd(),
    ]);

    expect(loops).toHaveLength(1);
    expect(loops[0]?.id).toBe("goal");
    expect(loops[0]?.rounds.map((r) => r.n)).toEqual([1, 2]);
  });

  it("groups colon stems by the parent before the last colon and extracts verifier verdicts", () => {
    const loops = detected(
      [
        runStart(),
        agentStart(1, "goal:build-r1", null, 1000),
        agentStart(2, "goal:verify-r1", null, 1100),
        agentEnd(1, 48_900, 19_000, "build-r1.json"),
        agentEnd(2, 12_500, 21_000, "verify-r1.json"),
        agentStart(3, "goal:build-r2", null, 22_000),
        agentStart(4, "goal:verify-r2", null, 23_000),
        agentEnd(3, 20_000, 30_000, "build-r2.json"),
        agentEnd(4, 10_000, 31_000, "verify-r2.json"),
        runEnd("ok", 32_000),
      ],
      {
        "build-r1.json": JSON.stringify({ verdict: "approved" }),
        "verify-r1.json": JSON.stringify({ verdict: "rejected", issues: ["tests missing", "no docs"] }),
        "verify-r2.json": JSON.stringify({ verdict: "PASS", summary: "done" }),
      },
    );

    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    expect(loop.id).toBe("goal");
    expect(loop.status).toBe("converged");
    expect(loop.convergedAt).toBe(2);
    expect(loop.rounds.map((r) => r.agents.map((a) => a.label))).toEqual([
      ["goal:build-r1", "goal:verify-r1"],
      ["goal:build-r2", "goal:verify-r2"],
    ]);
    expect(loop.rounds[0]?.verdict).toEqual({ kind: "rejected", text: "tests missing; no docs" });
    expect(loop.rounds[1]?.verdict).toEqual({ kind: "approved", text: "done" });
  });

  it("detects separate loops through distinct colon parents", () => {
    const loops = detected([
      runStart(),
      agentStart(1, "gate:a-r1"),
      agentEnd(1, 1, 2100, "gate-r1.json"),
      agentStart(2, "gate:a-r2"),
      agentEnd(2, 1, 2200, "gate-r2.json"),
      agentStart(3, "review:b-r1"),
      agentEnd(3, 1, 2300, "review-r1.json"),
      agentStart(4, "review:b-r2"),
      agentEnd(4, 1, 2400, "review-r2.json"),
      runEnd(),
    ]);

    expect(loops.map((loop) => loop.id)).toEqual(["gate", "review"]);
  });

  it("joins different bare label stems into one implicit loop", () => {
    const loops = detected([
      runStart(),
      agentStart(1, "draft-r1"),
      agentEnd(1, 10, 2100, "draft-r1.json"),
      agentStart(2, "verify-r1"),
      agentEnd(2, 20, 2200, "verify-r1.json"),
      agentStart(3, "inspect-r2"),
      agentEnd(3, 30, 2300, "inspect-r2.json"),
      runEnd(),
    ]);

    expect(loops).toHaveLength(1);
    expect(loops[0]?.id).toBe("demo");
    expect(loops[0]?.rounds.map((r) => r.agents.map((a) => a.label))).toEqual([
      ["draft-r1", "verify-r1"],
      ["inspect-r2"],
    ]);
  });

  it("rejects one-round ended runs but keeps one-round running loops with deterministic now", () => {
    const ended = detected([
      runStart(),
      agentStart(1, "check-r1", null, 1000),
      agentEnd(1, 10, 2000, "check-r1.json"),
      runEnd(),
    ]);
    expect(ended).toEqual([]);

    const running = detected(
      [runStart(), agentStart(1, "check-r1", null, 1000), agentUsage(1, 42, 1500)],
      {},
      2500,
    );
    expect(running).toHaveLength(1);
    expect(running[0]?.status).toBe("running");
    expect(running[0]?.rounds[0]?.durationMs).toBe(1500);
    expect(running[0]?.rounds[0]?.outputTokens).toBe(42);
  });

  it("ends a finished loop that does not approve the last round", () => {
    const loops = detected(
      [
        runStart(),
        agentStart(1, "goal:verify-r1"),
        agentEnd(1, 10, 2100, "r1.json"),
        agentStart(2, "goal:verify-r2"),
        agentEnd(2, 10, 2200, "r2.json"),
        runEnd("failed"),
      ],
      {
        "r1.json": JSON.stringify({ verdict: "approved" }),
        "r2.json": JSON.stringify({ verdict: "no", reason: "still failing" }),
      },
    );

    expect(loops[0]?.status).toBe("ended");
    expect(loops[0]?.convergedAt).toBeNull();
    expect(loops[0]?.rounds[1]?.verdict).toEqual({ kind: "rejected", text: "still failing" });
  });
});

describe("extractRoundVerdict", () => {
  it("uses the highest ordinal parseable JSON result", () => {
    const agents = agentsWithRefs(["build.json", "verify.json"]);
    expect(
      extractRoundVerdict(
        agents,
        outputs({
          "build.json": JSON.stringify({ verdict: "approved" }),
          "verify.json": JSON.stringify({ verdict: "failed", issues: ["criteria 2/4", "tests missing"] }),
        }),
      ),
    ).toEqual({ kind: "rejected", text: "criteria 2/4; tests missing" });
  });

  it("handles approved string enums and unknown verdict strings", () => {
    expect(extractRoundVerdict(agentsWithRefs(["yes.json"]), outputs({ "yes.json": '{"verdict":"YES"}' }))).toEqual({
      kind: "approved",
      text: null,
    });
    expect(
      extractRoundVerdict(agentsWithRefs(["maybe.json"]), outputs({ "maybe.json": '{"verdict":"maybe","summary":"ignored"}' })),
    ).toEqual({ kind: "unknown", text: "maybe" });
  });

  it("uses boolean fields in contract priority order", () => {
    expect(
      extractRoundVerdict(
        agentsWithRefs(["bool.json"]),
        outputs({ "bool.json": JSON.stringify({ ok: true, approved: false, reason: "approved wins first" }) }),
      ),
    ).toEqual({ kind: "rejected", text: "approved wins first" });

    expect(
      extractRoundVerdict(
        agentsWithRefs(["bool.json"]),
        outputs({ "bool.json": JSON.stringify({ approved: "yes", pass: true, note: "pass is first boolean" }) }),
      ),
    ).toEqual({ kind: "approved", text: "pass is first boolean" });
  });

  it("extracts verdict text from issues, note, reason, then summary and truncates it", () => {
    expect(
      extractRoundVerdict(agentsWithRefs(["issues.json"]), outputs({ "issues.json": JSON.stringify({ ok: true, issues: ["a", "b"] }) })),
    ).toEqual({ kind: "approved", text: "a; b" });
    expect(
      extractRoundVerdict(agentsWithRefs(["note.json"]), outputs({ "note.json": JSON.stringify({ ok: true, note: "noted" }) })),
    ).toEqual({ kind: "approved", text: "noted" });
    expect(
      extractRoundVerdict(agentsWithRefs(["reason.json"]), outputs({ "reason.json": JSON.stringify({ ok: true, reason: "because" }) })),
    ).toEqual({ kind: "approved", text: "because" });
    expect(
      extractRoundVerdict(agentsWithRefs(["summary.json"]), outputs({ "summary.json": JSON.stringify({ ok: true, summary: "summary" }) })),
    ).toEqual({ kind: "approved", text: "summary" });

    const long = "x".repeat(140);
    const verdict = extractRoundVerdict(
      agentsWithRefs(["long.json"]),
      outputs({ "long.json": JSON.stringify({ ok: true, summary: long }) }),
    );
    expect(verdict.text).toHaveLength(120);
    expect(verdict.text?.endsWith("…")).toBe(true);
  });

  it("never throws on malformed, absent, non-json, thrown, or oversized output", () => {
    expect(extractRoundVerdict(agentsWithRefs(["bad.json"]), outputs({ "bad.json": "{nope" }))).toEqual({
      kind: "unknown",
      text: null,
    });
    expect(extractRoundVerdict(agentsWithRefs(["missing.json"]), outputs({}))).toEqual({
      kind: "unknown",
      text: null,
    });
    expect(extractRoundVerdict(agentsWithRefs(["note.txt"]), outputs({ "note.txt": '{"verdict":"approved"}' }))).toEqual({
      kind: "unknown",
      text: null,
    });
    expect(
      extractRoundVerdict(agentsWithRefs(["throws.json"]), () => {
        throw new Error("read failed");
      }),
    ).toEqual({ kind: "unknown", text: null });
    expect(
      extractRoundVerdict(agentsWithRefs(["oversized.json"]), outputs({ "oversized.json": "x".repeat(256 * 1024 + 1) })),
    ).toEqual({ kind: "unknown", text: null });
  });

  it("skips malformed or oversized higher ordinals and keeps walking backward", () => {
    const agents = agentsWithRefs(["valid.json", "oversized.json", "bad.json"]);
    expect(
      extractRoundVerdict(
        agents,
        outputs({
          "valid.json": JSON.stringify({ converged: true, note: "lower ordinal fallback" }),
          "oversized.json": "x".repeat(256 * 1024 + 1),
          "bad.json": "{",
        }),
      ),
    ).toEqual({ kind: "approved", text: "lower ordinal fallback" });
  });
});

describe("loop display helpers", () => {
  it("renders verdict trajectory strips, including running rounds and caps", () => {
    const runningAgent = fold([runStart(), agentStart(1, "live-r4")]).agents.get(1)!;
    const rounds: Round[] = [
      round(1, 10, "rejected"),
      round(2, 10, "rejected"),
      round(3, 10, "approved"),
      { ...round(4, 10, "unknown"), agents: [runningAgent] },
    ];

    expect(trajectoryStrip(rounds.slice(0, 3))).toBe("✖ ✖ ✔");
    expect(trajectoryStrip(rounds, "⠋")).toBe("✖ ✖ ✔ ⠋");
    expect(trajectoryStrip(rounds, "⠋", 2)).toBe("… ✔ ⠋");
  });

  it("renders contract cost sparklines", () => {
    const fixture = [round(1, 61_400, "rejected"), round(2, 52_700, "rejected"), round(3, 34_100, "approved")];
    expect(costSparkline(fixture)).toBe("█▇▅");
    expect(costSparkline([round(1, 0, "unknown"), round(2, 0, "unknown")])).toBe("▁▁");
    expect(costSparkline([])).toBe("");
  });

  it("scales cost sparklines to the maximum supplied round outputTokens", () => {
    expect(costSparkline([round(1, 10, "unknown"), round(2, 20, "unknown"), round(3, 30, "unknown")])).toBe("▃▆█");
  });

  it("formats total and ledger token deltas", () => {
    expect(deltaPct(61_400, 34_100)).toBe("↓44%");
    expect(deltaPct(100, 125)).toBe("↑25%");
    expect(deltaPct(0, 10)).toBe("—");
    expect(deltaPct(10, 10)).toBe("0%");

    expect(tokenDeltaPct(undefined, 61_400)).toBe("—");
    expect(tokenDeltaPct(61_400, 52_700)).toBe("−14%");
    expect(tokenDeltaPct(52_700, 34_100)).toBe("−35%");
    expect(tokenDeltaPct(100, 120)).toBe("+20%");
  });

  it("formats loop status and totals for future views", () => {
    const loops = detected(
      [
        runStart(),
        agentStart(1, "goal:verify-r1", null, 1000),
        agentEnd(1, 1000, 2000, "r1.json"),
        agentStart(2, "goal:verify-r2", null, 3000),
        agentEnd(2, 2000, 4500, "r2.json"),
        runEnd(),
      ],
      {
        "r2.json": JSON.stringify({ verdict: "approved" }),
      },
    );
    const loop = loops[0]!;

    expect(formatLoopStatus(loop)).toBe("✔ converged after 2 rounds");
    expect(formatLoopTotals(loop)).toBe("3.0k tok · 2.5s");
  });

  it("formats LoopView/HomeView rows with ledger token deltas", () => {
    const loops = detected(
      [
        runStart(META, 0),
        agentStart(1, "goal:build-r1", null, 0),
        agentStart(2, "goal:verify-r1", null, 10_000),
        agentEnd(1, 48_900, 190_000, "build-r1.json"),
        agentEnd(2, 12_500, 242_000, "verify-r1.json"),
        agentStart(3, "goal:build-r2", null, 250_000),
        agentStart(4, "goal:verify-r2", null, 260_000),
        agentEnd(3, 40_000, 450_000, "build-r2.json"),
        agentEnd(4, 12_700, 478_000, "verify-r2.json"),
        agentStart(5, "goal:build-r3", null, 480_000),
        agentStart(6, "goal:verify-r3", null, 490_000),
        agentEnd(5, 25_000, 650_000, "build-r3.json"),
        agentEnd(6, 9_100, 702_000, "verify-r3.json"),
        runEnd("ok", 710_000),
      ],
      {
        "verify-r1.json": JSON.stringify({ verdict: "rejected", issues: ["tests missing", "no docs"] }),
        "verify-r2.json": JSON.stringify({ verdict: "failed", reason: "still off" }),
        "verify-r3.json": JSON.stringify({ verdict: "approved", summary: "done" }),
      },
    );
    const loop = loops[0]!;

    expect(formatLoopHeaderLine(loop, "wf_7fk2qd")).toBe(
      "goal · wf_7fk2qd · ✔ converged after 3 rounds · 148.2k tok · 11m 32s",
    );
    expect(formatLoopListRow({ runId: "wf_7fk2qd", loop, selected: true })).toBe(
      "❯ ✔ wf_7fk2qd goal · ✖ ✖ ✔ · converged r3 · 148k · 11m",
    );
    expect(roundVerdictLabel(loop.rounds[0]!)).toBe("✖ rejected");
    expect(formatRoundLedgerRow(loop, 0, true)).toBe("❯ r1   ✖ rejected 2      61.4k   —      4m02s");
    expect(formatRoundLedgerRow(loop, 1, false)).toBe("  r2   ✖ rejected 2      52.7k   −14%   3m48s");
    expect(formatRoundLedgerRow(loop, 2, false)).toBe("  r3   ✔ approved 2      34.1k   −35%   3m42s");
  });
});
