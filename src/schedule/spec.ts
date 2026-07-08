import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../rundir.js";

export const SCHEDULES_DIR_NAME = "schedules";
export const SCHEDULE_SPEC_VERSION = 1;

export type ScheduleKind = "every" | "daily" | "cron";
export type ScheduleStatus = "active" | "paused" | "retired";

export interface ScheduleSpec {
  version: 1;
  name: string;
  createdAt: string;
  schedule: { kind: ScheduleKind; value: string };
  cronExpr: string;
  command: string[];
  projectDir: string;
  untilDone: boolean;
  maxRuns: number | null;
  status: ScheduleStatus;
  retiredReason: string | null;
  runs: number;
  lastRun: {
    ts: string;
    ok: boolean;
    exitCode: number;
    runId?: string;
    done?: boolean;
  } | null;
  env: { PATH: string };
  nodeBin: string;
  cliPath: string;
}

export interface ParsedSchedule {
  schedule: ScheduleSpec["schedule"];
  cronExpr: string;
}

export function schedulesDir(projectDir: string): string {
  return path.join(stateDir(projectDir), SCHEDULES_DIR_NAME);
}

export function scheduleSpecPath(projectDir: string, name: string): string {
  return path.join(schedulesDir(projectDir), `${name}.json`);
}

export function scheduleLogPath(projectDir: string, name: string): string {
  return path.join(schedulesDir(projectDir), `${name}.log`);
}

export function scheduleLockPath(projectDir: string, name: string): string {
  return path.join(schedulesDir(projectDir), `${name}.lock`);
}

export function validateScheduleName(name: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid schedule name "${name}" (use lowercase letters, digits, and hyphens)`);
  }
}

export function parseEvery(value: string): ParsedSchedule {
  const m = /^([1-9]\d*)([mh])$/.exec(value);
  if (!m) {
    throw new Error(`invalid --every "${value}" (use 1-59m or 1-23h)`);
  }
  const n = Number(m[1]);
  const unit = m[2];
  if (unit === "m") {
    if (!Number.isInteger(n) || n < 1 || n > 59) {
      throw new Error(`invalid --every "${value}" (minutes must be 1-59)`);
    }
    return { schedule: { kind: "every", value }, cronExpr: `*/${n} * * * *` };
  }
  if (!Number.isInteger(n) || n < 1 || n > 23) {
    throw new Error(`invalid --every "${value}" (hours must be 1-23)`);
  }
  return { schedule: { kind: "every", value }, cronExpr: `0 */${n} * * *` };
}

export function parseDaily(value: string): ParsedSchedule {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) throw new Error(`invalid --daily "${value}" (use HH:MM)`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    throw new Error(`invalid --daily "${value}" (use HH:MM in 00:00-23:59)`);
  }
  return { schedule: { kind: "daily", value }, cronExpr: `${mm} ${hh} * * *` };
}

export function parseCron(value: string): ParsedSchedule {
  if (/[\r\n]/.test(value)) {
    throw new Error("invalid --cron (newlines are not allowed)");
  }
  const fields = value.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    throw new Error(`invalid --cron "${value}" (expected exactly 5 fields)`);
  }
  return { schedule: { kind: "cron", value }, cronExpr: value.trim() };
}

export function everyIntervalMs(value: string): number | null {
  const m = /^([1-9]\d*)([mh])$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60_000 : n * 60 * 60_000;
}

export function scheduleIntervalMs(spec: ScheduleSpec): number | null {
  if (spec.schedule.kind === "daily") return 24 * 60 * 60_000;
  if (spec.schedule.kind === "every") return everyIntervalMs(spec.schedule.value);
  return null;
}

export function humanSchedule(spec: ScheduleSpec): string {
  switch (spec.schedule.kind) {
    case "every":
      return `every ${spec.schedule.value}`;
    case "daily":
      return `daily ${spec.schedule.value}`;
    case "cron":
      return spec.cronExpr;
  }
}

export function readScheduleSpec(projectDir: string, name: string): ScheduleSpec {
  try {
    return JSON.parse(fs.readFileSync(scheduleSpecPath(projectDir, name), "utf8")) as ScheduleSpec;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read schedule "${name}": ${msg}`);
  }
}

export function maybeReadScheduleSpec(projectDir: string, name: string): ScheduleSpec | null {
  try {
    return readScheduleSpec(projectDir, name);
  } catch {
    return null;
  }
}

export function writeScheduleSpec(spec: ScheduleSpec): void {
  fs.mkdirSync(schedulesDir(spec.projectDir), { recursive: true });
  fs.writeFileSync(
    scheduleSpecPath(spec.projectDir, spec.name),
    JSON.stringify(spec, null, 2) + "\n",
    "utf8",
  );
}

export function removeScheduleSpec(projectDir: string, name: string): void {
  fs.rmSync(scheduleSpecPath(projectDir, name), { force: true });
}

export function appendScheduleLog(projectDir: string, name: string, line: string): void {
  fs.mkdirSync(schedulesDir(projectDir), { recursive: true });
  fs.appendFileSync(scheduleLogPath(projectDir, name), line + "\n", "utf8");
}

export function listScheduleSpecs(projectDir: string): ScheduleSpec[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(schedulesDir(projectDir));
  } catch {
    return [];
  }
  const specs: ScheduleSpec[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    specs.push(readScheduleSpec(projectDir, name));
  }
  return specs;
}

export function newScheduleSpec(args: {
  name: string;
  schedule: ScheduleSpec["schedule"];
  cronExpr: string;
  command: string[];
  projectDir: string;
  untilDone: boolean;
  maxRuns: number | null;
  nodeBin: string;
  cliPath: string;
  pathEnv: string;
  now?: Date;
}): ScheduleSpec {
  const now = args.now ?? new Date();
  return {
    version: SCHEDULE_SPEC_VERSION,
    name: args.name,
    createdAt: now.toISOString(),
    schedule: args.schedule,
    cronExpr: args.cronExpr,
    command: args.command,
    projectDir: args.projectDir,
    untilDone: args.untilDone,
    maxRuns: args.maxRuns,
    status: "active",
    retiredReason: null,
    runs: 0,
    lastRun: null,
    env: { PATH: args.pathEnv },
    nodeBin: args.nodeBin,
    cliPath: args.cliPath,
  };
}

export function checkMissedSchedules(projectDir: string, nowMs = Date.now()): string[] {
  const warnings: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(schedulesDir(projectDir));
  } catch {
    return warnings;
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".json")) continue;
    const name = entry.slice(0, -".json".length);
    try {
      const spec = readScheduleSpec(projectDir, name);
      if (spec.status !== "active") continue;
      const interval = scheduleIntervalMs(spec);
      if (interval === null) continue;
      const baseIso = spec.lastRun?.ts ?? spec.createdAt;
      const base = Date.parse(baseIso);
      if (!Number.isFinite(base)) continue;
      if (nowMs - base <= interval * 1.5) continue;
      const expected = new Date(base + interval).toISOString();
      warnings.push(`schedule '${spec.name}' looks overdue (expected ~${expected}) — is cron running?`);
    } catch {
      continue;
    }
  }
  return warnings;
}
