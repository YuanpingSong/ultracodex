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
    const alive = pid !== null ? pidAlive(pid) : false;

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
