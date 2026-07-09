import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  addDays,
  dateOnly,
  firstDate,
  fromPosix,
  parseLooseFrontmatter,
  posixJoin,
  todayIso,
  toPosix,
} from "./common.js";

const execFile = promisify(execFileCallback);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DEFAULT_WAKE_CAP = 8;
const SEVERITIES = new Set(["routine", "notable", "material", "urgent"]);
const ENTITY_FILES = ["AGENTS.md", "BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"];
const GROUP_FILES = ["AGENTS.md", "BRIEF.md", "THESIS.md", "LOG.md"];
const ROOT_FILES = ["AGENTS.md", "BRIEF.md", "LOG.md"];
const WAKE_ROLES = new Set(["root", "group", "entity"]);

export interface InboxSelection {
  items: string[];
  backlog: number;
  historical: string[];
}

export interface WakeArgs {
  date: string;
  cycle: number;
  reason: string;
  role: string;
  agentPath: string;
  agentLabel: string;
  inbox: InboxSelection;
}

export interface WakeResult {
  changed: boolean;
  severity: "routine" | "notable" | "material" | "urgent";
  logLine: string;
  outbox: unknown[];
}

export interface WakeOptions {
  rootDir?: string;
  root?: string;
  date?: string;
  cycle?: number;
  reason?: string;
  execImpl?: ExecImpl;
}

export type ExecImpl = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout?: string; stderr?: string; exitCode?: number; status?: number; result?: unknown; runId?: string; runDir?: string }>;

export async function wakeAgent(agentPath: string, options: WakeOptions = {}): Promise<WakeResult> {
  const agentDir = resolveAgentDir(agentPath, options);
  const role = await detectRole(agentDir);
  const date = options.date ?? todayIso();
  const cycle = options.cycle ?? 0;
  const reason = options.reason ?? "runtime wake";
  assertDate(date);

  const root = rootForAgent(agentDir, role);
  const relativePath = toPosix(path.relative(root, agentDir));
  const agentRel = relativePath || ".";
  const inbox = await scanInbox(agentDir, date);
  const script = await renderWakeScript(role, {
    date,
    cycle,
    reason,
    role,
    agentPath: agentRel,
    agentLabel: labelFor(agentRel, role),
    inbox,
  });

  const result = await runGeneratedScript(agentDir, script, options.execImpl ?? defaultExecImpl);
  const parsed = normalizeWakeResult(parseRunJson(result));
  await writeThreadId(agentDir, result);
  return parsed;
}

function resolveAgentDir(agentPath: string, options: WakeOptions = {}): string {
  if (path.isAbsolute(String(agentPath || ""))) return path.resolve(agentPath || ".");
  const root = path.resolve(options.rootDir ?? options.root ?? process.cwd());
  return path.resolve(root, agentPath || ".");
}

export function resumeArgs(): string[] {
  return [];
}

export async function renderWakeScript(role: string, wakeArgs: WakeArgs): Promise<string> {
  if (!WAKE_ROLES.has(role)) throw new Error(`unknown wake role ${role}`);
  const template = await readFile(path.join(packageRoot(), "org-templates", "wake", `${role}.js.tpl`), "utf8");
  return template.replace("__WAKE_ARGS_JSON__", JSON.stringify(wakeArgs, null, 2));
}

export function parseRunJson(runResult: unknown): unknown {
  if (runResult && typeof runResult === "object" && "result" in runResult && (runResult as { result?: unknown }).result !== undefined) {
    return (runResult as { result: unknown }).result;
  }
  const stdout = typeof runResult === "string" ? runResult : (runResult as { stdout?: unknown } | null | undefined)?.stdout;
  if (stdout === undefined || stdout === null || String(stdout).trim() === "") {
    throw new Error("ultracodex returned malformed JSON: empty stdout");
  }
  const text = String(stdout).trim();
  try {
    return JSON.parse(text) as unknown;
  } catch (firstError) {
    const last = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
    if (last && last !== text) {
      try {
        return JSON.parse(last) as unknown;
      } catch {
        throw new Error(`ultracodex returned malformed JSON: ${(firstError as Error).message}`);
      }
    }
    throw new Error(`ultracodex returned malformed JSON: ${(firstError as Error).message}`);
  }
}

