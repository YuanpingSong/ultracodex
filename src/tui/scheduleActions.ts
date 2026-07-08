import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { installScheduleCrontabLine, removeScheduleCrontabLine } from "../schedule/crontab.js";
import { isExecRunning } from "../schedule/exec.js";
import { parseScheduleLogTail, type ScheduleExecOutcome } from "../schedule/log.js";
import {
  appendScheduleLog,
  checkMissedSchedules,
  listScheduleSpecs,
  readScheduleSpec,
  removeScheduleSpec,
  scheduleLogPath,
  schedulesDir,
  type ScheduleSpec,
  writeScheduleSpec,
} from "../schedule/spec.js";
import { compareScheduleSpecsForDisplay } from "./schedules.js";

export interface ScheduleRowItem {
  spec: ScheduleSpec;
  history: ScheduleExecOutcome[];
  running: boolean;
  logLines: string[];
  overdue: boolean;
}

export interface ScheduleSnapshot {
  fingerprint: string;
  rows: ScheduleRowItem[];
  warnings: string[];
}

export function readFileTailText(filePath: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "";
    const start = Math.max(0, stat.size - Math.max(0, Math.trunc(maxBytes)));
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(stat.size - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function readLogTailLines(projectDir: string, name: string, maxLines: number, maxBytes = 64 * 1024): string[] {
  const text = readFileTailText(scheduleLogPath(projectDir, name), maxBytes);
  if (text.length === 0) return [];
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-Math.max(0, Math.trunc(maxLines)));
}

function safeMissedWarnings(projectDir: string): string[] {
  try {
    return checkMissedSchedules(projectDir);
  } catch {
    return [];
  }
}

export function loadMissedScheduleWarnings(projectDir: string): string[] {
  return safeMissedWarnings(projectDir);
}

function overdueNamesFromWarnings(warnings: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const warning of warnings) {
    const m = /^schedule '([^']+)' looks overdue /.exec(warning);
    if (m) names.add(m[1]!);
  }
  return names;
}

export function scheduleDirFingerprint(projectDir: string): string {
  let entries: string[];
  const dir = schedulesDir(projectDir);
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return "missing";
  }
  const parts: string[] = [];
  for (const entry of entries.sort()) {
    if (!/\.(json|log|lock)$/.test(entry)) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      parts.push(`${entry}:${stat.isFile() ? "f" : "x"}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push(`${entry}:missing`);
    }
  }
  return parts.join("|");
}

function safeListScheduleSpecs(projectDir: string): ScheduleSpec[] {
  try {
    return listScheduleSpecs(projectDir);
  } catch {
    return [];
  }
}

function buildRows(projectDir: string, specs: readonly ScheduleSpec[], warnings: readonly string[], nowMs: number): ScheduleRowItem[] {
  const overdueNames = overdueNamesFromWarnings(warnings);
  return [...specs]
    .sort((a, b) => compareScheduleSpecsForDisplay(a, b, nowMs))
    .map((spec) => {
      const logTail = readFileTailText(scheduleLogPath(projectDir, spec.name), 4096);
      return {
        spec,
        history: parseScheduleLogTail(logTail, 5),
        running: isExecRunning(projectDir, spec.name),
        logLines: logTail
          .split(/\r?\n/)
          .filter((line) => line.trim() !== "")
          .slice(-5),
        overdue: overdueNames.has(spec.name),
      };
    });
}

export function loadScheduleSnapshot(projectDir: string, nowMs = Date.now()): ScheduleSnapshot {
  const fingerprint = scheduleDirFingerprint(projectDir);
  const warnings = safeMissedWarnings(projectDir);
  return {
    fingerprint,
    rows: buildRows(projectDir, safeListScheduleSpecs(projectDir), warnings, nowMs),
    warnings,
  };
}

export function refreshScheduleSnapshot(
  projectDir: string,
  previous: ScheduleSnapshot | null,
  nowMs = Date.now(),
): ScheduleSnapshot {
  const fingerprint = scheduleDirFingerprint(projectDir);
  const warnings = safeMissedWarnings(projectDir);
  if (previous !== null && previous.fingerprint === fingerprint) {
    const overdueNames = overdueNamesFromWarnings(warnings);
    return {
      fingerprint,
      warnings,
      rows: previous.rows
        .map((row) => ({
          ...row,
          running: isExecRunning(projectDir, row.spec.name),
          overdue: overdueNames.has(row.spec.name),
        }))
        .sort((a, b) => compareScheduleSpecsForDisplay(a.spec, b.spec, nowMs)),
    };
  }
  return {
    fingerprint,
    warnings,
    rows: buildRows(projectDir, safeListScheduleSpecs(projectDir), warnings, nowMs),
  };
}

export function execScheduleDetached(spec: ScheduleSpec): void {
  const child = spawn(spec.nodeBin, [spec.cliPath, "schedule", "exec", spec.name], {
    cwd: spec.projectDir,
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: true,
    env: { ...process.env, PATH: spec.env.PATH },
  });
  child.unref();
}

export function toggleSchedulePaused(projectDir: string, name: string): ScheduleSpec {
  const spec = readScheduleSpec(projectDir, name);
  if (spec.status === "retired") throw new Error(`schedule "${name}" is retired`);
  if (spec.status === "paused") {
    spec.status = "active";
    spec.retiredReason = null;
    installScheduleCrontabLine(spec);
    writeScheduleSpec(spec);
    return spec;
  }
  removeScheduleCrontabLine(spec.projectDir, spec.name);
  spec.status = "paused";
  writeScheduleSpec(spec);
  return spec;
}

export function removeScheduleForTui(projectDir: string, name: string): void {
  const spec = readScheduleSpec(projectDir, name);
  removeScheduleCrontabLine(spec.projectDir, spec.name);
  removeScheduleSpec(spec.projectDir, spec.name);
  appendScheduleLog(spec.projectDir, spec.name, `${new Date().toISOString()} · removed`);
}
