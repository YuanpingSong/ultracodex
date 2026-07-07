import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  STATE_DIR_NAME,
  RUNS_DIR_NAME,
  PID_FILE,
  AGENTS_DIR,
} from "./constants.js";
import { slugify } from "./ids.js";
import { readJournal } from "./journal.js";
import type { RunSummary, RunTotals, Usage } from "./types.js";
import { ZERO_USAGE, addUsage } from "./types.js";

export function stateDir(projectDir: string): string {
  return path.join(projectDir, STATE_DIR_NAME);
}

export function runsDir(projectDir: string): string {
  return path.join(stateDir(projectDir), RUNS_DIR_NAME);
}

export function createRunDir(projectDir: string, runId: string): string {
  const runDir = path.join(runsDir(projectDir), runId);
  fs.mkdirSync(path.join(runDir, AGENTS_DIR), { recursive: true });
  return runDir;
}

export function writePidFile(runDir: string, pid: number): void {
  fs.writeFileSync(path.join(runDir, PID_FILE), String(pid), "utf8");
}

export function readPid(runDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(runDir, PID_FILE), "utf8").trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort command line of a live process; null when it cannot be read. */
function pidCommandLine(pid: number): string | null {
  try {
    // Linux: NUL-separated argv (empty for zombies → fall through to ps).
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (raw.length > 0) return raw.split("\0").join(" ");
  } catch {
    // no /proc (macOS/BSD) or unreadable
  }
  try {
    const out = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (out.status === 0 && typeof out.stdout === "string" && out.stdout.trim().length > 0) {
      return out.stdout.trim();
    }
  } catch {
    // ps unavailable
  }
  return null;
}

function activeChildCommandLine(pid: number): string | null {
  const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.();
  for (const h of handles ?? []) {
    const child = h as { pid?: unknown; spawnargs?: unknown };
    if (
      child.pid === pid &&
      Array.isArray(child.spawnargs) &&
      child.spawnargs.every((arg) => typeof arg === "string")
    ) {
      return child.spawnargs.join(" ");
    }
  }
  return null;
}

function commandLineMatchesRunDir(cmd: string, runDir: string): boolean {
  return cmd.includes(path.resolve(runDir));
}

/**
 * True when `pid` is alive AND verifiably this run's runner process — its
 * command line mentions the run directory path, which the CLI passes as the
 * runner's argv. Guards against the OS recycling a crashed
 * runner's pid: an alive-but-foreign pid is NOT a live runner. When the
 * command line cannot be inspected, falls back to plain pid liveness.
 */
export function runnerPidAlive(runDir: string, pid: number): boolean {
  if (!pidAlive(pid)) return false;
  const cmd = pidCommandLine(pid);
  if (cmd !== null) return commandLineMatchesRunDir(cmd, runDir);
  if (pid === process.pid) return commandLineMatchesRunDir(process.argv.join(" "), runDir);
  const childCmd = activeChildCommandLine(pid);
  if (childCmd !== null) return commandLineMatchesRunDir(childCmd, runDir);
  return true;
}

/**
 * Shared "dead" rule (cli.ts reuses this): a run is dead iff its journal has
 * run_start, no run_end, and its pid is not verifiably a live runner.
 */
export function isRunDead(runDir: string): boolean {
  let hasStart = false;
  for (const ev of readJournal(runDir)) {
    if (ev.t === "run_start") hasStart = true;
    else if (ev.t === "run_end") return false;
  }
  if (!hasStart) return false;
  const pid = readPid(runDir);
  return pid === null || !runnerPidAlive(runDir, pid);
}

export function agentDir(runDir: string, n: number, label: string): string {
  const dirName = `${n}-${slugify(label)}`;
  const dir = path.join(runDir, AGENTS_DIR, dirName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sumUsage(usage: Record<string, Usage>): number {
  let total = 0;
  for (const u of Object.values(usage)) {
    total += u.outputTokens;
  }
  return total;
}

export function listRuns(projectDir: string): RunSummary[] {
  const dir = runsDir(projectDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const summaries: RunSummary[] = [];

  for (const runId of entries) {
    const runDir = path.join(dir, runId);
    try {
      const stat = fs.statSync(runDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const events = readJournal(runDir);

    let name: string | null = null;
    let startedAt: number | null = null;
    let endedAt: number | null = null;
    let runStatus: RunSummary["status"] | null = null;
    let agentsDone = 0;
    let agentsTotal = 0;
    let outputTokens = 0;
    let totals: RunTotals | null = null;

    // Per-agent usage accumulator (fallback when no run_end totals)
    const agentUsage: Record<number, Usage> = {};

    for (const ev of events) {
      if (ev.t === "run_start") {
        name = ev.meta.name;
        startedAt = ev.ts;
      } else if (ev.t === "agent_start") {
        agentsTotal++;
      } else if (ev.t === "agent_end") {
        agentsDone++;
        agentUsage[ev.n] = ev.usage;
      } else if (ev.t === "agent_usage") {
        agentUsage[ev.n] = ev.usage;
      } else if (ev.t === "run_end") {
        endedAt = ev.ts;
        runStatus = ev.status;
        totals = ev.totals;
      }
    }

    // Compute outputTokens
    if (totals) {
      outputTokens = sumUsage(totals.usage);
    } else {
      // Sum from agent_end usage
      let combined: Usage = ZERO_USAGE;
      for (const u of Object.values(agentUsage)) {
        combined = addUsage(combined, u);
      }
      outputTokens = combined.outputTokens;
    }

    const pid = readPid(runDir);
    const rawAlive = pid !== null && pidAlive(pid);
    // Without a run_end, "alive" additionally requires the pid to verifiably
    // be this run's runner (guards OS pid reuse flipping a dead run back to
    // "running").
    const alive =
      pid !== null && rawAlive && (runStatus !== null || runnerPidAlive(runDir, pid));

    if (runStatus === null && pid !== null && !rawAlive) {
      // Crashed runner left a stale pidfile; clean it so the pid can never be
      // mistaken for a recycled live process later.
      try {
        fs.rmSync(path.join(runDir, PID_FILE), { force: true });
      } catch {
        // pidfile is advisory
      }
    }

    let status: RunSummary["status"];
    if (runStatus !== null) {
      status = runStatus;
    } else if (alive) {
      status = "running";
    } else {
      status = "dead";
    }

    summaries.push({
      runId,
      runDir,
      name,
      status,
      startedAt,
      endedAt,
      agentsDone,
      agentsTotal,
      outputTokens,
      pid,
      pidAlive: alive,
    });
  }

  // Sort by newest startedAt first; null timestamps go to end
  summaries.sort((a, b) => {
    if (a.startedAt === null && b.startedAt === null) return 0;
    if (a.startedAt === null) return 1;
    if (b.startedAt === null) return -1;
    return b.startedAt - a.startedAt;
  });

  return summaries;
}

export function resolveRunId(projectDir: string, ref: string): string {
  const dir = runsDir(projectDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    throw new Error(`no run matching "${ref}" (runs directory does not exist)`);
  }

  // Exact match
  if (entries.includes(ref)) {
    const runDir = path.join(dir, ref);
    try {
      if (fs.statSync(runDir).isDirectory()) return ref;
    } catch {}
  }

  // Prefix match
  const matches = entries.filter((e) => {
    try {
      return e.startsWith(ref) && fs.statSync(path.join(dir, e)).isDirectory();
    } catch {
      return false;
    }
  });

  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    const list = matches.join(", ");
    throw new Error(`ambiguous run id "${ref}": ${list}`);
  }
  throw new Error(`no run matching "${ref}"`);
}