async function runGeneratedScript(agentDir: string, script: string, execImpl: ExecImpl): Promise<Awaited<ReturnType<ExecImpl>>> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "org-wake-"));
  const scriptPath = path.join(tmpDir, "wake.js");
  await writeFile(scriptPath, script, "utf8");
  try {
    const { command, argsPrefix } = engineCommand();
    const result = await execImpl(command, [...argsPrefix, "run", scriptPath, "--json", ...resumeArgs()], { cwd: agentDir });
    const code = result?.exitCode ?? result?.status ?? 0;
    if (code !== 0) {
      const stderr = result?.stderr ? `: ${String(result.stderr).trim()}` : "";
      throw new Error(`ultracodex run failed with exit ${code}${stderr}`);
    }
    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function engineCommand(): { command: string; argsPrefix: string[] } {
  if (process.env.ULTRACODEX_BIN) return { command: process.env.ULTRACODEX_BIN, argsPrefix: [] };
  return { command: process.execPath, argsPrefix: [cliEntryPath()] };
}

function cliEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

async function defaultExecImpl(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFile(command, args, { ...options, maxBuffer: 1024 * 1024 * 64 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    if (err && typeof err === "object") {
      (err as Error).message = `ultracodex run failed: ${(err as Error).message}`;
    }
    throw err;
  }
}

function normalizeWakeResult(payload: unknown): WakeResult {
  const result = unwrapResult(payload);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("ultracodex result must be an object");
  const row = result as Record<string, unknown>;
  if (typeof row.changed !== "boolean") throw new Error("ultracodex result missing boolean changed");
  if (!SEVERITIES.has(String(row.severity))) throw new Error(`ultracodex result has invalid severity ${JSON.stringify(row.severity)}`);
  if (typeof row.logLine !== "string") throw new Error("ultracodex result missing string logLine");
  const outbox = row.outbox === undefined ? [] : row.outbox;
  if (!Array.isArray(outbox)) throw new Error("ultracodex result outbox must be an array");
  return {
    changed: row.changed,
    severity: row.severity as WakeResult["severity"],
    logLine: row.logLine,
    outbox,
  };
}

function unwrapResult(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>;
    if (row.result && typeof row.result === "object") return unwrapResult(row.result);
    if (row.output && typeof row.output === "object") return unwrapResult(row.output);
  }
  return payload;
}

async function writeThreadId(agentDir: string, runResult: unknown): Promise<void> {
  const threadId = await extractThreadId(agentDir, runResult);
  if (!threadId) return;
  try {
    await writeFile(path.join(agentDir, ".thread"), `${threadId}\n`, "utf8");
  } catch {
    // Best effort: missing thread state is not fatal.
  }
}

async function extractThreadId(agentDir: string, runResult: unknown): Promise<string | null> {
  const direct = findThreadId(runResult) ?? findThreadId(parseMaybeJson((runResult as { stdout?: unknown } | null | undefined)?.stdout));
  if (direct) return direct;
  const runDir = findRunDir(runResult) ?? findRunDir(parseMaybeJson((runResult as { stdout?: unknown } | null | undefined)?.stdout));
  if (runDir) {
    const found = await readJournalThread(path.resolve(agentDir, runDir));
    if (found) return found;
  }
  const runId = findRunId(runResult) ?? findRunId(parseMaybeJson((runResult as { stdout?: unknown } | null | undefined)?.stdout));
  if (runId) return readJournalThread(path.join(agentDir, ".ultracodex", "runs", runId));
  return null;
}

function findThreadId(value: unknown): string | null {
  if (!value || typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findThreadId(value[index]);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.threadId === "string" && row.threadId.trim()) return row.threadId.trim();
  for (const child of Object.values(row)) {
    const found = findThreadId(child);
    if (found) return found;
  }
  return null;
}

function findRunDir(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.runDir === "string" && row.runDir.trim()) return row.runDir.trim();
  for (const child of Object.values(row)) {
    const found = findRunDir(child);
    if (found) return found;
  }
  return null;
}

