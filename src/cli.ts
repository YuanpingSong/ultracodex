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
  TESTED_CODEX_VERSION,
  TESTED_OPENCODE_VERSION,
  defaultConcurrency,
} from "./constants.js";
import { loadConfig, resolveCodexEffort, resolveCodexModel } from "./config.js";
import { parse as parseToml } from "smol-toml";
import os from "node:os";
import pc from "picocolors";
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
import { resolveScript } from "./workflows.js";
import { AppServerClient } from "./appserver/client.js";
import { fmtDuration, fmtTokens } from "./tui/format.js";
import { makeAgentOutputReader } from "./tui/loopFiles.js";
import { initialState, reduce, type TuiState } from "./tui/reducer.js";
import { renderRunStatic } from "./tui/static.js";
import { runTui } from "./tui/index.js";
import {
  CRONTAB_FILE_ENV,
  countScheduleCrontabLines,
  installScheduleCrontabLine,
  projectHash8,
  readCrontab,
  removeScheduleCrontabLine,
  taggedCrontabLines,
} from "./schedule/crontab.js";
import { addSchedule, type ScheduleAddOpts } from "./schedule/add.js";
import { execSchedule } from "./schedule/exec.js";
import {
  appendScheduleLog,
  checkMissedSchedules,
  humanSchedule,
  listScheduleSpecs,
  readScheduleSpec,
  removeScheduleSpec,
  schedulesDir,
  validateScheduleName,
  writeScheduleSpec,
  type ScheduleSpec,
} from "./schedule/spec.js";
import { askAgent } from "./org/ask.js";
import { runOrgAudit } from "./org/audit.js";
import { formatFinding as formatOrgFinding, jsonFindings, lintTree } from "./org/lint.js";
import { deliver as deliverOrgMessage } from "./org/router.js";
import { runOrgReplay } from "./org/replay.js";
import { executeTick, statusOverview } from "./org/scheduler.js";
import { formatScaffoldReport, initOrg } from "./org/scaffold.js";
import { listTickets } from "./org/tickets.js";
import { wakeAgent } from "./org/wake.js";
import type {
  JournalEvent,
  RunEndEvent,
  RunOptions,
  RunSummary,
  UltracodexConfig,
} from "./types.js";

class CliError extends Error {}

export { resolveScript };

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

function cliEntryPath(): string {
  return fileURLToPath(import.meta.url);
}

