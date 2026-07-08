import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pidAlive } from "../rundir.js";
import { removeScheduleCrontabLine } from "./crontab.js";
import {
  appendScheduleLog,
  readScheduleSpec,
  scheduleLockPath,
  scheduleSpecPath,
  type ScheduleSpec,
  writeScheduleSpec,
} from "./spec.js";

interface CommandResult {
  exitCode: number;
  ok: boolean;
  status: string;
  stdout: string;
  stderr: string;
  runId?: string;
  result?: unknown;
  done?: boolean;
  error?: string;
}

interface StaleLockClaim {
  path: string;
  token: string;
}

interface StaleLockClaimOwner {
  kind: "missing" | "file" | "directory" | "other";
  pid: number | null;
  token: string | null;
}

const LOCK_SETTLE_MS = 100;
const LOG_STREAM_LIMIT = 16 * 1024;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockPid(lockPath: string): number | null {
  try {
    const n = Number(fs.readFileSync(lockPath, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function readSettledLockPid(lockPath: string): number | null {
  const pid = readLockPid(lockPath);
  if (pid !== null) return pid;
  sleepSync(LOCK_SETTLE_MS);
  return readLockPid(lockPath);
}

export function isExecRunning(projectDir: string, name: string): boolean {
  const pid = readSettledLockPid(scheduleLockPath(projectDir, name));
  return pid !== null && pidAlive(pid);
}

function staleLockClaimPath(lockPath: string): string {
  return `${lockPath}.steal`;
}

function parsePid(text: string): number | null {
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

function encodeStaleLockClaim(pid: number, token: string): string {
  return `${pid}\n${token}\n`;
}

function parseStaleLockClaim(text: string): Pick<StaleLockClaimOwner, "pid" | "token"> {
  const [pidLine, tokenLine] = text.trim().split(/\r?\n/, 2);
  return {
    pid: pidLine === undefined ? null : parsePid(pidLine),
    token: tokenLine && tokenLine.length > 0 ? tokenLine : null,
  };
}

function readStaleLockClaimOwner(claimPath: string): StaleLockClaimOwner {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(claimPath);
  } catch {
    return { kind: "missing", pid: null, token: null };
  }
  if (stat.isDirectory()) {
    return { kind: "directory", pid: readLockPid(`${claimPath}/pid`), token: null };
  }
  if (!stat.isFile()) {
    return { kind: "other", pid: null, token: null };
  }
  try {
    return { kind: "file", ...parseStaleLockClaim(fs.readFileSync(claimPath, "utf8")) };
  } catch {
    return { kind: "file", pid: null, token: null };
  }
}

function readSettledStaleLockClaimOwner(claimPath: string): StaleLockClaimOwner {
  const owner = readStaleLockClaimOwner(claimPath);
  if (owner.kind === "missing" || owner.pid !== null) return owner;
  sleepSync(LOCK_SETTLE_MS);
  return readStaleLockClaimOwner(claimPath);
}

function staleLockClaimOwnersMatch(a: StaleLockClaimOwner, b: StaleLockClaimOwner): boolean {
  return a.kind === b.kind && a.pid === b.pid && a.token === b.token;
}

function tryReapStaleLockClaim(claimPath: string, owner: StaleLockClaimOwner): void {
  if (owner.kind === "missing") return;
  if (!staleLockClaimOwnersMatch(readStaleLockClaimOwner(claimPath), owner)) return;
  fs.rmSync(claimPath, { recursive: true, force: true });
}

function tryCreateStaleLockClaim(claimPath: string): StaleLockClaim | null {
  fs.mkdirSync(path.dirname(claimPath), { recursive: true });
  const token = `${process.pid}-${process.hrtime.bigint()}-${randomBytes(16).toString("hex")}`;
  const tmpPath = `${claimPath}.${token}.tmp`;
  try {
    fs.writeFileSync(tmpPath, encodeStaleLockClaim(process.pid, token), { encoding: "utf8", flag: "wx" });
    try {
      fs.linkSync(tmpPath, claimPath);
      return { path: claimPath, token };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw err;
    }
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function staleLockClaimMatches(claim: StaleLockClaim): boolean {
  const owner = readStaleLockClaimOwner(claim.path);
  return owner.kind === "file" && owner.pid === process.pid && owner.token === claim.token;
}

function acquireStaleLockClaim(lockPath: string): StaleLockClaim | null {
  const claimPath = staleLockClaimPath(lockPath);
  for (;;) {
    const claim = tryCreateStaleLockClaim(claimPath);
    if (claim !== null) return claim;

    const owner = readSettledStaleLockClaimOwner(claimPath);
    if (owner.pid !== null && pidAlive(owner.pid)) {
      return null;
    }
    tryReapStaleLockClaim(claimPath, owner);
  }
}

function releaseStaleLockClaim(claim: StaleLockClaim): void {
  if (!staleLockClaimMatches(claim)) return;
  fs.rmSync(claim.path, { force: true });
}

function tryCreatePopulatedLock(lockPath: string): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const tmpPath = `${lockPath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
    try {
      fs.linkSync(tmpPath, lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function acquireLock(lockPath: string): boolean {
  for (;;) {
    if (tryCreatePopulatedLock(lockPath)) return true;

    const existingPid = readSettledLockPid(lockPath);
    if (existingPid !== null && pidAlive(existingPid)) return false;

    const claimPath = acquireStaleLockClaim(lockPath);
    if (claimPath === null) return false;
    try {
      if (!staleLockClaimMatches(claimPath)) continue;
      const pid = readSettledLockPid(lockPath);
      if (!staleLockClaimMatches(claimPath)) continue;
      if (pid !== null && pidAlive(pid)) return false;
      fs.rmSync(lockPath, { force: true });
      if (tryCreatePopulatedLock(lockPath)) return true;
    } finally {
      releaseStaleLockClaim(claimPath);
    }
  }
}

function releaseLock(lockPath: string): void {
  if (readLockPid(lockPath) !== process.pid) return;
  fs.rmSync(lockPath, { force: true });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseRunJsonOutput(stdout: string, exitCode: number): {
  status: string;
  runId?: string;
  result?: unknown;
  done?: boolean;
} {
  const text = stdout.trim();
  let parsed: unknown;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }
  const parsedObj = isObject(parsed) ? parsed : null;
  if (exitCode === 0) {
    return {
      status: "ok",
      result: parsed,
      done:
        parsedObj !== null && typeof parsedObj["done"] === "boolean"
          ? Boolean(parsedObj["done"])
          : undefined,
    };
  }
  const status =
    parsedObj !== null && typeof parsedObj["status"] === "string"
      ? String(parsedObj["status"])
      : "failed";
  const runId =
    parsedObj !== null && typeof parsedObj["runId"] === "string"
      ? String(parsedObj["runId"])
      : undefined;
  return { status, runId };
}

function spawnCommand(bin: string, args: string[], spec: ScheduleSpec): CommandResult {
  const res = spawnSync(bin, args, {
    cwd: spec.projectDir,
    env: { ...process.env, PATH: spec.env.PATH },
    encoding: "utf8",
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  const exitCode = typeof res.status === "number" ? res.status : res.error ? 127 : 1;
  const base: CommandResult = {
    exitCode,
    ok: exitCode === 0,
    status: exitCode === 0 ? "ok" : "failed",
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
  if (res.error) base.error = res.error.message;
  return base;
}

function runScheduledCommand(spec: ScheduleSpec): CommandResult {
  if (spec.command.length === 0) {
    return { exitCode: 127, ok: false, status: "failed", stdout: "", stderr: "", error: "empty command" };
  }
  if (spec.command[0] !== "run") {
    return spawnCommand(spec.command[0]!, spec.command.slice(1), spec);
  }
  const scriptRef = spec.command[1];
  if (!scriptRef) {
    return { exitCode: 127, ok: false, status: "failed", stdout: "", stderr: "", error: "missing run script" };
  }
  const args = [spec.cliPath, "run", scriptRef, ...spec.command.slice(2), "--json"];
  const res = spawnSync(spec.nodeBin, args, {
    cwd: spec.projectDir,
    env: { ...process.env, PATH: spec.env.PATH },
    encoding: "utf8",
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });
  const exitCode = typeof res.status === "number" ? res.status : res.error ? 127 : 1;
  const parsed = parseRunJsonOutput(String(res.stdout ?? ""), exitCode);
  return {
    exitCode,
    ok: exitCode === 0,
    status: parsed.status,
    runId: parsed.runId,
    result: parsed.result,
    done: parsed.done,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
    error: res.error?.message,
  };
}

function sanitizeLogStream(text: string): string {
  let sanitized = "";
  for (const ch of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) {
    const code = ch.charCodeAt(0);
    if (ch === "\n" || ch === "\t" || (code >= 0x20 && code !== 0x7f)) {
      sanitized += ch;
    } else {
      sanitized += `\\x${code.toString(16).padStart(2, "0")}`;
    }
    if (sanitized.length > LOG_STREAM_LIMIT) {
      return `${sanitized.slice(0, LOG_STREAM_LIMIT)}\n[truncated]`;
    }
  }
  return sanitized;
}

function appendCapturedStreamLog(spec: ScheduleSpec, ts: string, label: "stderr" | "stdout", text: string): void {
  if (text.length === 0) return;
  appendScheduleLog(spec.projectDir, spec.name, `${ts} · ${label}:\n${sanitizeLogStream(text)}`);
}

function appendRunLog(spec: ScheduleSpec, ts: string, result: CommandResult): void {
  const parts = [`${ts}`, `exit ${result.exitCode}`];
  if (result.runId) parts.push(`runId ${result.runId}`);
  parts.push(`status ${result.status}`);
  if (result.done !== undefined) parts.push(`done ${result.done}`);
  if (result.error) parts.push(`error ${result.error}`);
  appendScheduleLog(spec.projectDir, spec.name, parts.join(" · "));
  appendCapturedStreamLog(spec, ts, "stderr", result.stderr);
  appendCapturedStreamLog(spec, ts, "stdout", result.stdout);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tryAppendScheduleLog(projectDir: string, name: string, line: string): void {
  try {
    appendScheduleLog(projectDir, name, line);
  } catch {
    // Hidden cron exec must never surface log-write failures.
  }
}

function tryAppendExecError(spec: ScheduleSpec, context: string, err: unknown): void {
  tryAppendScheduleLog(
    spec.projectDir,
    spec.name,
    `${new Date().toISOString()} · error: ${context}: ${errMsg(err)}`,
  );
}

function safeRunScheduledCommand(spec: ScheduleSpec): CommandResult {
  try {
    return runScheduledCommand(spec);
  } catch (err) {
    return {
      exitCode: 1,
      ok: false,
      status: "failed",
      stdout: "",
      stderr: "",
      error: errMsg(err),
    };
  }
}

function retire(spec: ScheduleSpec, reason: "done" | "max-runs"): void {
  spec.status = "retired";
  spec.retiredReason = reason;
  try {
    removeScheduleCrontabLine(spec.projectDir, spec.name);
  } catch (err) {
    tryAppendExecError(spec, `retire ${reason}`, err);
  }
  tryAppendScheduleLog(spec.projectDir, spec.name, `${new Date().toISOString()} · retired: ${reason}`);
}

function buildLastRun(ts: string, result: CommandResult): ScheduleSpec["lastRun"] {
  return {
    ts,
    ok: result.ok,
    exitCode: result.exitCode,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.done !== undefined ? { done: result.done } : {}),
  };
}

function readSpecForRunUpdate(spec: ScheduleSpec): ScheduleSpec | null {
  const specPath = scheduleSpecPath(spec.projectDir, spec.name);
  if (!fs.existsSync(specPath)) return null;
  return readScheduleSpec(spec.projectDir, spec.name);
}

function updateSpecAfterRun(initialSpec: ScheduleSpec, ts: string, result: CommandResult): void {
  const current = readSpecForRunUpdate(initialSpec);
  if (current === null) return;

  const managerStateChanged =
    current.status !== initialSpec.status || current.retiredReason !== initialSpec.retiredReason;

  current.runs += 1;
  current.lastRun = buildLastRun(ts, result);

  if (!managerStateChanged) {
    if (current.untilDone && isObject(result.result) && result.result["done"] === true) {
      retire(current, "done");
    } else if (current.maxRuns !== null && current.runs >= current.maxRuns) {
      retire(current, "max-runs");
    }
  }

  writeScheduleSpec(current);
}

export function execSchedule(name: string, projectDir = process.cwd()): void {
  const spec = readScheduleSpec(projectDir, name);
  if (spec.status === "paused" || spec.status === "retired") {
    tryAppendScheduleLog(spec.projectDir, spec.name, `${new Date().toISOString()} · skipped: ${spec.status}`);
    return;
  }

  const lockPath = scheduleLockPath(spec.projectDir, spec.name);
  let locked = false;
  try {
    locked = acquireLock(lockPath);
  } catch (err) {
    tryAppendExecError(spec, "lock", err);
    return;
  }
  if (!locked) {
    tryAppendScheduleLog(
      spec.projectDir,
      spec.name,
      `${new Date().toISOString()} · skipped: previous run still active`,
    );
    return;
  }

  const prevCwd = process.cwd();
  const prevPath = process.env.PATH;
  try {
    try {
      process.chdir(spec.projectDir);
    } catch (err) {
      tryAppendExecError(spec, "chdir", err);
      return;
    }
    process.env.PATH = spec.env.PATH;
    const result = safeRunScheduledCommand(spec);
    const ts = new Date().toISOString();
    try {
      appendRunLog(spec, ts, result);
    } catch (err) {
      tryAppendExecError(spec, "log append", err);
    }

    try {
      updateSpecAfterRun(spec, ts, result);
    } catch (err) {
      tryAppendExecError(spec, "spec update", err);
    }
  } catch (err) {
    tryAppendExecError(spec, "exec", err);
  } finally {
    try {
      process.chdir(prevCwd);
    } catch (err) {
      tryAppendExecError(spec, "cwd restore", err);
    }
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    try {
      releaseLock(lockPath);
    } catch (err) {
      tryAppendExecError(spec, "lock release", err);
    }
  }
}
