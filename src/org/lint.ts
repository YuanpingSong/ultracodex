import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  fromPosix,
  isIsoDate,
  maybeReadText,
  normalizeRepoPath,
  parseFrontmatter,
  pathKind,
  posixJoin,
  safeReaddir,
  scalarField,
} from "./common.js";
import { parseCoverage } from "./scaffold.js";

const CONFIDENCE = new Set(["speculative", "possible", "likely", "high-confidence"]);
const SEVERITIES = new Set(["routine", "notable", "material", "urgent"]);
const MEMORY_SEVERITY_MARKER = /\bseverity\s*[:=]\s*["']?([A-Za-z][A-Za-z0-9_-]*)["']?/giu;
const REQUIRED_FRONTMATTER = ["updated", "sources", "confidence", "next_review"];
const EXEMPT_DIFF_TOP = new Set([".ultracodex", "ingest", "templates", "docs", "coverage.toml", "node_modules"]);

const ROLE_RULES = {
  root: {
    files: ["AGENTS.md", "BRIEF.md", "LOG.md"],
    dirs: ["inbox"],
    memory: ["BRIEF.md", "LOG.md"],
  },
  group: {
    files: ["AGENTS.md", "BRIEF.md", "THESIS.md", "LOG.md"],
    dirs: ["inbox"],
    memory: ["BRIEF.md", "THESIS.md", "LOG.md"],
  },
  entity: {
    files: ["AGENTS.md", "BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"],
    dirs: ["inbox", "FACTS"],
    memory: ["BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"],
  },
} as const;

const ROOT_OWNED: Set<string> = new Set([...ROLE_RULES.root.files, ...ROLE_RULES.root.dirs]);

export interface Finding {
  level: "ERROR" | "WARN";
  path: string;
  message: string;
  line: number | null;
  agent?: string;
}

interface InventoryAgent {
  role: keyof typeof ROLE_RULES;
  dir: string;
}

interface Inventory {
  agents: InventoryAgent[];
  byDir: Map<string, InventoryAgent>;
  sorted: InventoryAgent[];
}

export interface LintOptions {
  today?: string;
  strict?: boolean;
  strictReview?: boolean;
  cycle?: number;
  diffPaths?: string[] | string;
  invokedPaths?: string[] | string;
}

export async function lintTree(rootDir = process.cwd(), options: LintOptions = {}): Promise<Finding[]> {
  const root = path.resolve(rootDir);
  const findings: Finding[] = [];
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const inventory = await loadInventory(root, findings);
  await validateAgents(root, inventory, findings, today, Boolean(options.strictReview ?? options.strict));
  if (options.cycle !== undefined && options.cycle !== null) {
    await validateLiveness(root, inventory, Number(options.cycle), options.invokedPaths ?? [], findings);
  }
  if (options.diffPaths !== undefined) validateSingleWriter(inventory, options.diffPaths, options.invokedPaths ?? [], findings);
  annotateFindings(findings, inventory);
  return findings;
}

export function formatFinding(finding: Finding): string {
  return `${finding.level} · ${finding.path || "."} · ${finding.message}`;
}

export function jsonFindings(findings: Finding[]): Array<{ severity: string; agent: string; file: string; line: number | null; message: string }> {
  return findings.map((finding) => ({
    severity: finding.level,
    agent: finding.agent ?? ".",
    file: finding.path || ".",
    line: Number.isInteger(finding.line) ? finding.line : lineFromMessage(finding.message),
    message: finding.message,
  }));
}

async function loadInventory(root: string, findings: Finding[]): Promise<Inventory> {
  const coverage = await readCoverage(root, findings);
  const scanned = await scanInventory(root);
  if (coverage.length > 0) return mergeInventories(inventoryFromCoverage(coverage), scanned);
  return scanned;
}

async function readCoverage(root: string, findings: Finding[]): Promise<Array<{ name: string; title: string; entities: string[] }>> {
  const text = await maybeReadText(path.join(root, "coverage.toml"));
  if (text === null) return [];
  try {
    return parseCoverage(text).groups;
  } catch (err) {
    add(findings, "ERROR", "coverage.toml", `invalid coverage.toml: ${(err as Error).message}`);
    return [];
  }
}

function inventoryFromCoverage(groups: Array<{ name: string; entities: string[] }>): Inventory {
  const agents: InventoryAgent[] = [{ role: "root", dir: "" }];
  for (const group of groups) {
    agents.push({ role: "group", dir: group.name });
    for (const entity of group.entities) agents.push({ role: "entity", dir: posixJoin(group.name, entity) });
  }
  return makeInventory(agents);
}

function mergeInventories(...inventories: Inventory[]): Inventory {
  const byDir = new Map<string, InventoryAgent>();
  for (const inventory of inventories) {
    for (const agent of inventory.agents) {
      if (!byDir.has(agent.dir)) byDir.set(agent.dir, agent);
    }
  }
  return makeInventory([...byDir.values()]);
}

async function scanInventory(root: string): Promise<Inventory> {
  const agents: InventoryAgent[] = [{ role: "root", dir: "" }];
  for (const entry of await safeReaddir(root)) {
    if (!entry.isDirectory() || shouldSkipTopLevel(entry.name)) continue;
    const groupDir = entry.name;
    if (!(await looksLikeAgentDir(root, groupDir, "group"))) continue;
    agents.push({ role: "group", dir: groupDir });
    for (const child of await safeReaddir(path.join(root, groupDir))) {
      if (!child.isDirectory()) continue;
      const entityDir = posixJoin(groupDir, child.name);
      if (await looksLikeAgentDir(root, entityDir, "entity")) agents.push({ role: "entity", dir: entityDir });
    }
  }
  return makeInventory(agents);
}

function shouldSkipTopLevel(name: string): boolean {
  return name.startsWith(".") || ["docs", "templates", "ingest", "node_modules"].includes(name);
}

async function looksLikeAgentDir(root: string, dir: string, role: "group" | "entity"): Promise<boolean> {
  const checks = role === "group" ? ["AGENTS.md", "BRIEF.md", "LOG.md"] : ["AGENTS.md", "BRIEF.md", "THESIS.md", "LOG.md"];
  for (const rel of checks) {
    if ((await pathKind(path.join(root, fromPosix(posixJoin(dir, rel))))) !== "file") return false;
  }
  return true;
}

function makeInventory(agents: InventoryAgent[]): Inventory {
  const sortedAgents = [...agents].sort((a, b) => b.dir.length - a.dir.length);
  return { agents, byDir: new Map(agents.map((agent) => [agent.dir, agent])), sorted: sortedAgents };
}

async function validateAgents(root: string, inventory: Inventory, findings: Finding[], today: string, strictReview: boolean): Promise<void> {
  for (const agent of inventory.agents) {
    const rules = ROLE_RULES[agent.role];
    for (const rel of rules.files) {
      const fileRel = agentRel(agent, rel);
      const kind = await pathKind(path.join(root, fromPosix(fileRel)));
      if (kind !== "file") add(findings, "ERROR", fileRel, kind === "missing" ? "missing required file" : "required path is not a file");
    }
    for (const rel of rules.dirs) {
      const dirRel = agentRel(agent, rel);
      const kind = await pathKind(path.join(root, fromPosix(dirRel)));
      if (kind !== "dir") add(findings, "ERROR", dirRel, kind === "missing" ? "missing required directory" : "required path is not a directory");
    }
    for (const rel of rules.memory) {
      const fileRel = agentRel(agent, rel);
      if ((await pathKind(path.join(root, fromPosix(fileRel)))) !== "file") continue;
      await validateMemoryFile(root, agent, rel, findings, today, strictReview);
    }
  }
}

async function validateMemoryFile(
  root: string,
  agent: InventoryAgent,
  rel: string,
  findings: Finding[],
  today: string,
  strictReview: boolean,
): Promise<void> {
  const fileRel = agentRel(agent, rel);
  const text = await readFile(path.join(root, fromPosix(fileRel)), "utf8");
  let parsed;
  try {
    parsed = parseFrontmatter(text, fileRel);
  } catch (err) {
    add(findings, "ERROR", fileRel, (err as Error).message.replace(`${fileRel} `, ""));
    return;
  }
  validateFrontmatterFields(fileRel, parsed.fields, findings, today, strictReview);
  parsed.bodyLines.forEach((line, index) => validateSeverityMarker(fileRel, line, parsed.bodyStartLine + index, findings));
  if (rel === "BRIEF.md" && parsed.bodyLineCount > 80) {
    add(findings, "ERROR", fileRel, `BRIEF body has ${parsed.bodyLineCount} lines; max is 80`);
  }
  if (rel === "WATCHLIST.md") {
    parsed.bodyLines.forEach((line, index) => validateWatchlistLine(fileRel, line, parsed.bodyStartLine + index, findings, today));
  }
  if (rel === "THESIS.md") {
    parsed.bodyLines.forEach((line, index) => validateThesisLine(fileRel, line, parsed.bodyStartLine + index, findings));
  }
}

function validateFrontmatterFields(
  fileRel: string,
  fields: Record<string, string | string[]>,
  findings: Finding[],
  today: string,
  strictReview: boolean,
): void {
  for (const required of REQUIRED_FRONTMATTER) {
    if (!Object.prototype.hasOwnProperty.call(fields, required)) add(findings, "ERROR", fileRel, `frontmatter missing ${required}`);
  }
  if (Object.prototype.hasOwnProperty.call(fields, "sources") && !Array.isArray(fields.sources)) {
    add(findings, "ERROR", fileRel, "frontmatter sources must be an array");
  }
  const confidence = optionalScalar(fileRel, fields, "confidence", findings);
  if (confidence !== null && !CONFIDENCE.has(confidence)) {
    add(findings, "ERROR", fileRel, `frontmatter confidence ${JSON.stringify(confidence)} is not in contract vocabulary`);
  }
  const updated = optionalScalar(fileRel, fields, "updated", findings);
  if (updated !== null && !isIsoDate(updated)) add(findings, "ERROR", fileRel, "frontmatter updated is not a valid YYYY-MM-DD date");
  const nextReview = optionalScalar(fileRel, fields, "next_review", findings);
  if (nextReview !== null && !isIsoDate(nextReview)) {
    add(findings, "ERROR", fileRel, "frontmatter next_review is not a valid YYYY-MM-DD date");
    return;
  }
  if (nextReview !== null && nextReview < today) {
    add(findings, strictReview ? "ERROR" : "WARN", fileRel, `frontmatter next_review ${nextReview} is in the past`);
  }
}

function optionalScalar(fileRel: string, fields: Record<string, string | string[]>, key: string, findings: Finding[]): string | null {
  if (!Object.prototype.hasOwnProperty.call(fields, key)) return null;
  try {
    return scalarField(fields, key, fileRel);
  } catch {
    add(findings, "ERROR", fileRel, `frontmatter ${key} must be a scalar`);
    return null;
  }
}

function validateWatchlistLine(fileRel: string, line: string, lineNumber: number, findings: Finding[], today: string): void {
  if (!isListItem(line)) return;
  const validDates = [...line.matchAll(/\b\d{4}-\d{2}-\d{2}\b/gu)].map((match) => match[0]).filter(isIsoDate);
  if (validDates.length === 0) {
    add(findings, "ERROR", fileRel, `WATCHLIST item line ${lineNumber} has no valid YYYY-MM-DD date`, lineNumber);
    return;
  }
  const governingDate = validDates.at(-1)!;
  if (governingDate < today) add(findings, "WARN", fileRel, `WATCHLIST item line ${lineNumber} expired on ${governingDate}`, lineNumber);
}

function validateThesisLine(fileRel: string, line: string, lineNumber: number, findings: Finding[]): void {
  if (!isListItem(line)) return;
  if (!/\[[^\]\s][^\]]*\]/u.test(line)) {
    add(findings, "ERROR", fileRel, `THESIS claim line ${lineNumber} has no provenance ref`, lineNumber);
  }
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+/u.test(line);
}

