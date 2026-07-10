import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
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
  runnerPidAlive,
  isRunDead,
  agentDir,
  listRuns,
  listRunsReconciled,
  resolveRunId,
} from "../src/rundir.js";
import { JournalWriter } from "../src/journal.js";
import { AGENTS_DIR, PID_FILE, STATE_DIR_NAME, RUNS_DIR_NAME } from "../src/constants.js";
import type { JournalEvent } from "../src/types.js";

const cleanups: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-rundir-"));
  cleanups.push(d);
  return d;
}

const children: ChildProcess[] = [];
/**
 * Long-lived child whose argv carries `marker` — mimics the real runner, whose
 * command line is `node .../runner.js <runDir>` (so it contains the runId).
 */
function spawnMarkerChild(marker: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], {
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(() => {
  vi.useRealTimers();
  for (const c of children.splice(0)) {
    try { c.kill("SIGKILL"); } catch {}
  }
  for (const d of cleanups.splice(0)) {
    try { fs.rmSync(d, { recursive: true }); } catch {}
  }
});

import { pidAlive as _pidAliveCheck } from "../src/rundir.js";

describe("pidAlive across permission boundaries", () => {
  it("treats EPERM as alive (sandbox/other-user processes exist)", () => {
    // pid 1 (launchd/init) exists but cannot be signaled by a normal user:
    // kill(1, 0) yields EPERM on macOS/Linux — the process is alive.
    expect(_pidAliveCheck(1)).toBe(true);
  });
  it("treats ESRCH as dead", () => {
    // find a free pid: spawn+reap leaves its pid unassigned briefly
    expect(_pidAliveCheck(2 ** 22 - 7)).toBe(false);
  });
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

describe("runnerPidAlive", () => {
  it("returns false for a dead pid", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_rpa1");
    expect(runnerPidAlive(runDir, 9999999)).toBe(false);
  });

  it("returns false for an alive pid that is not this run's runner", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_rpa2");
    // The vitest process is alive, but its command line lacks the runId.
    expect(runnerPidAlive(runDir, process.pid)).toBe(false);
  });

  it("returns true for an alive process whose argv mentions the run dir", async () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_rpa3");
    const child = spawnMarkerChild(runDir);
    await sleep(80);
    expect(runnerPidAlive(runDir, child.pid!)).toBe(true);
  });
});

describe("isRunDead", () => {
  function writeStart(runDir: string, runId: string): void {
    const w = new JournalWriter(runDir);
    w.append({
      t: "run_start",
      ts: 1,
      runId,
      meta: { name: runId, description: "d" },
      scriptSha: "s",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });
    w.close();
  }

  it("true: run_start, no run_end, no pid", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_ird1");
    writeStart(runDir, "uc_ird1");
    expect(isRunDead(runDir)).toBe(true);
  });

  it("true: run_start, no run_end, pid recycled by a foreign process", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_ird2");
    writeStart(runDir, "uc_ird2");
    writePidFile(runDir, process.pid);
    expect(isRunDead(runDir)).toBe(true);
  });

  it("false: run_end present", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_ird3");
    const w = new JournalWriter(runDir);
    w.append({
      t: "run_start",
      ts: 1,
      runId: "uc_ird3",
      meta: { name: "n", description: "d" },
      scriptSha: "s",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });
    w.append({
      t: "run_end",
      ts: 2,
      status: "ok",
      resultRef: null,
      error: null,
      totals: { agents: 0, ok: 0, failed: 0, skipped: 0, usage: {}, ms: 1 },
    });
    w.close();
    expect(isRunDead(runDir)).toBe(false);
  });

  it("false: no run_start yet (runner still starting)", () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_ird4");
    expect(isRunDead(runDir)).toBe(false);
  });

  it("false: live runner (argv mentions the run dir)", async () => {
    const proj = tmpDir();
    const runDir = createRunDir(proj, "uc_ird5");
    writeStart(runDir, "uc_ird5");
    const child = spawnMarkerChild(runDir);
    writePidFile(runDir, child.pid!);
    await sleep(80);
    expect(isRunDead(runDir)).toBe(false);
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

  it("reconciles a final run_end during the HomeView/list grace before publishing dead", async () => {
    vi.useFakeTimers();
    const proj = tmpDir();
    const runId = "uc_listflushrace1";
    const runDir = createRunDir(proj, runId);
    const writer = new JournalWriter(runDir);
    writer.append({
      t: "run_start",
      ts: 100,
      runId,
      meta: { name: "flush-race", description: "..." },
      scriptSha: "x",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });

    const pending = listRunsReconciled(proj);
    let published = false;
    void pending.then(() => {
      published = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(published).toBe(false);

    writer.append({
      t: "run_end",
      ts: 200,
      status: "ok",
      resultRef: "result.json",
      error: null,
      totals: { agents: 0, ok: 0, failed: 0, skipped: 0, usage: {}, ms: 100 },
    });
    writer.close();
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject([{ runId, status: "ok" }]);
  });

  it("publishes a runner with no run_end as dead after the list grace", async () => {
    vi.useFakeTimers();
    const proj = tmpDir();
    const runId = "uc_listdeadgrace1";
    const runDir = createRunDir(proj, runId);
    const writer = new JournalWriter(runDir);
    writer.append({
      t: "run_start",
      ts: 100,
      runId,
      meta: { name: "dead-after-grace", description: "..." },
      scriptSha: "x",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });
    writer.close();

    const pending = listRunsReconciled(proj);
    let published = false;
    void pending.then(() => {
      published = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(published).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject([{ runId, status: "dead" }]);
  });

  it("marks run as 'running' when no run_end and its runner pid is alive", async () => {
    const proj = tmpDir();
    const runId = "uc_alive1";
    const runDir = createRunDir(proj, runId);

    // A real runner's command line carries the runDir; simulate that.
    const child = spawnMarkerChild(runDir);
    writePidFile(runDir, child.pid!);
    await sleep(80); // let the child exec

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

  it("marks run as 'dead' when the pid was recycled by an unrelated process", () => {
    const proj = tmpDir();
    const runId = "uc_recycled1";
    const runDir = createRunDir(proj, runId);

    // process.pid (the test runner) is alive but is NOT this run's runner:
    // its command line does not mention the runId.
    writePidFile(runDir, process.pid);

    const w = new JournalWriter(runDir);
    w.append({
      t: "run_start",
      ts: 300,
      runId,
      meta: { name: "recycled-run", description: "..." },
      scriptSha: "z",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });
    w.close();

    const runs = listRuns(proj);
    expect(runs[0]!.status).toBe("dead");
  });

  it("cleans a stale pidfile (dead pid, no run_end) when listing", () => {
    const proj = tmpDir();
    const runId = "uc_stalepid1";
    const runDir = createRunDir(proj, runId);
    writePidFile(runDir, 9999999);

    const w = new JournalWriter(runDir);
    w.append({
      t: "run_start",
      ts: 400,
      runId,
      meta: { name: "stale", description: "..." },
      scriptSha: "s",
      argsRef: null,
      budgetTotal: null,
      concurrency: 1,
    });
    w.close();

    const runs = listRuns(proj);
    expect(runs[0]!.status).toBe("dead");
    expect(fs.existsSync(path.join(runDir, PID_FILE))).toBe(false);
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
