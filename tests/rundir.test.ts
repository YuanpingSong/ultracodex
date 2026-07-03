import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stateDir,
  runsDir,
  createRunDir,
  writePidFile,
  readPid,
  pidAlive,
  agentDir,
  listRuns,
  resolveRunId,
} from "../src/rundir.js";
import { JournalWriter } from "../src/journal.js";
import { AGENTS_DIR, STATE_DIR_NAME, RUNS_DIR_NAME } from "../src/constants.js";
import type { JournalEvent } from "../src/types.js";

const cleanups: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-rundir-"));
  cleanups.push(d);
  return d;
}

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try { fs.rmSync(d, { recursive: true }); } catch {}
  }
});

describe("stateDir / runsDir", () => {
  it("returns correct paths", () => {
    const proj = "/some/project";
    expect(stateDir(proj)).toBe(`/some/project/${STATE_DIR_NAME}`);
    expect(runsDir(proj)).toBe(`/some/project/${STATE_DIR_NAME}/${RUNS_DIR_NAME}`);
  });
});

describe("createRunDir", () => {
  it("creates run dir and agents subdir", () => {
    const proj = tmpDir();
    const runId = "uc_abc123";
    const runDir = createRunDir(proj, runId);

    expect(fs.existsSync(runDir)).toBe(true);
    expect(fs.existsSync(path.join(runDir, AGENTS_DIR))).toBe(true);
    expect(runDir).toBe(path.join(proj, STATE_DIR_NAME, RUNS_DIR_NAME, runId));
  });
});

describe("writePidFile / readPid", () => {
  it("writes and reads back pid", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_pid1");
    writePidFile(runDir, 12345);
    expect(readPid(runDir)).toBe(12345);
  });

  it("returns null when pid file missing", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_nopid");
    expect(readPid(runDir)).toBeNull();
  });

  it("returns null for malformed pid file", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_badpid");
    fs.writeFileSync(path.join(runDir, "pid"), "not-a-number", "utf8");
    expect(readPid(runDir)).toBeNull();
  });
});

describe("pidAlive", () => {
  it("returns true for the current process pid", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("returns false for a bogus pid (9999999)", () => {
    expect(pidAlive(9999999)).toBe(false);
  });
});

describe("agentDir", () => {
  it("creates a slugified directory under agents/", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_agt1");
    const dir = agentDir(runDir, 1, "My Critic Agent");
    expect(fs.existsSync(dir)).toBe(true);
    // slug: my-critic-agent
    expect(path.basename(dir)).toBe("1-my-critic-agent");
  });

  it("handles special characters in label", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_agt2");
    const dir = agentDir(runDir, 2, "agent/with:special chars!");
    expect(fs.existsSync(dir)).toBe(true);
    // slug should be safe dir name
    const base = path.basename(dir);
    expect(base).toMatch(/^2-[a-z0-9-]+$/);
  });
});