function emitMissedScheduleWarnings(projectDir: string): void {
  for (const line of checkMissedSchedules(projectDir)) {
    process.stderr.write(pc.dim(line) + "\n");
  }
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
  if (!opts.json) emitMissedScheduleWarnings(projectDir);
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

interface ScheduleLsOpts {
  json?: boolean;
}

function scheduleDoneCell(spec: ScheduleSpec): string {
  if (!spec.untilDone) return "-";
  return spec.lastRun?.done === true || spec.retiredReason === "done" ? "done" : "pending";
}

function relativeIso(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const delta = Date.now() - ts;
  if (Math.abs(delta) < 1000) return "now";
  if (delta < 0) return `in ${fmtDuration(-delta)}`;
  return `${fmtDuration(delta)} ago`;
}

function scheduleLastRunCell(spec: ScheduleSpec): string {
  if (spec.lastRun === null) return "-";
  return `${relativeIso(spec.lastRun.ts)} ${spec.lastRun.ok ? "✔" : "✖"}`;
}

function scheduleAddAction(name: string, command: string[], opts: ScheduleAddOpts): void {
  const spec = addSchedule({
    name,
    command: command ?? [],
    projectDir: process.cwd(),
    ...opts,
    nodeBin: process.execPath,
    cliPath: cliEntryPath(),
    pathEnv: process.env.PATH ?? "",
  }).spec;
  process.stdout.write(`scheduled ${name} (${spec.cronExpr})\n`);
}

function scheduleLsAction(opts: ScheduleLsOpts): void {
  const projectDir = process.cwd();
  const specs = listScheduleSpecs(projectDir);
  if (opts.json) {
    process.stdout.write(JSON.stringify(specs, null, 2) + "\n");
    return;
  }
  emitMissedScheduleWarnings(projectDir);
  if (specs.length === 0) {
    process.stdout.write("no schedules\n");
    return;
  }
  const rows: string[][] = [["NAME", "SCHEDULE", "STATUS", "RUNS", "LAST RUN", "DONE"]];
  for (const spec of specs) {
    rows.push([
      spec.name,
      humanSchedule(spec),
      spec.status,
      String(spec.runs),
      scheduleLastRunCell(spec),
      scheduleDoneCell(spec),
    ]);
  }
  process.stdout.write(table(rows) + "\n");
}

function scheduleRmAction(name: string): void {
  const projectDir = process.cwd();
  validateScheduleName(name);
  const spec = readScheduleSpec(projectDir, name);
  removeScheduleCrontabLine(spec.projectDir, spec.name);
  removeScheduleSpec(spec.projectDir, spec.name);
  appendScheduleLog(spec.projectDir, spec.name, `${new Date().toISOString()} · removed`);
  process.stdout.write(`removed schedule ${name}\n`);
}

function schedulePauseAction(name: string): void {
  const projectDir = process.cwd();
  validateScheduleName(name);
  const spec = readScheduleSpec(projectDir, name);
  if (spec.status === "retired") throw new CliError(`schedule "${name}" is retired`);
  removeScheduleCrontabLine(spec.projectDir, spec.name);
  spec.status = "paused";
  writeScheduleSpec(spec);
  process.stdout.write(`paused schedule ${name}\n`);
}

function scheduleResumeAction(name: string): void {
  const projectDir = process.cwd();
  validateScheduleName(name);
  const spec = readScheduleSpec(projectDir, name);
  if (spec.status === "retired") throw new CliError(`schedule "${name}" is retired`);
  spec.status = "active";
  spec.retiredReason = null;
  installScheduleCrontabLine(spec);
  writeScheduleSpec(spec);
  process.stdout.write(`resumed schedule ${name}\n`);
}

function scheduleExecAction(name: string): void {
  try {
    validateScheduleName(name);
    execSchedule(name);
  } catch {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// org
// ---------------------------------------------------------------------------

interface OrgRootOpts {
  root?: string;
}

interface OrgJsonOpts extends OrgRootOpts {
  json?: boolean;
}

interface OrgTickOpts extends OrgJsonOpts {
  date?: string;
  repair?: boolean;
  commit?: boolean;
  concurrency?: string;
}

interface OrgWakeOpts extends OrgJsonOpts {
  reason?: string;
}

interface OrgSendOpts extends OrgRootOpts {
  bodyFile?: string;
  refs?: string;
  deadline?: string;
}

interface OrgTicketsOpts extends OrgJsonOpts {
  agent?: string;
  state?: string;
}

interface OrgLintOpts extends OrgJsonOpts {
  strict?: boolean;
}

interface OrgReplayOpts extends OrgJsonOpts {
  from?: string;
  to?: string;
  faults?: string;
  pristine?: boolean;
}

interface OrgAuditOpts extends OrgJsonOpts {
  sample?: string;
}

function orgRoot(opts: OrgRootOpts): string {
  return path.resolve(opts.root ?? process.cwd());
}

async function orgInitAction(opts: OrgRootOpts): Promise<void> {
  const root = orgRoot(opts);
  const report = await initOrg(root);
  const findings = await lintTree(root);
  const errors = findings.filter((finding) => finding.level === "ERROR");
  if (errors.length > 0) {
    for (const finding of findings) process.stderr.write(formatOrgFinding(finding) + "\n");
    throw new CliError(`org init lint failed with ${errors.length} error(s)`);
  }
  process.stdout.write(formatScaffoldReport(report) + "\n");
}

async function orgTickAction(opts: OrgTickOpts): Promise<void> {
  const concurrency = opts.concurrency !== undefined ? Number(opts.concurrency) : undefined;
  if (opts.concurrency !== undefined && (!Number.isInteger(concurrency) || (concurrency ?? 0) < 1)) {
    throw new CliError(`--concurrency must be a positive integer (got "${opts.concurrency}")`);
  }
  const result = await executeTick(orgRoot(opts), {
    date: opts.date,
    repair: Boolean(opts.repair),
    commit: Boolean(opts.commit),
    concurrency,
  });
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(String(result.statusLine ?? JSON.stringify(result)) + "\n");
  // Partial ticks complete (deliveries, lint, commit) but exit nonzero so
  // unattended callers see that some seats failed and will retry next tick.
  if (Array.isArray(result.failedWakes) && result.failedWakes.length > 0) process.exitCode = 1;
}

async function orgWakeAction(agentPath: string, opts: OrgWakeOpts): Promise<void> {
  const root = orgRoot(opts);
  const target = path.isAbsolute(agentPath) ? agentPath : path.join(root, agentPath === "." ? "" : agentPath);
  const result = await wakeAgent(target, { root, reason: opts.reason });
  if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stdout.write(`${result.severity}: ${result.logLine}\n`);
}

async function orgSendAction(
  from: string,
  type: string,
  to: string,
  subject: string,
  opts: OrgSendOpts,
): Promise<void> {
  const root = orgRoot(opts);
  const normalizedType = type.trim().toUpperCase();
  const body = opts.bodyFile ? fs.readFileSync(path.resolve(root, opts.bodyFile), "utf8") : normalizedType === "REPLY" ? subject : "";
  const refs = splitRefs(opts.refs);
  const message = normalizedType === "REPLY"
    ? { from, type, ...replyTarget(to), body, refs }
    : { from, type, to, subject, body, refs, deadline: opts.deadline };
  const result = await deliverOrgMessage(message, { rootDir: root });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function orgAskAction(agentPath: string, question: string[], opts: OrgRootOpts): Promise<void> {
  const root = orgRoot(opts);
  const target = path.isAbsolute(agentPath) ? agentPath : path.join(root, agentPath === "." ? "" : agentPath);
  const result = await askAgent(target, question.join(" "), { root });
  process.stdout.write(result.answer.trim() + "\n");
}

async function orgTicketsAction(opts: OrgTicketsOpts): Promise<void> {
  const tickets = await listTickets(orgRoot(opts), { agent: opts.agent, state: opts.state });
  if (opts.json) {
    process.stdout.write(JSON.stringify(tickets, null, 2) + "\n");
    return;
  }
  if (tickets.length === 0) {
    process.stdout.write("no tickets\n");
    return;
  }
  process.stdout.write(table([["ID", "TO", "STATE", "DEADLINE", "SUBJECT"], ...tickets.map((ticket) => [
    ticket.id,
    ticket.to,
    ticket.state,
    ticket.deadline,
    ticket.subject,
  ])]) + "\n");
}

async function orgLintAction(opts: OrgLintOpts): Promise<void> {
  const findings = await lintTree(orgRoot(opts), { strictReview: Boolean(opts.strict) });
  if (opts.json) process.stdout.write(JSON.stringify(jsonFindings(findings), null, 2) + "\n");
  else for (const finding of findings) process.stdout.write(formatOrgFinding(finding) + "\n");
  if (findings.some((finding) => finding.level === "ERROR")) process.exitCode = 1;
}

async function orgStatusAction(opts: OrgJsonOpts): Promise<void> {
  const status = await statusOverview(orgRoot(opts));
  if (opts.json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return;
  }
  const totals = status.totals as { agents: number; inboxDepth: number; openTickets: number; overdueReviews: number; severityHighWater: string };
  const agents = status.agents as Array<{ path: string; lastWake: string | null; inboxDepth: number; openTickets: number; lastSeverity: string | null }>;
  const rows = [["AGENT", "LAST WAKE", "INBOX", "TICKETS", "SEVERITY"]];
  for (const agent of agents) {
    rows.push([
      agent.path,
      agent.lastWake ?? "-",
      String(agent.inboxDepth),
      String(agent.openTickets),
      agent.lastSeverity ?? "-",
    ]);
  }
  process.stdout.write(`agents ${totals.agents}, inbox ${totals.inboxDepth}, tickets ${totals.openTickets}, overdue ${totals.overdueReviews}, max ${totals.severityHighWater}\n`);
  process.stdout.write(table(rows) + "\n");
}

async function orgReplayAction(opts: OrgReplayOpts): Promise<void> {
  const result = await runOrgReplay({
    root: orgRoot(opts),
    from: opts.from,
    to: opts.to,
    faults: opts.faults,
    pristine: Boolean(opts.pristine),
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `replay ${result.from ?? "-"}..${result.to ?? "-"}: ${result.daysSimulated} days, ${result.itemsDelivered} items, ${result.cyclesRun} ticks\n`,
  );
}

async function orgAuditAction(opts: OrgAuditOpts): Promise<void> {
  const result = await runOrgAudit({
    root: orgRoot(opts),
    sample: opts.sample ?? 25,
  });
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `audit ${result.date}: accuracy ${result.accuracy}, ${result.sampled} sampled, ${result.findings.length} findings\n`,
  );
}

function splitRefs(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function replyTarget(target: string): { ticketId: string } | { ticketRelPath: string } {
  return target.includes("/") || target.endsWith(".md") ? { ticketRelPath: target } : { ticketId: target };
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
  emitMissedScheduleWarnings(process.cwd());
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
  process.stdout.write(renderRunStatic(state, { readAgentOutput: makeAgentOutputReader(runDir) }) + "\n");
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

export async function opencodeDoctorReport(
  config: UltracodexConfig,
  probeVersion: (binary: string) => Promise<string>,
): Promise<{
  lines: Array<{ kind: "ok" | "fail" | "info"; label: string; detail: string; hint?: string }>;
  hardFail: boolean;
}> {
  const lines: Array<{ kind: "ok" | "fail" | "info"; label: string; detail: string; hint?: string }> = [];
  const routed = config.route.some((r) => r.backend === "opencode");
  if (!routed) {
    lines.push({ kind: "info", label: "opencode", detail: "not routed; skipping checks" });
    return { lines, hardFail: false };
  }

  const binary = config.opencode.binary;
  try {
    const versionLine = (await probeVersion(binary)).trim();
    const matchesPin = versionLine.includes(TESTED_OPENCODE_VERSION);
    lines.push({
      kind: "ok",
      label: "opencode binary",
      detail: matchesPin
        ? `${versionLine} (matches tested pin ${TESTED_OPENCODE_VERSION})`
        : `${versionLine} (tested against ${TESTED_OPENCODE_VERSION})`,
    });
    if (!matchesPin) {
      lines.push({
        kind: "info",
        label: "opencode version",
        detail: `not the tested pin (${TESTED_OPENCODE_VERSION}); the server protocol is experimental — if runs misbehave, this is the first suspect`,
      });
    }
  } catch (err) {
    return {
      lines: [
        {
          kind: "fail",
          label: "opencode binary",
          detail: `cannot run "${binary} --version": ${errMsg(err)}`,
          hint: "install opencode (https://opencode.ai) or set [backends.opencode].binary in config.toml",
        },
      ],
      hardFail: true,
    };
  }

  lines.push(
    {
      kind: "info",
      label: "opencode sandbox",
      detail:
        "agents run WITHOUT OS sandboxing — the engine warns and passes through; per-call tools map can suppress builtin tools (shell, edit, write) but MCP tools are not blocked — see mcp note below",
    },
    {
      kind: "info",
      label: "opencode permissions",
      detail:
        "headless default executes tools including shell with no approval gate",
    },
    {
      kind: "info",
      label: "opencode mcp",
      detail:
        "MCP servers from the user's opencode config are inherited into every agent session",
    },
  );

  return { lines, hardFail: false };
}

/**
 * Read the user's INTERACTIVE codex config (~/.codex/config.toml, or
 * $CODEX_HOME) read-only and surface where the fleet diverges from it — the
 * quiet source of "why do my agents behave differently" surprises. Silent on
 * absence or parse failure: it's codex's file, not ours.
 */
export function reportInteractiveDivergence(
  codex: UltracodexConfig["codex"],
  info: (label: string, detail: string) => void,
): void {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(fs.readFileSync(path.join(home, "config.toml"), "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  const diffs: string[] = [];
  const agentTier = codex.serviceTier ?? "inherited";
  if (typeof raw["service_tier"] === "string" && raw["service_tier"] !== agentTier) {
    diffs.push(`service tier: ${raw["service_tier"]} (interactive) → ${agentTier} (agents)`);
  }
  const reviewer = raw["approvals_reviewer"] ?? raw["approval_policy"] ?? raw["ask_for_approval"];
  if (typeof reviewer === "string" && reviewer !== "never") {
    diffs.push(`approvals: "${reviewer}" (interactive) → auto-denied (agents)`);
  }
  if (diffs.length > 0) {
    info("diverges from your interactive codex (~/.codex)", diffs.join("; "));
  }
  const mcp = raw["mcp_servers"];
  if (mcp !== null && typeof mcp === "object") {
    const names = Object.keys(mcp as Record<string, unknown>);
    if (names.length > 0) {
      const shown = names.slice(0, 4).join(", ");
      info(
        "inherited into every agent thread",
        `${names.length} MCP server${names.length === 1 ? "" : "s"} from ~/.codex (${shown}${names.length > 4 ? ", …" : ""}) — adds per-agent startup latency`,
      );
    }
  }
}

async function doctorAction(): Promise<void> {
  const projectDir = process.cwd();
  let hardFail = false;
  const report = (ok: boolean, label: string, detail: string, hint?: string): void => {
    process.stdout.write(`${ok ? "✔" : "✖"} ${label}: ${detail}\n`);
    if (!ok && hint) process.stdout.write(`  → ${hint}\n`);
  };
  // Facts, not failures — never touch the exit code.
  const info = (label: string, detail: string, hint?: string): void => {
    process.stdout.write(`ℹ ${label}: ${detail}\n`);
    if (hint) process.stdout.write(`  → ${hint}\n`);
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
    const versionLine = stdout.trim();
    const matchesPin = versionLine.includes(TESTED_CODEX_VERSION);
    report(
      true,
      "codex binary",
      `${versionLine}${matchesPin ? ` (matches tested pin ${TESTED_CODEX_VERSION})` : ` (tested against ${TESTED_CODEX_VERSION})`}`,
    );
    if (!matchesPin) {
      info(
        "codex version",
        `not the tested pin (${TESTED_CODEX_VERSION}); the app-server protocol is experimental — if runs misbehave, this is the first suspect`,
      );
    }
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
        `check \`codex app-server\` runs by hand; ultracodex is tested against codex ${TESTED_CODEX_VERSION}`,
      );
    }
  }

  // What agents actually get (resolved through the same helpers the executor
  // uses, so this can't drift from reality) — and how that diverges from the
  // user's interactive codex, which is the classic source of surprises.
  if (config) {
    const c = config.codex;
    const model = resolveCodexModel(c, undefined);
    const effort = resolveCodexEffort(c, undefined) ?? "model default";
    const net = c.networkAccess ? "network ON" : "network OFF";
    info(
      "agents run with",
      `${model} · effort ${effort} · sandbox ${c.sandbox} · ${net} · service tier ${c.serviceTier ?? "inherited"} · approvals auto-denied`,
    );
    if (c.sandbox === "danger-full-access") {
      info("sandbox", "danger-full-access has no file confinement — see the escalation ladder in docs/operations.md");
    }
    reportInteractiveDivergence(c, info);
  }

  if (config) {
    const opencodeResult = await opencodeDoctorReport(config, (binary) =>
      execFileP(binary, ["--version"], { timeout: DOCTOR_PROBE_TIMEOUT_MS }).then((r) => r.stdout),
    );
    for (const line of opencodeResult.lines) {
      if (line.kind === "ok") report(true, line.label, line.detail, line.hint);
      else if (line.kind === "fail") {
        report(false, line.label, line.detail, line.hint);
      } else {
        info(line.label, line.detail, line.hint);
      }
    }
    if (opencodeResult.hardFail) hardFail = true;
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

  info("schedules", "manager mode: cron wakes ultracodex; no ultracodex daemon is installed");
  let crontabText: string | null = null;
  if (process.env[CRONTAB_FILE_ENV]) {
    info(
      "schedule crontab",
      `${CRONTAB_FILE_ENV} override active (${process.env[CRONTAB_FILE_ENV]})`,
    );
    try {
      crontabText = readCrontab();
    } catch (err) {
      report(false, "schedule crontab", errMsg(err));
    }
  } else {
    try {
      crontabText = readCrontab();
      report(true, "crontab binary", "reachable");
    } catch (err) {
      report(false, "crontab binary", errMsg(err), "install cron/crontab or test with ULTRACODEX_CRONTAB_FILE");
    }
  }

  let scheduleSpecs: ScheduleSpec[] = [];
  try {
    scheduleSpecs = listScheduleSpecs(projectDir);
  } catch (err) {
    report(false, "schedules", errMsg(err), "inspect .ultracodex/schedules/*.json");
  }
  const schedDir = schedulesDir(projectDir);
  if (scheduleSpecs.length === 0 && !fs.existsSync(schedDir)) {
    info("schedules", "no schedules");
  } else {
    try {
      fs.mkdirSync(schedDir, { recursive: true });
      const probe = path.join(schedDir, `.doctor-${process.pid}`);
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe);
      report(true, "schedules dir", `${schedDir} writable`);
    } catch (err) {
      report(false, "schedules dir", errMsg(err), "check permissions on .ultracodex/schedules/");
    }
  }
  if (crontabText !== null) {
    for (const spec of scheduleSpecs.filter((s) => s.status === "active")) {
      const count = countScheduleCrontabLines(crontabText, spec.projectDir, spec.name);
      report(
        count === 1,
        `schedule ${spec.name}`,
        count === 1 ? "one tagged crontab line present" : `expected one tagged crontab line, found ${count}`,
      );
    }
    const projectHash = projectHash8(projectDir);
    const specNames = new Set(scheduleSpecs.map((s) => s.name));
    for (const line of taggedCrontabLines(crontabText)) {
      if (line.hash8 === projectHash && !specNames.has(line.name)) {
        info("schedule orphan", `warn: tagged crontab line without spec (${line.name})`);
      }
    }
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
    .description("install static ultracodex skills, plus one skill per saved workflow, into .claude/skills/")
    .action(act(syncSkillsAction));

  const schedule = program.command("schedule").description("manage cron schedules");

  schedule
    .command("add <name> [command...]")
    .option("--every <dur>", "run every Nm (1-59) or Nh (1-23)")
    .option("--daily <HH:MM>", "run daily at local time HH:MM")
    .option("--cron <expr>", "raw 5-field cron expression")
    .option("--until-done", "retire when a scheduled run returns an object with done:true")
    .option("--max-runs <n>", "retire after n executions")
    .description("add a cron-backed schedule")
    .action(act(scheduleAddAction));

  schedule
    .command("ls")
    .option("--json", "emit schedule specs as JSON")
    .description("list schedules")
    .action(act(scheduleLsAction));

  schedule
    .command("rm <name>")
    .description("remove a schedule and its crontab line")
    .action(act(scheduleRmAction));

  schedule
    .command("pause <name>")
    .description("pause a schedule and remove its crontab line")
    .action(act(schedulePauseAction));

  schedule
    .command("resume <name>")
    .description("resume a paused schedule")
    .action(act(scheduleResumeAction));

  schedule
    .command("exec <name>", { hidden: true })
    .description("execute a schedule once")
    .action(scheduleExecAction);

  const org = program.command("org").description("manage an org runtime");

  org
    .command("init")
    .option("--root <dir>", "org root")
    .description("scaffold from coverage.toml")
    .action(act(orgInitAction));

  org
    .command("tick")
    .option("--root <dir>", "org root")
    .option("--date <date>", "cycle date YYYY-MM-DD")
    .option("--json", "emit tick result as JSON")
    .option("--repair", "run the packaged lint repair workflow for lint errors")
    .option("--commit", "commit tick changes")
    .option("--concurrency <n>", "max concurrent wakes")
    .description("run due wakes, delivery, and lint")
    .action(act(orgTickAction));

  org
    .command("wake <path>")
    .option("--root <dir>", "org root")
    .option("--reason <reason>", "wake reason")
    .option("--json", "emit wake result as JSON")
    .description("wake one agent")
    .action(act(orgWakeAction));

  org
    .command("send <from> <type> <to> <subject>")
    .option("--root <dir>", "org root")
    .option("--body-file <file>", "message body file")
    .option("--refs <refs>", "comma-separated refs")
    .option("--deadline <date>", "request deadline YYYY-MM-DD")
    .description("route one message")
    .action(act(orgSendAction));

  org
    .command("ask <path> <question...>")
    .option("--root <dir>", "org root")
    .description("ask an agent a read-only question")
    .action(act(orgAskAction));

  org
    .command("tickets")
    .option("--root <dir>", "org root")
    .option("--agent <path>", "filter by agent")
    .option("--state <state>", "filter by state")
    .option("--json", "emit tickets as JSON")
    .description("list tickets")
    .action(act(orgTicketsAction));

  org
    .command("lint")
    .option("--root <dir>", "org root")
    .option("--strict", "upgrade past review warnings to errors")
    .option("--json", "emit findings as JSON")
    .description("lint org files")
    .action(act(orgLintAction));

  org
    .command("status")
    .option("--root <dir>", "org root")
    .option("--json", "emit status as JSON")
    .description("show org status")
    .action(act(orgStatusAction));

  org
    .command("replay")
    .option("--root <dir>", "org root")
    .option("--from <date>", "first replay date YYYY-MM-DD")
    .option("--to <date>", "last replay date YYYY-MM-DD")
    .option("--faults <spec>", "fault injection spec: drop:ID;dup:ID;late:ID:DAYS")
    .option("--pristine", "reset memory files to scaffold state; requires a replay/* branch")
    .option("--json", "emit replay summary as JSON")
    .description("replay ingest ledger rows through org tick")
    .action(act(orgReplayAction));

  org
    .command("audit")
    .option("--root <dir>", "org root")
    .option("--sample <n>", "number of claims to sample")
    .option("--json", "emit audit summary as JSON")
    .description("run the packaged org audit workflow")
    .action(act(orgAuditAction));

  program
    .command("doctor")
    .description("check node, the codex binary, app-server auth, config, and routed backends (opencode)")
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
