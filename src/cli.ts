#!/usr/bin/env node
import { Command } from "commander";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENTS_DIR,
  ARGS_SNAPSHOT,
  OPTIONS_SNAPSHOT,
  RUNNER_LOG_FILE,
  SCRIPT_SNAPSHOT,
  SIGTERM_GRACE_MS,
  WORKFLOWS_DIR_NAME,
  defaultConcurrency,
} from "./constants.js";
import { loadConfig } from "./config.js";
import { appendControl } from "./control.js";
import { newRunId } from "./ids.js";
import { readJournal, tailJournal } from "./journal.js";
import {
  createRunDir,
  isRunDead,
  listRuns,
  pidAlive,
  readPid,
  resolveRunId,
  runnerPidAlive,
  runsDir,
  stateDir,
} from "./rundir.js";
import { syncSkills } from "./skills.js";
import { validateWorkflowScript, type ValidationIssue } from "./validate.js";
import { AppServerClient } from "./appserver/client.js";
import { fmtDuration, fmtTokens } from "./tui/format.js";
import { initialState, reduce, type TuiState } from "./tui/reducer.js";
import { renderRunStatic } from "./tui/static.js";
import { runTui } from "./tui/index.js";
import type {
  JournalEvent,
  RunEndEvent,
  RunOptions,
  RunSummary,
  UltracodexConfig,
} from "./types.js";

class CliError extends Error {}

// ---------------------------------------------------------------------------
// Small exported helpers (unit-tested)
// ---------------------------------------------------------------------------

/** "500k" → 500_000, "1.5m" → 1_500_000, "12345" → 12345. Garbage → throws. */
export function parseBudget(input: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(input.trim());
  const bad = (): CliError =>
    new CliError(`invalid budget "${input}" (use e.g. 500k, 1.5m, or a plain token count)`);
  if (!m) throw bad();
  const mult = m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1;
  const n = Math.round(parseFloat(m[1]!) * mult);
  if (!Number.isFinite(n) || n <= 0) throw bad();
  return n;
}

/** Resolve a script path or a saved workflow name to an absolute script path. */
export function resolveScript(projectDir: string, ref: string): string {
  const asPath = path.resolve(projectDir, ref);
  try {
    if (fs.statSync(asPath).isFile()) return asPath;
  } catch {
    // not a file path
  }
  const saved = path.join(stateDir(projectDir), WORKFLOWS_DIR_NAME, `${ref}.js`);
  try {
    if (fs.statSync(saved).isFile()) return saved;
  } catch {
    // not a saved workflow either
  }
  throw new CliError(`cannot resolve script "${ref}": tried ${asPath} and saved workflow ${saved}`);
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function issueLine(i: ValidationIssue): string {
  return `${i.severity}${i.line !== undefined ? ` [line ${i.line}]` : ""}: ${i.message}`;
}

function runDirOf(projectDir: string, ref: string): { runId: string; runDir: string } {
  const runId = resolveRunId(projectDir, ref);
  return { runId, runDir: path.join(runsDir(projectDir), runId) };
}

function foldJournal(runDir: string): TuiState {
  let state = initialState();
  for (const ev of readJournal(runDir)) state = reduce(state, ev);
  return state;
}

function hasRunEnd(runDir: string): boolean {
  return readJournal(runDir).some((e) => e.t === "run_end");
}

function runnerJsPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "runner.js");
}

export function spawnRunner(runDir: string): number | null {
  const logFd = fs.openSync(path.join(runDir, RUNNER_LOG_FILE), "a");
  try {
    const child = spawn(process.execPath, [runnerJsPath(), runDir], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child.pid ?? null;
  } finally {
    fs.closeSync(logFd);
  }
}

const DEAD_RUNNER_CHECKS = 6; // × 500ms — grace for runner startup before "dead"

/**
 * Tail the journal until run_end. Resolves "dead" when the runner exits without
 * one, "timeout" past opts.timeoutMs. onEvent sees every event, run_end included.
 */
function tailRun(
  runDir: string,
  opts?: { onEvent?: (ev: JournalEvent) => void; timeoutMs?: number },
): Promise<RunEndEvent | "dead" | "timeout"> {
  return new Promise((resolve) => {
    let done = false;
    let deadChecks = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: RunEndEvent | "dead" | "timeout"): void => {
      if (done) return;
      done = true;
      stopTail();
      clearInterval(liveness);
      if (timer !== null) clearTimeout(timer);
      resolve(v);
    };
    const stopTail = tailJournal(
      runDir,
      (ev) => {
        opts?.onEvent?.(ev);
        if (ev.t === "run_end") finish(ev);
      },
      { pollMs: 200 },
    );
    const liveness = setInterval(() => {
      const pid = readPid(runDir);
      if (pid !== null && runnerPidAlive(runDir, pid)) {
        deadChecks = 0;
        return;
      }
      deadChecks += 1;
      if (deadChecks >= DEAD_RUNNER_CHECKS) {
        const end = readJournal(runDir).find((e) => e.t === "run_end") as RunEndEvent | undefined;
        finish(end ?? "dead");
      }
    }, 500);
    if (opts?.timeoutMs !== undefined) {
      timer = setTimeout(() => finish("timeout"), opts.timeoutMs);
    }
  });
}

