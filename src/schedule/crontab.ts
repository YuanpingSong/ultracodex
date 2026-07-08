import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { scheduleLogPath, type ScheduleSpec } from "./spec.js";

export const CRONTAB_FILE_ENV = "ULTRACODEX_CRONTAB_FILE";

export function readCrontab(): string {
  const override = process.env[CRONTAB_FILE_ENV];
  if (override) {
    try {
      return fs.readFileSync(override, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    }
  }
  try {
    return execFileSync("crontab", ["-l"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    if (/no crontab for/i.test(stderr)) return "";
    throw err;
  }
}

export function writeCrontab(text: string): void {
  const override = process.env[CRONTAB_FILE_ENV];
  if (override) {
    fs.mkdirSync(path.dirname(override), { recursive: true });
    fs.writeFileSync(override, text, "utf8");
    return;
  }
  execFileSync("crontab", ["-"], {
    input: text,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function projectHash8(projectDir: string): string {
  return crypto.createHash("sha256").update(projectDir).digest("hex").slice(0, 8);
}

export function scheduleTag(projectDir: string, name: string): string {
  return `ultracodex:${name}@${projectHash8(projectDir)}`;
}

function assertSingleLineCrontabPath(label: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`invalid crontab ${label} path (newlines are not allowed)`);
  }
}

export function validateCrontabPaths(spec: ScheduleSpec): void {
  assertSingleLineCrontabPath("projectDir", spec.projectDir);
  assertSingleLineCrontabPath("nodeBin", spec.nodeBin);
  assertSingleLineCrontabPath("cliPath", spec.cliPath);
  assertSingleLineCrontabPath("logPath", scheduleLogPath(spec.projectDir, spec.name));
}

function cronEscapePath(value: string, label: string): string {
  assertSingleLineCrontabPath(label, value);
  return value.replace(/%/g, "\\%").replace(/'/g, "'\\''");
}

function singleQuotePath(value: string, label: string): string {
  return `'${cronEscapePath(value, label)}'`;
}

export function renderCrontabLine(spec: ScheduleSpec): string {
  validateCrontabPaths(spec);
  const logPath = scheduleLogPath(spec.projectDir, spec.name);
  return [
    spec.cronExpr,
    "cd",
    singleQuotePath(spec.projectDir, "projectDir"),
    "&&",
    singleQuotePath(spec.nodeBin, "nodeBin"),
    singleQuotePath(spec.cliPath, "cliPath"),
    "schedule",
    "exec",
    spec.name,
    `>>${singleQuotePath(logPath, "logPath")}`,
    "2>&1",
    "#",
    scheduleTag(spec.projectDir, spec.name),
  ].join(" ");
}

function lineChunks(text: string): string[] {
  if (text.length === 0) return [];
  const chunks = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (chunks[chunks.length - 1] === "") chunks.pop();
  return chunks;
}

function withoutTrailingNewline(chunk: string): string {
  return chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
}

function removeTaggedChunks(text: string, tag: string): { text: string; removed: number } {
  let removed = 0;
  const kept = lineChunks(text).filter((chunk) => {
    const line = withoutTrailingNewline(chunk);
    if (line.endsWith(`# ${tag}`)) {
      removed += 1;
      return false;
    }
    return true;
  });
  return { text: kept.join(""), removed };
}

export function installScheduleCrontabLine(spec: ScheduleSpec): void {
  const tag = scheduleTag(spec.projectDir, spec.name);
  const { text } = removeTaggedChunks(readCrontab(), tag);
  const ownedLine = renderCrontabLine(spec) + "\n";
  // If foreign content has no trailing newline, prepend our line so removal can
  // restore those bytes exactly instead of leaving an inserted separator behind.
  const next =
    text.length === 0 ? ownedLine : text.endsWith("\n") ? text + ownedLine : ownedLine + text;
  writeCrontab(next);
}

export function removeScheduleCrontabLine(projectDir: string, name: string): void {
  const tag = scheduleTag(projectDir, name);
  const { text } = removeTaggedChunks(readCrontab(), tag);
  writeCrontab(text);
}

export interface TaggedCrontabLine {
  name: string;
  hash8: string;
  tag: string;
  line: string;
}

export function taggedCrontabLines(text: string): TaggedCrontabLine[] {
  const out: TaggedCrontabLine[] = [];
  for (const chunk of lineChunks(text)) {
    const line = withoutTrailingNewline(chunk);
    const m = /# (ultracodex:([a-z0-9][a-z0-9-]*)@([0-9a-f]{8}))$/.exec(line);
    if (!m) continue;
    out.push({ tag: m[1]!, name: m[2]!, hash8: m[3]!, line });
  }
  return out;
}

export function countScheduleCrontabLines(
  text: string,
  projectDir: string,
  name: string,
): number {
  const tag = scheduleTag(projectDir, name);
  let count = 0;
  for (const line of taggedCrontabLines(text)) {
    if (line.tag === tag) count += 1;
  }
  return count;
}
