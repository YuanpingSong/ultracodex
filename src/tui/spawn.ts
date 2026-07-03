import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARGS_SNAPSHOT,
  OPTIONS_SNAPSHOT,
  RUNNER_LOG_FILE,
  SCRIPT_SNAPSHOT,
  defaultConcurrency,
} from "../constants.js";
import { newRunId } from "../ids.js";
import { createRunDir } from "../rundir.js";
import type { RunOptions } from "../types.js";

export interface PrepareRunArgs {
  projectDir: string;
  scriptSource: string;
  /** undefined → no args.json snapshot. */
  args?: unknown;
  budgetTotal?: number | null;
  concurrency?: number;
  strict?: boolean;
}

/** Create run dir + snapshots (script.js, args.json, options.json). Mirrors `cli run`. */
export function prepareRun(a: PrepareRunArgs): { runId: string; runDir: string } {
  const runId = newRunId();
  const runDir = createRunDir(a.projectDir, runId);
  const scriptPath = path.join(runDir, SCRIPT_SNAPSHOT);
  fs.writeFileSync(scriptPath, a.scriptSource, "utf8");
  let argsPath: string | null = null;
  if (a.args !== undefined) {
    argsPath = path.join(runDir, ARGS_SNAPSHOT);
    fs.writeFileSync(argsPath, JSON.stringify(a.args, null, 2), "utf8");
  }
  const options: RunOptions = {
    runId,
    runDir,
    scriptPath,
    argsPath,
    budgetTotal: a.budgetTotal ?? null,
    concurrency: a.concurrency ?? defaultConcurrency(),
    strict: a.strict ?? false,
    projectDir: a.projectDir,
  };
  fs.writeFileSync(path.join(runDir, OPTIONS_SNAPSHOT), JSON.stringify(options, null, 2), "utf8");
  return { runId, runDir };
}

/** dist/tui/spawn.js → dist/runner.js at runtime. */
export function runnerPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "runner.js");
}

/** Detached runner: node runner.js <runDir>, stdio → runner.log, unref. */
export function spawnRunner(runDir: string, opts?: { runnerJs?: string }): number | null {
  const logFd = fs.openSync(path.join(runDir, RUNNER_LOG_FILE), "a");
  try {
    const child = spawn(process.execPath, [opts?.runnerJs ?? runnerPath(), runDir], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(logFd);
  }
}

/** Re-run a finished run: snapshot script/args/options from the old dir into a new one. */
export function rerunFromDir(projectDir: string, oldRunDir: string): { runId: string; runDir: string } {
  const scriptSource = fs.readFileSync(path.join(oldRunDir, SCRIPT_SNAPSHOT), "utf8");
  let args: unknown = undefined;
  try {
    args = JSON.parse(fs.readFileSync(path.join(oldRunDir, ARGS_SNAPSHOT), "utf8"));
  } catch {
    // no args snapshot
  }
  let budgetTotal: number | null = null;
  let concurrency: number | undefined;
  let strict = false;
  try {
    const old = JSON.parse(fs.readFileSync(path.join(oldRunDir, OPTIONS_SNAPSHOT), "utf8")) as RunOptions;
    budgetTotal = old.budgetTotal;
    concurrency = old.concurrency;
    strict = old.strict;
  } catch {
    // defaults
  }
  const prepared = prepareRun({ projectDir, scriptSource, args, budgetTotal, concurrency, strict });
  spawnRunner(prepared.runDir);
  return prepared;
}