/**
 * Journal-sourced text (labels, activity, log lines, errors) is agent/script
 * controlled — untrusted for terminals. Strip ANSI escape sequences (CSI, OSC,
 * other ESC-prefixed) and map raw control characters (including CR/LF) to
 * spaces so it can neither forge output lines nor restyle the terminal.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g, "") // OSC ... BEL/ST
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]?/g, "") // CSI
    .replace(/\u001b[\s\S]?/g, "") // any other ESC sequence
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " "); // raw control chars (incl. CR/LF) -> space
}

export function fmtEvent(ev: JournalEvent): string | null {
  const s = sanitizeText;
  switch (ev.t) {
    case "run_start":
      return `run ${ev.runId} [${s(ev.meta.name)}] started (concurrency ${ev.concurrency}${ev.budgetTotal !== null ? `, budget ${fmtTokens(ev.budgetTotal)}` : ""})`;
    case "phase":
      return `phase ▸ ${s(ev.title)}`;
    case "agent_start":
      return `agent ${ev.n} [${s(ev.label)}] started (${s(ev.backend)}${ev.model ? ` ${s(ev.model)}` : ""}${ev.effort ? ` ${s(ev.effort)}` : ""})`;
    case "agent_thread":
      return `agent ${ev.n} thread ${s(ev.threadId)}`;
    case "agent_activity":
      return `agent ${ev.n} ${ev.kind}: ${s(ev.text)}`;
    case "agent_usage":
      return null;
    case "agent_end":
      return `agent ${ev.n} ${ev.status}${ev.error ? `: ${s(ev.error)}` : ""} (${fmtDuration(ev.ms)}, ${fmtTokens(ev.usage.outputTokens)} out tok)`;
    case "log":
      return `log: ${s(ev.text)}`;
    case "warn":
      return `warn: ${s(ev.text)}`;
    case "paused":
      return "paused";
    case "resumed":
      return "resumed";
    case "run_end":
      return `run ${ev.status}${ev.error ? `: ${s(ev.error)}` : ""} (${ev.totals.ok} ok / ${ev.totals.failed} failed / ${ev.totals.skipped} skipped, ${fmtDuration(ev.totals.ms)})`;
  }
}

async function watchToEnd(runDir: string): Promise<void> {
  const end = await tailRun(runDir, {
    onEvent: (ev) => {
      const line = fmtEvent(ev);
      if (line !== null) process.stdout.write(line + "\n");
    },
  });
  if (end === "dead") {
    process.stderr.write("runner exited before run_end\n");
    process.exitCode = 1;
  } else if (end !== "timeout" && end.status !== "ok") {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface RunCliOpts {
  args?: string;
  budget?: string;
  watch?: boolean;
  detach?: boolean;
  json?: boolean;
  strict?: boolean;
  concurrency?: string;
}

async function runAction(scriptOrName: string, opts: RunCliOpts): Promise<void> {
  const projectDir = process.cwd();
  const scriptPath = resolveScript(projectDir, scriptOrName);
  const source = fs.readFileSync(scriptPath, "utf8");

  const issues = validateWorkflowScript(source, { strict: !!opts.strict });
  const errors = issues.filter((i) => i.severity === "error");
  if (!opts.json) {
    for (const i of issues.filter((x) => x.severity === "warn")) {
      process.stderr.write(issueLine(i) + "\n");
    }
  }
  if (errors.length > 0) {
    for (const i of errors) process.stderr.write(issueLine(i) + "\n");
    throw new CliError(`validation failed with ${errors.length} error(s)`);
  }

  let argsValue: unknown;
  if (opts.args !== undefined) {
    try {
      argsValue = JSON.parse(opts.args);
    } catch (err) {
      throw new CliError(`--args is not valid JSON: ${errMsg(err)}`);
    }
  }
  const budgetTotal = opts.budget !== undefined ? parseBudget(opts.budget) : null;
  let concurrency: number;
  if (opts.concurrency !== undefined) {
    concurrency = Number(opts.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new CliError(`--concurrency must be a positive integer (got "${opts.concurrency}")`);
    }
  } else {
    concurrency = loadConfig(projectDir).concurrency ?? defaultConcurrency();
  }

  const runId = newRunId();
  const runDir = createRunDir(projectDir, runId);
  fs.writeFileSync(path.join(runDir, SCRIPT_SNAPSHOT), source, "utf8");
  let argsPath: string | null = null;
  if (opts.args !== undefined) {
    fs.writeFileSync(path.join(runDir, ARGS_SNAPSHOT), JSON.stringify(argsValue, null, 2), "utf8");
    argsPath = ARGS_SNAPSHOT;
  }
  const options: RunOptions = {
    runId,
    runDir,
    scriptPath: path.join(runDir, SCRIPT_SNAPSHOT),
    argsPath,
    budgetTotal,
    concurrency,
    strict: !!opts.strict,
    projectDir,
  };
  fs.writeFileSync(path.join(runDir, OPTIONS_SNAPSHOT), JSON.stringify(options, null, 2), "utf8");
  spawnRunner(runDir);

  if (opts.json) {
    const end = await tailRun(runDir);
    if (end === "dead" || end === "timeout") {
      process.stdout.write(
        JSON.stringify({ status: "failed", error: "runner exited before run_end" }) + "\n",
      );
      process.exitCode = 1;
      return;
    }
    if (end.status === "ok" && end.resultRef !== null) {
      process.stdout.write(fs.readFileSync(path.join(runDir, end.resultRef), "utf8"));
      return;
    }
    process.stdout.write(JSON.stringify({ status: end.status, error: end.error }) + "\n");
    process.exitCode = 1;
    return;
  }
  if (opts.detach) {
    process.stdout.write(runId + "\n");
    return;
  }
  if (opts.watch || !process.stdout.isTTY) {
    await watchToEnd(runDir);
    return;
  }
  await runTui({ projectDir, runDir });
}

// ---------------------------------------------------------------------------
// ls / show / attach
// ---------------------------------------------------------------------------

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd())
    .join("\n");
}

/**
 * ELAPSED cell for `ls`. Dead runs (crashed, no run_end) freeze at the last
 * journal event instead of ticking from Date.now() forever.
 */