function findRunId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.runId === "string" && row.runId.trim()) return row.runId.trim();
  for (const child of Object.values(row)) {
    const found = findRunId(child);
    if (found) return found;
  }
  return null;
}

async function readJournalThread(runDir: string): Promise<string | null> {
  try {
    const text = await readFile(path.join(runDir, "journal.jsonl"), "utf8");
    let threadId: string | null = null;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const found = findThreadId(parseMaybeJson(line));
      if (found) threadId = found;
    }
    return threadId;
  } catch {
    return null;
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value.trim()) as unknown;
  } catch {
    return null;
  }
}

async function scanInbox(agentDir: string, date: string): Promise<InboxSelection> {
  const entries = await safeReaddir(path.join(agentDir, "inbox"));
  const items: Array<{ name: string; sortDate: string | null; sourceDate: string | null }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || entry.name === ".gitkeep") continue;
    const text = await readFile(path.join(agentDir, "inbox", entry.name), "utf8");
    const dates = parseInboxDates(text);
    items.push({ name: entry.name, sortDate: dates.sourceDate ?? dates.received, sourceDate: dates.sourceDate });
  }
  items.sort(compareInboxItems);
  const cap = parseWakeCap(process.env.ORG_WAKE_CAP);
  const selected = items.slice(0, cap);
  const staleDate = addDays(date, -14);
  return {
    items: selected.map((item) => item.name),
    backlog: items.length - selected.length,
    historical: selected.filter((item) => item.sourceDate && item.sourceDate < staleDate).map((item) => item.name),
  };
}

function parseInboxDates(text: string): { received: string | null; sourceDate: string | null } {
  const frontmatter = parseLooseFrontmatter(text);
  return {
    received: firstDate(frontmatter.received),
    sourceDate: firstDate(frontmatter.documentdate, frontmatter.sourcedate, frontmatter.date, parseBodyDocumentDate(text)),
  };
}

function parseBodyDocumentDate(text: string): string | null {
  const match = text.match(/^Document date\s*:\s*(\d{4}-\d{2}-\d{2})\b/imu);
  return match ? match[1]! : null;
}

function compareInboxItems(
  left: { name: string; sortDate: string | null },
  right: { name: string; sortDate: string | null },
): number {
  if (left.sortDate && right.sortDate && left.sortDate !== right.sortDate) return left.sortDate.localeCompare(right.sortDate);
  if (left.sortDate && !right.sortDate) return -1;
  if (!left.sortDate && right.sortDate) return 1;
  return left.name.localeCompare(right.name);
}

function parseWakeCap(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_WAKE_CAP;
  const cap = Number(raw);
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`ORG_WAKE_CAP must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return cap;
}

async function detectRole(agentDir: string): Promise<"root" | "group" | "entity"> {
  if (await hasFiles(agentDir, ENTITY_FILES)) return "entity";
  if (await hasFiles(agentDir, GROUP_FILES)) return "group";
  if (await hasFiles(agentDir, ROOT_FILES)) return "root";
  throw new Error(`${agentDir} is not a recognized agent directory`);
}

async function hasFiles(dir: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    if ((await pathKind(path.join(dir, file))) !== "file") return false;
  }
  return true;
}

async function safeReaddir(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

async function pathKind(file: string): Promise<"file" | "dir" | "other" | "missing"> {
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

function rootForAgent(agentDir: string, role: string): string {
  if (role === "entity") return path.dirname(path.dirname(agentDir));
  if (role === "group") return path.dirname(agentDir);
  return agentDir;
}

function labelFor(agentRel: string, role: string): string {
  if (role === "root") return "root";
  const parts = agentRel.split("/").filter(Boolean);
  return role === "entity" ? parts.at(-1) ?? role : parts.join("-");
}

function assertDate(date: string): void {
  if (!DATE_RE.test(date)) throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export const internals = { scanInbox, engineCommand, dateOnly, fromPosix, posixJoin };