describe("listRuns", () => {
  it("returns empty array when no runs exist", () => {
    const proj = tmpDir();
    expect(listRuns(proj)).toEqual([]);
  });

  it("folds journal to produce RunSummary", () => {
    const proj = tmpDir();
    const runId = "uc_fold1";
    const runDir = createRunDir(proj, runId);

    const w = new JournalWriter(runDir);
    const startTs = 1700000000000;
    const endTs = 1700000010000;

    const events: JournalEvent[] = [
      {
        t: "run_start",
        ts: startTs,
        runId,
        meta: { name: "my-workflow", description: "desc" },
        scriptSha: "sha",
        argsRef: null,
        budgetTotal: null,
        concurrency: 4,
      },
      {
        t: "agent_start",
        ts: startTs + 1000,
        n: 1,
        label: "worker",
        phase: null,
        backend: "codex",
        model: "gpt-5.4",
        effort: "medium",
        promptSha: "pssha",
        promptRef: "agents/1-worker/prompt.md",
        hasSchema: false,
      },
      {
        t: "agent_end",
        ts: startTs + 5000,
        n: 1,
        status: "ok",
        ms: 4000,
        usage: {
          totalTokens: 200,
          inputTokens: 150,
          cachedInputTokens: 10,
          outputTokens: 50,
          reasoningOutputTokens: 0,
        },
        resultRef: "agents/1-worker/output.txt",
        error: null,
      },
      {
        t: "run_end",
        ts: endTs,
        status: "ok",
        resultRef: "result.json",
        error: null,
        totals: {
          agents: 1,
          ok: 1,
          failed: 0,
          skipped: 0,
          usage: {
            codex: {
              totalTokens: 200,
              inputTokens: 150,
              cachedInputTokens: 10,
              outputTokens: 50,
              reasoningOutputTokens: 0,
            },
          },
          ms: 10000,
        },
      },
    ];

    for (const ev of events) w.append(ev);
    w.close();

    const runs = listRuns(proj);
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.runId).toBe(runId);
    expect(r.name).toBe("my-workflow");
    expect(r.status).toBe("ok");
    expect(r.startedAt).toBe(startTs);
    expect(r.endedAt).toBe(endTs);
    expect(r.agentsDone).toBe(1);
    expect(r.agentsTotal).toBe(1);
    // outputTokens from totals.usage
    expect(r.outputTokens).toBe(50);
  });

  it("marks run as 'dead' when no run_end and pid not alive", () => {
    const proj = tmpDir();
    const runId = "uc_dead1";
    const runDir = createRunDir(proj, runId);

    // Write a pid that is definitely not alive
    writePidFile(runDir, 9999999);

    const w = new JournalWriter(runDir);
    w.append({
      t: "run_start",
      ts: 100,
      runId,
      meta: { name: "dead-run", description: "..." },
      scriptSha: "x",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });
    w.close();

    const runs = listRuns(proj);
    const r = runs[0]!;
    expect(r.status).toBe("dead");
  });

  it("marks run as 'running' when no run_end and pid is alive", () => {
    const proj = tmpDir();
    const runId = "uc_alive1";
    const runDir = createRunDir(proj, runId);

    writePidFile(runDir, process.pid);

    const w = new JournalWriter(runDir);
    w.append({
      t: "run_start",
      ts: 200,
      runId,
      meta: { name: "live-run", description: "..." },
      scriptSha: "y",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });
    w.close();

    const runs = listRuns(proj);
    const r = runs[0]!;
    expect(r.status).toBe("running");
    expect(r.pidAlive).toBe(true);
  });

  it("sorts newest startedAt first", () => {
    const proj = tmpDir();

    function makeRun(id: string, ts: number): void {
      const runDir = createRunDir(proj, id);
      const w = new JournalWriter(runDir);
      w.append({
        t: "run_start",
        ts,
        runId: id,
        meta: { name: id, description: "d" },
        scriptSha: "s",
        argsRef: null,
        budgetTotal: null,
        concurrency: 1,
      });
      w.close();
    }

    makeRun("uc_older1", 1000);
    makeRun("uc_newer1", 3000);
    makeRun("uc_mid1", 2000);

    const runs = listRuns(proj);
    expect(runs[0]!.startedAt).toBe(3000);
    expect(runs[1]!.startedAt).toBe(2000);
    expect(runs[2]!.startedAt).toBe(1000);
  });

  it("accumulates outputTokens from agent_end when no run_end", () => {
    const proj = tmpDir();
    const runId = "uc_tokens1";
    const runDir = createRunDir(proj, runId);

    const w = new JournalWriter(runDir);
    w.append({
      t: "run_start",
      ts: 1,
      runId,
      meta: { name: "tok", description: "d" },
      scriptSha: "s",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });
    w.append({
      t: "agent_end",
      ts: 2,
      n: 1,
      status: "ok",
      ms: 100,
      usage: {
        totalTokens: 100,
        inputTokens: 80,
        cachedInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
      },
      resultRef: null,
      error: null,
    });
    w.append({
      t: "agent_end",
      ts: 3,
      n: 2,
      status: "ok",
      ms: 100,
      usage: {
        totalTokens: 60,
        inputTokens: 40,
        cachedInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
      },
      resultRef: null,
      error: null,
    });
    w.close();

    const runs = listRuns(proj);
    expect(runs[0]!.outputTokens).toBe(40); // 20 + 20
  });
});

describe("resolveRunId", () => {
  it("exact match returns the runId", () => {
    const proj = tmpDir();
    createRunDir(proj, "uc_exact1");
    expect(resolveRunId(proj, "uc_exact1")).toBe("uc_exact1");
  });

  it("unique prefix match returns the runId", () => {
    const proj = tmpDir();
    createRunDir(proj, "uc_prefix1abc");
    expect(resolveRunId(proj, "uc_prefix1")).toBe("uc_prefix1abc");
  });

  it("short prefix matches unique run", () => {
    const proj = tmpDir();
    createRunDir(proj, "uc_zzz999");
    expect(resolveRunId(proj, "uc_z")).toBe("uc_zzz999");
  });

  it("ambiguous prefix throws listing candidates", () => {
    const proj = tmpDir();
    createRunDir(proj, "uc_ambig1a");
    createRunDir(proj, "uc_ambig1b");

    expect(() => resolveRunId(proj, "uc_ambig1")).toThrow(/ambiguous/);
    expect(() => resolveRunId(proj, "uc_ambig1")).toThrow(/uc_ambig1a/);
    expect(() => resolveRunId(proj, "uc_ambig1")).toThrow(/uc_ambig1b/);
  });

  it("no match throws with 'no run matching'", () => {
    const proj = tmpDir();
    createRunDir(proj, "uc_other999");
    expect(() => resolveRunId(proj, "uc_zzz999")).toThrow(/no run matching/);
  });

  it("throws when runs dir does not exist", () => {
    const proj = tmpDir();
    expect(() => resolveRunId(proj, "uc_any")).toThrow();
  });
});