export function lsElapsed(r: Pick<RunSummary, "runDir" | "status" | "startedAt" | "endedAt">): string {
  if (r.startedAt === null) return "-";
  if (r.endedAt !== null) return fmtDuration(r.endedAt - r.startedAt);
  if (r.status === "dead") {
    const events = readJournal(r.runDir);
    const last = events.length > 0 ? events[events.length - 1]!.ts : r.startedAt;
    return last > r.startedAt ? fmtDuration(last - r.startedAt) : "-";
  }
  return fmtDuration(Date.now() - r.startedAt);
}

function lsAction(): void {
  const runs = listRuns(process.cwd());
  if (runs.length === 0) {
    process.stdout.write("no runs\n");
    return;
  }
  const rows: string[][] = [["RUN ID", "NAME", "STATUS", "ELAPSED", "AGENTS", "TOKENS"]];
  for (const r of runs) {
    rows.push([
      r.runId,
      r.name !== null ? sanitizeText(r.name) : "-",
      r.status,
      lsElapsed(r),
      `${r.agentsDone}/${r.agentsTotal}`,
      fmtTokens(r.outputTokens),
    ]);
  }
  process.stdout.write(table(rows) + "\n");
}

interface ShowCliOpts {
  json?: boolean;
  wait?: boolean;
  timeoutMs?: string;
}

