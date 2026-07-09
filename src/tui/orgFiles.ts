import fs from "node:fs";
import path from "node:path";
import { STATE_RELATIVE_PATH } from "../org/state.js";
import { parseCoverage } from "../org/scaffold.js";
import {
  agentRel,
  buildOrgSnapshot,
  normalizeOrgAgentPath,
  type OrgAgentRead,
  type OrgBriefReadState,
  type OrgFileRead,
  type OrgInboxItemRead,
  type OrgRole,
  type OrgSnapshot,
  type OrgSnapshotReads,
} from "./org.js";

export const ORG_STATE_DIR_RELATIVE_PATH = ".ultracodex/org/state";
export const BRIEFS_READ_RELATIVE_PATH = ".ultracodex/org/state/briefs-read.json";
const AUDIT_HISTORY_RELATIVE_PATH = ".ultracodex/org/state/audit-history.jsonl";
const LEDGER_RELATIVE_PATH = "ingest/ledger.jsonl";
const LEDGER_TAIL_LINES = 200;
const FINGERPRINT_DIR_CHILD_LIMIT = 200;
const SKIP_SCAN_DIRS = new Set([".git", ".ultracodex", ".codex", "docs", "ingest", "node_modules", "templates", "workflows"]);

export interface OrgSnapshotLoad {
  fingerprint: string;
  snapshot: OrgSnapshot;
}

interface InventoryAgent {
  path: string;
  role: OrgRole;
  parent: string | null;
}

export function isOrgProject(projectDir: string): boolean {
  return isFile(path.join(projectDir, "coverage.toml")) && isFile(path.join(projectDir, "AGENTS.md"));
}

export function loadOrgSnapshot(projectDir: string, now: string | number | Date = Date.now()): OrgSnapshotLoad {
  const fingerprint = orgSourceFingerprint(projectDir);
  return { fingerprint, snapshot: buildOrgSnapshot(loadOrgSnapshotReads(projectDir, now)) };
}

export function refreshOrgSnapshot(
  projectDir: string,
  previous: OrgSnapshotLoad | null,
  now: string | number | Date = Date.now(),
): OrgSnapshotLoad {
  const fingerprint = orgSourceFingerprint(projectDir);
  if (previous !== null && previous.fingerprint === fingerprint) return previous;
  return { fingerprint, snapshot: buildOrgSnapshot(loadOrgSnapshotReads(projectDir, now)) };
}

export function loadOrgSnapshotReads(projectDir: string, now: string | number | Date = Date.now()): OrgSnapshotReads {
  const root = path.resolve(projectDir);
  const warnings: string[] = [];
  const inventory = loadInventory(root, warnings);
  return {
    orgName: path.basename(root),
    now,
    agents: inventory.map((agent) => readAgent(root, agent, warnings)),
    lastWake: readJson(path.join(root, fromPosix(STATE_RELATIVE_PATH)), {}, warnings),
    auditHistory: readJsonl(path.join(root, fromPosix(AUDIT_HISTORY_RELATIVE_PATH)), { tail: undefined }, warnings),
    ledgerTail: readJsonl(path.join(root, fromPosix(LEDGER_RELATIVE_PATH)), { tail: LEDGER_TAIL_LINES }, warnings),
    briefRead: readBriefReadState(root, warnings),
    warnings,
  };
}

export function readBriefReadState(projectDir: string, warnings: string[] = []): OrgBriefReadState {
  const raw = readJson(path.join(path.resolve(projectDir), fromPosix(BRIEFS_READ_RELATIVE_PATH)), {}, warnings);
  const visits = isRecord(raw.visits) ? raw.visits : raw;
  const out: Record<string, string> = {};
  for (const [agentPath, value] of Object.entries(visits ?? {})) {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) out[normalizeOrgAgentPath(agentPath)] = new Date(parsed).toISOString();
  }
  return { version: 1, visits: out };
}