function validateSeverityMarker(fileRel: string, line: string, lineNumber: number, findings: Finding[]): void {
  for (const match of line.matchAll(MEMORY_SEVERITY_MARKER)) {
    const raw = match[1] ?? "";
    if (!SEVERITIES.has(raw.toLowerCase())) {
      add(findings, "ERROR", fileRel, `severity marker ${JSON.stringify(raw)} is not in contract vocabulary`, lineNumber);
    }
  }
}

async function validateLiveness(
  root: string,
  inventory: Inventory,
  cycle: number,
  rawInvokedPaths: string[] | string,
  findings: Finding[],
): Promise<void> {
  if (!Number.isInteger(cycle)) {
    add(findings, "ERROR", "(cli)", "--cycle must be an integer");
    return;
  }
  const ledgerRel = "ingest/ledger.jsonl";
  const due = new Set<string>(splitPathList(rawInvokedPaths).map(normalizeInvokedPath));
  const text = await maybeReadText(path.join(root, ledgerRel));
  if (text === null) {
    add(findings, "ERROR", ledgerRel, "missing ledger for --cycle liveness check");
  } else {
    text.split(/\r?\n/u).forEach((line, index) => {
      if (!line.trim()) return;
      let record: unknown;
      try {
        record = JSON.parse(line) as unknown;
      } catch {
        add(findings, "ERROR", ledgerRel, `line ${index + 1} is not valid JSON`);
        return;
      }
      if (!recordCycleMatches(record, cycle)) return;
      for (const dir of deliveryAgentDirs(record, inventory)) due.add(dir);
    });
  }
  const cyclePattern = new RegExp(`\\bcycle\\s+${String(cycle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "iu");
  for (const dir of [...due].sort()) {
    const agent = inventory.byDir.get(dir);
    if (!agent) continue;
    const logRel = agentRel(agent, "LOG.md");
    const logText = await maybeReadText(path.join(root, fromPosix(logRel)));
    if (logText === null || !cyclePattern.test(logText)) add(findings, "ERROR", logRel, `missing LOG entry mentioning cycle ${cycle}`);
  }
}

function recordCycleMatches(record: unknown, cycle: number): boolean {
  if (!record || typeof record !== "object") return false;
  const row = record as Record<string, unknown>;
  for (const key of ["cycle", "cycle_id", "cycleId"]) {
    if (Object.prototype.hasOwnProperty.call(row, key) && Number(row[key]) === cycle) return true;
  }
  return false;
}

function deliveryAgentDirs(record: unknown, inventory: Inventory): Set<string> {
  const dirs = new Set<string>();
  collectDeliveryDirs(record, inventory, dirs);
  return dirs;
}

function collectDeliveryDirs(value: unknown, inventory: Inventory, dirs: Set<string>): void {
  if (!value) return;
  if (typeof value === "string") {
    const dir = agentDirFromCandidate(value, inventory);
    if (dir !== null) dirs.add(dir);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDeliveryDirs(item, inventory, dirs);
    return;
  }
  if (typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (isTicketFileDelivery(row)) return;
  const candidateKeys = [
    "agent",
    "agentPath",
    "agent_path",
    "agentDir",
    "agent_dir",
    "to",
    "target",
    "targetAgent",
    "target_agent",
    "deliveredTo",
    "delivered_to",
    "routedTo",
    "routed_to",
    "dir",
    "inbox",
    "inboxPath",
    "inbox_path",
  ];
  for (const key of candidateKeys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
    const dir = agentDirFromCandidate(row[key], inventory);
    if (dir !== null) dirs.add(dir);
  }
  for (const key of ["delivery", "deliveries", "route", "routing"]) {
    if (Object.prototype.hasOwnProperty.call(row, key)) collectDeliveryDirs(row[key], inventory, dirs);
  }
}

function isTicketFileDelivery(row: Record<string, unknown>): boolean {
  const action = typeof row.action === "string" ? row.action.toLowerCase() : "";
  if (action === "ticket" || action === "reply") return true;
  for (const key of ["routedTo", "routed_to", "relPath", "rel_path", "path"]) {
    if (isTicketFilePath(row[key])) return true;
  }
  return false;
}

function isTicketFilePath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = normalizeRepoPath(value);
  return normalized !== null && /(?:^|\/)tickets\/[^/]+\.md$/u.test(normalized);
}

function agentDirFromCandidate(value: unknown, inventory: Inventory): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeRepoPath(value);
  if (normalized === null) return null;
  if (normalized === "root" || normalized === ".") return "";
  if (normalized === "inbox" || normalized.startsWith("inbox/")) return "";
  const inboxIndex = normalized.indexOf("/inbox/");
  const candidate = inboxIndex >= 0 ? normalized.slice(0, inboxIndex) : normalized;
  const agent = closestAgentForPath(candidate, inventory);
  return agent?.dir ?? null;
}

function validateSingleWriter(
  inventory: Inventory,
  rawDiffPaths: string[] | string,
  rawInvokedPaths: string[] | string,
  findings: Finding[],
): void {
  const diffPaths = splitPathList(rawDiffPaths);
  const invoked = new Set(splitPathList(rawInvokedPaths).map(normalizeInvokedPath));
  if (diffPaths.length > 0 && invoked.size === 0) add(findings, "ERROR", "(cli)", "--invoked is required when --diff is used");
  for (const dir of invoked) {
    if (!inventory.byDir.has(dir)) add(findings, "ERROR", "(cli)", `--invoked references unknown agent ${labelAgentDir(dir)}`);
  }
  for (const raw of diffPaths) {
    const rel = normalizeRepoPath(raw);
    if (rel === null || rel === "") {
      add(findings, "ERROR", raw || "(empty diff path)", "diff path is not a repo-relative path");
      continue;
    }
    const top = rel.split("/")[0]!;
    if (EXEMPT_DIFF_TOP.has(top)) continue;
    const owner = ownerForDiffPath(rel, inventory);
    if (!owner) {
      add(findings, "ERROR", rel, "diff path is outside an invoked agent directory");
      continue;
    }
    if (!invoked.has(owner.dir)) {
      add(findings, "ERROR", rel, `diff path belongs to ${labelAgentDir(owner.dir)} but --invoked did not include it`);
    }
  }
}

function ownerForDiffPath(rel: string, inventory: Inventory): InventoryAgent | null {
  const agent = closestAgentForPath(rel, inventory);
  if (agent && agent.dir !== "") return agent;
  const first = rel.split("/")[0]!;
  if (ROOT_OWNED.has(first)) return inventory.byDir.get("") ?? null;
  return null;
}

function closestAgentForPath(rel: string, inventory: Inventory): InventoryAgent | null {
  for (const agent of inventory.sorted) {
    if (agent.dir === "") continue;
    if (rel === agent.dir || rel.startsWith(`${agent.dir}/`)) return agent;
  }
  return null;
}

function splitPathList(value: string[] | string | null | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(splitPathList);
  return String(value).split(/[,\n]/u).map((part) => part.trim()).filter(Boolean);
}

function normalizeInvokedPath(value: string): string {
  const normalized = normalizeRepoPath(value);
  if (normalized === null || normalized === "" || normalized === ".") return "";
  return normalized.replace(/\/+$/u, "");
}

function annotateFindings(findings: Finding[], inventory: Inventory): void {
  for (const finding of findings) finding.agent = agentForFindingPath(finding.path, inventory);
}

function agentForFindingPath(filePath: string, inventory: Inventory): string {
  const normalized = normalizeRepoPath(filePath);
  if (normalized === null || normalized === "" || normalized.startsWith("(")) return ".";
  const owner = ownerForDiffPath(normalized, inventory);
  if (owner) return labelAgentDir(owner.dir);
  const closest = closestAgentForPath(normalized, inventory);
  if (closest) return labelAgentDir(closest.dir);
  return ".";
}

function lineFromMessage(message: string): number | null {
  const match = String(message).match(/\bline\s+(\d+)\b/iu);
  return match ? Number(match[1]) : null;
}

function agentRel(agent: InventoryAgent, rel: string): string {
  return agent.dir ? posixJoin(agent.dir, rel) : rel;
}

function labelAgentDir(dir: string): string {
  return dir === "" ? "." : dir;
}

function add(findings: Finding[], level: Finding["level"], filePath: string, message: string, line: number | null = null): void {
  findings.push({ level, path: filePath, message, line });
}