async function showAction(ref: string, opts: ShowCliOpts): Promise<void> {
  let timeoutMs: number | undefined;
  if (opts.timeoutMs !== undefined) {
    timeoutMs = Number(opts.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new CliError(`--timeout-ms must be a positive integer (got "${opts.timeoutMs}")`);
    }
  }
  const projectDir = process.cwd();
  const { runId, runDir } = runDirOf(projectDir, ref);
  // A dead run (run_start, no run_end, runner pid gone) is terminal: never wait on it.
  if (opts.wait && !hasRunEnd(runDir) && !isRunDead(runDir)) {
    const end = await tailRun(runDir, timeoutMs !== undefined ? { timeoutMs } : {});
    if (end === "timeout") {
      process.stderr.write(`timed out waiting for run ${runId} to end\n`);
      process.exitCode = 2;
      return;
    }
    // end === "dead" (or run_end): fall through — the fold below reports it.
  }
  const state = foldJournal(runDir);
  const dead = state.status === "running" && isRunDead(runDir);
  if (opts.json) {
    let result: unknown = null;
    if (state.resultRef !== null) {
      try {
        result = JSON.parse(fs.readFileSync(path.join(runDir, state.resultRef), "utf8"));
      } catch {
        result = null;
      }
    }
    process.stdout.write(
      JSON.stringify(
        {
          runId,
          status: dead ? "dead" : state.status,
          result,
          error: dead ? (state.error ?? "runner exited before run_end") : state.error,
          totals: state.totals,
        },
        null,
        2,
      ) + "\n",
    );
    if (dead) process.exitCode = 1;
    return;
  }
  process.stdout.write(renderRunStatic(state) + "\n");
  if (dead) {
    process.stderr.write(`run ${runId} is dead: runner exited before run_end\n`);
    process.exitCode = 1;
  }
}

async function attachAction(ref: string): Promise<void> {
  const projectDir = process.cwd();
  const { runDir } = runDirOf(projectDir, ref);
  await runTui({ projectDir, runDir });
}

// ---------------------------------------------------------------------------
// pause / resume / skip / kill
// ---------------------------------------------------------------------------

function requireAliveRun(ref: string): { runId: string; runDir: string; pid: number } {
  const { runId, runDir } = runDirOf(process.cwd(), ref);
  const pid = readPid(runDir);
  // runnerPidAlive also rejects a recycled pid now owned by a foreign process.
  if (pid === null || !runnerPidAlive(runDir, pid)) {
    throw new CliError(`runner exited (run ${runId})`);
  }
  return { runId, runDir, pid };
}

function pauseAction(ref: string): void {
  const { runId, runDir } = requireAliveRun(ref);
  appendControl(runDir, { cmd: "pause" });
  process.stdout.write(`pause requested for ${runId}\n`);
}

function resumeAction(ref: string): void {
  const { runId, runDir } = requireAliveRun(ref);
  appendControl(runDir, { cmd: "resume" });
  process.stdout.write(`resume requested for ${runId}\n`);
}

function skipAction(ref: string, nArg: string): void {
  const n = Number(nArg);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(`agent ordinal must be a positive integer (got "${nArg}")`);
  }
  const { runId, runDir } = requireAliveRun(ref);
  appendControl(runDir, { cmd: "skip", n });
  process.stdout.write(`skip requested for agent ${n} of ${runId}\n`);
}

async function waitEnded(runDir: string, pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (hasRunEnd(runDir) || !pidAlive(pid)) return true;
    await sleep(150);
  }
  return false;
}

async function killAction(ref: string): Promise<void> {
  const { runId, runDir } = runDirOf(process.cwd(), ref);
  if (hasRunEnd(runDir)) {
    process.stdout.write(`run ${runId} already ended\n`);
    return;
  }
  const pid = readPid(runDir);
  if (pid === null || !pidAlive(pid)) {
    throw new CliError(`runner exited (run ${runId})`);
  }
  // Never signal a pid we cannot verify as this run's runner: after a crash
  // the OS may have recycled it for an unrelated process.
  if (!runnerPidAlive(runDir, pid)) {
    throw new CliError(
      `runner exited (run ${runId}); pid ${pid} now belongs to another process — not signaling`,
    );
  }
  appendControl(runDir, { cmd: "stop" });
  if (await waitEnded(runDir, pid, SIGTERM_GRACE_MS)) {
    process.stdout.write(`run ${runId} stopped gracefully\n`);
    return;
  }
  if (!runnerPidAlive(runDir, pid)) {
    process.stdout.write(`run ${runId} runner exited\n`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // raced with exit
  }
  if (await waitEnded(runDir, pid, SIGTERM_GRACE_MS)) {
    process.stdout.write(`run ${runId} terminated (SIGTERM)\n`);
    return;
  }
  if (!runnerPidAlive(runDir, pid)) {
    process.stdout.write(`run ${runId} runner exited\n`);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // raced with exit
  }
  process.stdout.write(`run ${runId} killed (SIGKILL)\n`);
}

// ---------------------------------------------------------------------------
// logs / validate / sync-skills / doctor
// ---------------------------------------------------------------------------

function logsAction(ref: string, nArg?: string): void {
  const { runId, runDir } = runDirOf(process.cwd(), ref);
  if (nArg !== undefined) {
    const n = Number(nArg);
    if (!Number.isInteger(n) || n < 1) {
      throw new CliError(`agent ordinal must be a positive integer (got "${nArg}")`);
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(runDir, AGENTS_DIR));
    } catch {
      entries = [];
    }
    const entry = entries.find((e) => e.startsWith(`${n}-`));
    if (!entry) throw new CliError(`no agent ${n} in run ${runId}`);
    const eventsPath = path.join(runDir, AGENTS_DIR, entry, "events.jsonl");
    try {
      process.stdout.write(fs.readFileSync(eventsPath, "utf8"));
    } catch {
      throw new CliError(`no events recorded for agent ${n} of ${runId}`);
    }
    return;
  }
  let content: string;
  try {
    content = fs.readFileSync(path.join(runDir, RUNNER_LOG_FILE), "utf8");
  } catch {
    throw new CliError(`no runner.log for ${runId}`);
  }
  if (content.length === 0) {
    process.stderr.write(
      `runner log for ${runId} is empty (a clean run writes nothing here) — try \`logs ${runId} <n>\` for per-agent events\n`,
    );
    return;
  }
  process.stdout.write(content);
}