export function markOrgBriefRead(
  projectDir: string,
  agentPath = ".",
  options: { at?: string | number | Date } = {},
): OrgBriefReadState {
  const root = path.resolve(projectDir);
  const current = readBriefReadState(root);
  const at = options.at === undefined ? new Date() : new Date(options.at);
  current.visits[normalizeOrgAgentPath(agentPath)] = (Number.isNaN(at.getTime()) ? new Date() : at).toISOString();
  const file = path.join(root, fromPosix(BRIEFS_READ_RELATIVE_PATH));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  return current;
}

export function orgSourceFingerprint(projectDir: string): string {
  const root = path.resolve(projectDir);
  const warnings: string[] = [];
  const filePaths = new Set([
    path.join(root, "coverage.toml"),
    path.join(root, "AGENTS.md"),
    path.join(root, fromPosix(STATE_RELATIVE_PATH)),
    path.join(root, fromPosix(BRIEFS_READ_RELATIVE_PATH)),
    path.join(root, fromPosix(AUDIT_HISTORY_RELATIVE_PATH)),
    path.join(root, fromPosix(LEDGER_RELATIVE_PATH)),
  ]);
  const childDirs = new Set<string>();
  for (const agent of loadInventory(root, warnings)) {
    const dir = agentDir(root, agent.path);
    filePaths.add(path.join(dir, "AGENTS.md"));
    for (const file of memoryFilesForRole(agent.role)) filePaths.add(path.join(dir, file));
    childDirs.add(path.join(dir, "inbox"));
    childDirs.add(path.join(dir, "tickets"));
  }

  const parts: string[] = [];
  for (const item of [...filePaths].sort()) appendPathFingerprintPart(parts, item);
  for (const dir of [...childDirs].sort()) appendDirectoryFingerprintPart(parts, dir, FINGERPRINT_DIR_CHILD_LIMIT);
  return parts.join("|");
}

function memoryFilesForRole(role: OrgRole): readonly string[] {
  switch (role) {
    case "root":
      return ["BRIEF.md", "LOG.md"];
    case "group":
      return ["BRIEF.md", "THESIS.md", "LOG.md"];
    case "entity":
      return ["BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"];
  }
}

function readAgent(root: string, agent: InventoryAgent, warnings: string[]): OrgAgentRead {
  const dir = agentDir(root, agent.path);
  const memoryFiles = safeReaddirSync(dir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md")
    .map((entry) => readTextFile(path.join(dir, entry.name), agentRel(agent.path, entry.name), warnings));
  return {
    path: agent.path,
    role: agent.role,
    parent: agent.parent,
    brief: readTextFile(path.join(dir, "BRIEF.md"), agentRel(agent.path, "BRIEF.md"), warnings),
    log: readTextFile(path.join(dir, "LOG.md"), agentRel(agent.path, "LOG.md"), warnings),
    memoryFiles,
    inboxItems: readInboxItems(path.join(dir, "inbox"), warnings),
    ticketFiles: readTicketFiles(path.join(dir, "tickets"), agent.path, warnings),
  };
}

function readInboxItems(dir: string, warnings: string[]): OrgInboxItemRead[] {
  return safeReaddirSync(dir)
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name !== ".gitkeep")
    .map((entry) => {
      const file = path.join(dir, entry.name);
      return { name: entry.name, text: readText(file, warnings), mtimeMs: statMtimeMs(file) };
    });
}

function readTicketFiles(dir: string, agentPath: string, warnings: string[]): OrgFileRead[] {
  return safeReaddirSync(dir)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .map((entry) => readTextFile(path.join(dir, entry.name), agentRel(agentPath, `tickets/${entry.name}`), warnings));
}

function readTextFile(file: string, relPath: string, warnings: string[]): OrgFileRead {
  return { relPath, text: readText(file, warnings), mtimeMs: statMtimeMs(file) };
}

