import fs from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type PathKind = "file" | "dir" | "other" | "missing";
export type FrontmatterValue = string | string[];

export interface ParsedFrontmatter {
  fields: Record<string, FrontmatterValue>;
  body: string;
  bodyLines: string[];
  bodyLineCount: number;
  bodyStartLine: number;
}

export function normalizeAgentPath(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw || raw === "." || raw === "./" || raw === "root") return ".";
  if (path.posix.isAbsolute(raw)) throw new Error(`agent path must be repo-relative: ${JSON.stringify(value)}`);
  const normalized = path.posix.normalize(raw.replace(/^\.\//u, "")).replace(/\/+$/u, "");
  if (!normalized || normalized === ".") return ".";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`agent path escapes repo root: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function labelAgentPath(agentPath: unknown): string {
  const normalized = normalizeAgentPath(agentPath);
  return normalized === "." ? "." : normalized;
}

export function normalizeRepoPath(value: unknown): string | null {
  let raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (path.isAbsolute(raw)) return null;
  raw = raw.replace(/^\.\//u, "");
  const normalized = path.posix.normalize(raw);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "" : normalized;
}

export function posixJoin(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/gu, "/");
}

export function fromPosix(rel: string): string {
  return rel.split("/").join(path.sep);
}

export function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

export function agentDir(root: string, agentPath: unknown): string {
  const normalized = normalizeAgentPath(agentPath);
  return normalized === "." ? path.resolve(root) : path.join(path.resolve(root), fromPosix(normalized));
}

export function agentRel(agentPath: unknown, rel: string): string {
  const normalized = normalizeAgentPath(agentPath);
  return normalized === "." ? rel : posixJoin(normalized, rel);
}

export function agentDepth(agentPath: unknown): number {
  const normalized = normalizeAgentPath(agentPath);
  return normalized === "." ? 0 : normalized.split("/").length;
}

export async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

export async function maybeReadText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

export async function pathKind(file: string): Promise<PathKind> {
  try {
    const info = await stat(file);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "dir";
    return "other";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw err;
  }
}

export function parseFrontmatter(text: string, relPath = "(file)"): ParsedFrontmatter {
  const lines = String(text ?? "").split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") throw new Error(`${relPath} missing frontmatter`);
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) throw new Error(`${relPath} frontmatter is not closed`);
  const fields = parseYamlish(lines.slice(1, close), relPath);
  const bodyLines = lines.slice(close + 1);
  const body = bodyLines.join("\n").replace(/^\n/u, "");
  return {
    fields,
    body,
    bodyLines,
    bodyLineCount: countBodyLines(bodyLines, text),
    bodyStartLine: close + 2,
  };
}

export function parseLooseFrontmatter(text: string): Record<string, string> {
  const lines = String(text ?? "").split(/\r?\n/u);
  const fields: Record<string, string> = {};
  if (lines[0]?.trim() !== "---") return fields;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line === "---") return fields;
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u);
    if (!match) continue;
    fields[match[1]!.toLowerCase().replace(/[-_\s]/gu, "")] = match[2]!.trim().replace(/^["']|["']$/gu, "");
  }
  return fields;
}

export function parseYamlScalar(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!value.startsWith("[") || !value.endsWith("]")) throw new Error("malformed inline array");
    return splitInlineArray(value.slice(1, -1));
  }
  return unquote(value);
}

function parseYamlish(lines: string[], relPath: string): Record<string, FrontmatterValue> {
  const fields: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) return;

    const item = line.match(/^\s*-\s*(.+)$/u);
    if (item && currentKey) {
      const current = fields[currentKey];
      if (!Array.isArray(current)) throw new Error(`${relPath} invalid frontmatter line ${index + 2}`);
      current.push(String(parseYamlScalar(item[1]!)));
      return;
    }

    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!kv) throw new Error(`${relPath} invalid frontmatter line ${index + 2}`);
    currentKey = kv[1]!;
    fields[currentKey] = kv[2]!.trim() === "" ? [] : parseYamlScalar(kv[2]!);
  });
  return fields;
}

function splitInlineArray(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escape = false;
  for (const char of value) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      if (current.trim()) parts.push(unquote(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unterminated quoted array value");
  if (current.trim()) parts.push(unquote(current.trim()));
  return parts;
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function countBodyLines(bodyLines: string[], fullText: string): number {
  if (bodyLines.length === 0) return 0;
  if (bodyLines.length === 1 && bodyLines[0] === "") return 0;
  if (fullText.endsWith("\n") && bodyLines.at(-1) === "") return bodyLines.length - 1;
  return bodyLines.length;
}

export function scalarField(
  fields: Record<string, FrontmatterValue>,
  field: string,
  relPath = "(file)",
): string {
  if (!Object.prototype.hasOwnProperty.call(fields, field)) {
    throw new Error(`${relPath} frontmatter missing ${field}`);
  }
  const value = fields[field];
  if (Array.isArray(value)) throw new Error(`${relPath} frontmatter ${field} must be a scalar`);
  return String(value);
}

export function quoteScalar(value: unknown): string {
  return JSON.stringify(String(value));
}

export function inlineArray(values: unknown): string {
  if (!Array.isArray(values) || values.length === 0) return "[]";
  return `[${values.map(quoteScalar).join(", ")}]`;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

export function assertIsoDate(value: string, field = "date"): string {
  if (!isIsoDate(value)) throw new Error(`${field} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  return value;
}

export function dateOnly(value: unknown): string {
  const match = String(value ?? "").match(/(\d{4}-\d{2}-\d{2})/u);
  return match ? match[0]! : todayIso();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  assertIsoDate(date);
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function firstDate(...values: unknown[]): string | null {
  for (const value of values) {
    const match = String(value ?? "").match(/(\d{4}-\d{2}-\d{2})/u);
    if (match) return match[1]!;
  }
  return null;
}

export function sanitizeId(value: unknown, label = "id"): string {
  const id = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) {
    throw new Error(`invalid ${label} ${JSON.stringify(value)}`);
  }
  return id;
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