function validateAction(script: string, opts: { strict?: boolean }): void {
  const scriptPath = resolveScript(process.cwd(), script);
  const issues = validateWorkflowScript(fs.readFileSync(scriptPath, "utf8"), {
    strict: !!opts.strict,
  });
  for (const i of issues) process.stdout.write(issueLine(i) + "\n");
  if (issues.length === 0) process.stdout.write("ok: no issues\n");
  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.length - errors;
  if (errors > 0 || (opts.strict && warns > 0)) process.exitCode = 1;
}

function syncSkillsAction(): void {
  const { written } = syncSkills(process.cwd());
  if (written.length === 0) {
    process.stdout.write("no workflows found (nothing written)\n");
    return;
  }
  for (const file of written) process.stdout.write(file + "\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CliError(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

function execFileP(
  bin: string,
  args: string[],
  opts: { timeout: number },
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: opts.timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

const DOCTOR_PROBE_TIMEOUT_MS = 5_000;

async function doctorAction(): Promise<void> {
  const projectDir = process.cwd();
  let hardFail = false;
  const report = (ok: boolean, label: string, detail: string, hint?: string): void => {
    process.stdout.write(`${ok ? "✔" : "✖"} ${label}: ${detail}\n`);
    if (!ok && hint) process.stdout.write(`  → ${hint}\n`);
  };

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeOk = nodeMajor >= 20;
  if (!nodeOk) hardFail = true;
  report(nodeOk, "node", `v${process.versions.node}`, "install Node 20 or newer");

  let config: UltracodexConfig | null = null;
  try {
    config = loadConfig(projectDir);
    const routes = config.route.map((r) => `${r.pattern} → ${r.backend}`).join(", ");
    report(
      true,
      "config",
      `route [${routes}]; codex model ${config.codex.defaultModel}; claude model ${config.claude.defaultModel}`,
    );
  } catch (err) {
    hardFail = true;
    report(false, "config", errMsg(err), "fix .ultracodex/config.toml (or ~/.ultracodex/config.toml)");
  }

  const binary = config?.codex.binary ?? "codex";
  let binaryOk = false;
  try {
    const { stdout } = await execFileP(binary, ["--version"], {
      timeout: DOCTOR_PROBE_TIMEOUT_MS,
    });
    binaryOk = true;
    report(true, "codex binary", `${binary} (${stdout.trim()})`);
  } catch (err) {
    hardFail = true;
    report(
      false,
      "codex binary",
      `cannot run "${binary} --version": ${errMsg(err)}`,
      "install the Codex CLI (npm i -g @openai/codex) or set [backends.codex].binary in config.toml",
    );
  }

  if (binaryOk) {
    const startP = AppServerClient.start({ binary, cwd: projectDir });
    try {
      const client = await withTimeout(startP, DOCTOR_PROBE_TIMEOUT_MS, "app-server initialize");
      try {
        const account = await client.request<{ account: { type?: string; email?: string; planType?: string } | null }>(
          "account/read",
          {},
          { timeoutMs: DOCTOR_PROBE_TIMEOUT_MS },
        );
        report(true, "app-server", "initialize + account/read responded");
        if (account.account) {
          const who = [account.account.email, account.account.planType].filter(Boolean).join(", ");
          report(true, "auth", `logged in${who ? ` (${who})` : ""}`);
        } else {
          report(false, "auth", "logged out", "run `codex login` (or set OPENAI_API_KEY)");
        }
      } finally {
        client.kill();
      }
    } catch (err) {
      hardFail = true;
      startP.then((c) => c.kill()).catch(() => {});
      report(
        false,
        "app-server",
        errMsg(err),
        "check `codex app-server` runs by hand; ultracodex is pinned against codex 0.142.4",
      );
    }
  }

  try {
    const dir = stateDir(projectDir);
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe);
    report(true, "state dir", `${dir} writable`);
  } catch (err) {
    hardFail = true;
    report(false, "state dir", errMsg(err), "check permissions on .ultracodex/");
  }

  if (hardFail) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Program assembly
// ---------------------------------------------------------------------------

function act<A extends unknown[]>(
  fn: (...args: A) => void | Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      process.stderr.write(`error: ${errMsg(err)}\n`);
      process.exitCode = 1;
    }
  };
}

function packageVersion(): string {
  // dist/cli.js → ../package.json in both the repo and the installed layout;
  // never hardcode (0.1.1 shipped reporting itself as 0.1.0).
  try {
    const req = createRequire(import.meta.url);
    return (req("../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ultracodex")
    .description("Run Claude Code workflow scripts unmodified on the OpenAI Codex CLI")
    .version(packageVersion());

  program
    .command("run")
    .argument("<scriptOrName>", "workflow script path or saved workflow name")
    .option("--args <json>", "workflow args as a JSON value")
    .option("--budget <amount>", "output-token budget (500k, 1.5m, or a number)")
    .option("--watch", "plain line-per-event output until the run ends")
    .option("--detach", "start the run and print its runId")
    .option("--json", "wait for the run and print the result JSON to stdout")
    .option("--strict", "upstream-strict mode (bans Date.now/Math.random/new Date())")
    .option("--concurrency <n>", "max concurrent agents")
    .description("start a workflow run (detached runner process)")
    .action(act(runAction));

  program.command("ls").description("list runs").action(act(lsAction));

  program
    .command("show")
    .argument("<ref>", "runId or unique prefix")
    .option("--json", "machine-readable output")
    .option("--wait", "block until run_end")
    .option("--timeout-ms <n>", "with --wait: give up (exit 2) after N ms")
    .description("render a run's journal (static)")
    .action(act(showAction));

  program
    .command("attach")
    .argument("<ref>", "runId or unique prefix")
    .description("open the TUI on a run")
    .action(act(attachAction));

  program
    .command("pause")
    .argument("<ref>", "runId or unique prefix")
    .description("soft-pause a run (stops launching new agents)")
    .action(act(pauseAction));

  program
    .command("resume")
    .argument("<ref>", "runId or unique prefix")
    .description("resume a paused run")
    .action(act(resumeAction));

  program
    .command("skip")
    .argument("<ref>", "runId or unique prefix")
    .argument("<n>", "agent ordinal to skip")
    .description("skip agent n (resolves to null)")
    .action(act(skipAction));

  program
    .command("kill")
    .argument("<ref>", "runId or unique prefix")
    .description("stop a run: control stop → SIGTERM → SIGKILL")
    .action(act(killAction));

  program
    .command("logs")
    .argument("<ref>", "runId or unique prefix")
    .argument("[n]", "agent ordinal (raw agent events); omit for runner.log")
    .description("print raw logs for a run or one of its agents")
    .action(act(logsAction));

  program
    .command("validate")
    .argument("<script>", "workflow script path or saved workflow name")
    .option("--strict", "treat upstream determinism bans as errors")
    .description("lint a script for dual-runnability")
    .action(act(validateAction));

  program
    .command("sync-skills")
    .description("generate .claude/skills/* from saved workflows")
    .action(act(syncSkillsAction));

  program
    .command("doctor")
    .description("check node, the codex binary, app-server auth, and config")
    .action(act(doctorAction));

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  if (argv.length <= 2) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        "the TUI needs an interactive terminal — try `ultracodex ls`, `ultracodex show <ref>`, or `ultracodex --help`\n",
      );
      process.exitCode = 1;
      return;
    }
    await runTui({ projectDir: process.cwd() });
    return;
  }
  await buildProgram().parseAsync(argv);
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    if (import.meta.url === pathToFileURL(entry).href) return true;
  } catch {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    process.stderr.write(`error: ${errMsg(err)}\n`);
    process.exitCode = 1;
  });
}