function loadInventory(root: string, warnings: string[]): InventoryAgent[] {
  const coverageText = readText(path.join(root, "coverage.toml"), warnings);
  if (coverageText !== null) {
    try {
      const coverage = parseCoverage(coverageText);
      const agents: InventoryAgent[] = [{ path: ".", role: "root", parent: null }];
      for (const group of coverage.groups) {
        agents.push({ path: group.name, role: "group", parent: "." });
        for (const entity of group.entities) {
          agents.push({ path: `${group.name}/${entity}`, role: "entity", parent: group.name });
        }
      }
      return agents;
    } catch (err) {
      warnings.push(`coverage.toml: ${(err as Error).message}`);
    }
  }
  return scanInventory(root);
}

function scanInventory(root: string): InventoryAgent[] {
  const agents: InventoryAgent[] = [{ path: ".", role: "root", parent: null }];
  for (const entry of safeReaddirSync(root)) {
    if (!entry.isDirectory() || shouldSkipTopLevel(entry.name)) continue;
    const groupPath = entry.name;
    const groupDir = path.join(root, entry.name);
    if (!looksLikeAgentDir(groupDir, "group")) continue;
    agents.push({ path: groupPath, role: "group", parent: "." });
    for (const child of safeReaddirSync(groupDir)) {
      if (!child.isDirectory()) continue;
      const entityPath = `${groupPath}/${child.name}`;
      if (looksLikeAgentDir(path.join(groupDir, child.name), "entity")) {
        agents.push({ path: entityPath, role: "entity", parent: groupPath });
      }
    }
  }
  return agents;
}

function looksLikeAgentDir(dir: string, role: "group" | "entity"): boolean {
  const files = role === "group"
    ? ["AGENTS.md", "BRIEF.md", "THESIS.md", "LOG.md"]
    : ["AGENTS.md", "BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"];
  return files.every((file) => isFile(path.join(dir, file)));
}

function shouldSkipTopLevel(name: string): boolean {
  return name.startsWith(".") || SKIP_SCAN_DIRS.has(name);
}

function readJson(file: string, fallback: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const text = readText(file, warnings, true);
  if (text === null || !text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : fallback;
  } catch (err) {
    warnings.push(`${relativeStatePath(file)}: ${(err as Error).message}`);
    return fallback;
  }
}

function readJsonl(file: string, options: { tail: number | undefined }, warnings: string[]): unknown[] {
  const text = readText(file, warnings, true);
  if (text === null || !text.trim()) return [];
  const lines = text.trim().split(/\r?\n/u).filter(Boolean);
  return (options.tail === undefined ? lines : lines.slice(-options.tail)).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { type: "invalid-json", raw: line };
    }
  });
}

function readText(file: string, warnings: string[], optional = false): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    if (!optional) warnings.push(`${relativeStatePath(file)}: ${(err as Error).message}`);
    return null;
  }
}

function appendPathFingerprintPart(parts: string[], item: string): void {
  try {
    const info = fs.statSync(item);
    parts.push(`${item}:${info.isFile() ? "f" : info.isDirectory() ? "d" : "x"}:${info.size}:${info.mtimeMs}`);
  } catch {
    parts.push(`${item}:missing`);
  }
}

function appendDirectoryFingerprintPart(parts: string[], dir: string, childLimit: number): void {
  appendPathFingerprintPart(parts, dir);
  const entries = safeReaddirSync(dir).filter((entry) => !entry.name.startsWith(".") && entry.name !== ".gitkeep");
  parts.push(`${dir}:children:${entries.length}:limit:${childLimit}`);
  for (const entry of entries.slice(0, childLimit)) appendPathFingerprintPart(parts, path.join(dir, entry.name));
}

function safeReaddirSync(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

function statMtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function agentDir(root: string, agentPath: string): string {
  const normalized = normalizeOrgAgentPath(agentPath);
  return normalized === "." ? root : path.join(root, fromPosix(normalized));
}

function fromPosix(rel: string): string {
  return rel.split("/").join(path.sep);
}

function relativeStatePath(file: string): string {
  const normalized = file.split(path.sep).join("/");
  for (const marker of ["/.ultracodex/", "/ingest/"]) {
    const index = normalized.indexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
  }
  return path.basename(file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
