import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, assertIsoDate, fromPosix, pathKind, todayIso } from "./common.js";

const MEMORY_BY_ROLE = {
  root: ["BRIEF.md", "LOG.md"],
  group: ["BRIEF.md", "THESIS.md", "LOG.md"],
  entity: ["BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"],
} as const;

const RESERVED_NAMES = new Set([
  "ingest",
  "templates",
  "docs",
  "coverage.toml",
  ".ultracodex",
  ".git",
  "node_modules",
  "ops",
  "runtime",
  "workflows",
  "audit",
  "user",
]);
const SAFE_DIR_SLUG = /^[A-Za-z0-9._-]+$/u;
const RUNTIME_CREATED_DIRS = new Set(["inbox", "tickets"]);

export interface CoverageGroup {
  name: string;
  title: string;
  entities: string[];
}

export interface CoverageSpec {
  collection: "groups";
  entityKey: "entities";
  groups: CoverageGroup[];
}

export interface ScaffoldReport {
  created: number;
  skipped: number;
  resetMemory: number;
  orphaned: number;
  agentsRegenerated: number;
  orphans: string[];
}

export async function initOrg(rootDir = process.cwd(), options: { date?: string } = {}): Promise<ScaffoldReport> {
  const root = path.resolve(rootDir);
  await ensurePackageTemplates(root);
  await ensureIngest(root);
  return scaffold(root, options.date ?? todayIso());
}

export async function scaffold(rootDir: string, date: string): Promise<ScaffoldReport> {
  assertIsoDate(date, "date");
  const root = path.resolve(rootDir);
  const coverage = parseCoverage(await readFile(path.join(root, "coverage.toml"), "utf8"));
  const templates = await readTemplates(root);
  const reviewDate = addDays(date, 90);
  const report: ScaffoldReport = { created: 0, skipped: 0, resetMemory: 0, orphaned: 0, agentsRegenerated: 0, orphans: [] };

  await ensureAgentDir(root, "root", {}, templates.root, date, reviewDate, report);
  for (const group of coverage.groups) {
    const groupDir = path.join(root, group.name);
    await ensureAgentDir(
      groupDir,
      "group",
      { GROUP: group.name, GROUP_TITLE: group.title },
      templates.group,
      date,
      reviewDate,
      report,
    );
    for (const entity of group.entities) {
      const entityDir = path.join(groupDir, entity);
      await ensureAgentDir(
        entityDir,
        "entity",
        { GROUP: group.name, GROUP_TITLE: group.title, ENTITY: entity },
        templates.entity,
        date,
        reviewDate,
        report,
      );
      await ensureDir(path.join(entityDir, "FACTS"), report);
    }
    await collectOrphans(groupDir, group, report);
  }
  return report;
}

async function ensurePackageTemplates(root: string): Promise<void> {
  const target = path.join(root, "templates");
  if ((await pathKind(target)) !== "missing") return;
  await mkdir(target, { recursive: true });
  const source = path.join(packageRoot(), "org-templates", "roles");
  for (const name of ["root.md", "group.md", "entity.md"]) {
    await copyFile(path.join(source, name), path.join(target, name));
  }
}

async function ensureIngest(root: string): Promise<void> {
  await mkdir(path.join(root, "ingest", "cache"), { recursive: true });
  await mkdir(path.join(root, "ingest", "unassigned"), { recursive: true });
  try {
    await writeFile(path.join(root, "ingest", "ledger.jsonl"), "", { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

async function readTemplates(root: string): Promise<Record<"root" | "group" | "entity", string>> {
  const dir = path.join(root, "templates");
  return {
    root: await readFile(path.join(dir, "root.md"), "utf8"),
    group: await readFile(path.join(dir, "group.md"), "utf8"),
    entity: await readFile(path.join(dir, "entity.md"), "utf8"),
  };
}

async function ensureAgentDir(
  dir: string,
  role: keyof typeof MEMORY_BY_ROLE,
  values: Record<string, string>,
  template: string,
  date: string,
  reviewDate: string,
  report: ScaffoldReport,
): Promise<void> {
  await ensureDir(dir, report);
  await ensureAgentsFile(dir, render(template, values), report);
  for (const memoryFile of MEMORY_BY_ROLE[role]) {
    await ensureFile(path.join(dir, memoryFile), memoryContent(memoryFile, date, reviewDate), report);
  }
  await ensureDir(path.join(dir, "inbox"), report);
}

async function ensureDir(dir: string, report: ScaffoldReport): Promise<void> {
  try {
    const found = await stat(dir);
    if (!found.isDirectory()) throw new Error(`${dir} exists but is not a directory`);
    report.skipped += 1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(dir);
    report.created += 1;
  }
}

async function ensureFile(file: string, content: string, report: ScaffoldReport): Promise<void> {
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    report.created += 1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const found = await stat(file);
    if (!found.isFile()) throw new Error(`${file} exists but is not a file`);
    report.skipped += 1;
  }
}

async function ensureAgentsFile(dir: string, content: string, report: ScaffoldReport): Promise<void> {
  const file = path.join(dir, "AGENTS.md");
  try {
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    report.created += 1;
    report.agentsRegenerated += 1;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const current = await readFile(file, "utf8");
    if (current === content) return;
    await writeFile(file, content, "utf8");
    report.agentsRegenerated += 1;
  }
}

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/gu, (_match, key: string) => values[key] ?? "");
}

function memoryContent(file: string, date: string, reviewDate: string): string {
  const body = file === "LOG.md"
    ? `- ${date} - cycle 0 - 0 items - scaffolded null entry - severity:routine\n`
    : `# ${fileTitle(file)}\n\nPLACEHOLDER: This file awaits its first cycle.\n`;
  return [
    "---",
    `updated: ${date}`,
    "sources: []",
    "confidence: speculative",
    `next_review: ${reviewDate}`,
    "---",
    "",
    body,
  ].join("\n");
}

function fileTitle(file: string): string {
  return file.replace(/\.md$/u, "").toLowerCase().replace(/(^|_)([a-z])/gu, (_match, prefix: string, char: string) => {
    return `${prefix ? " " : ""}${char.toUpperCase()}`;
  });
}

async function collectOrphans(groupDir: string, group: CoverageGroup, report: ScaffoldReport): Promise<void> {
  let entries;
  try {
    entries = await readdir(groupDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  const covered = new Set(group.entities);
  for (const entry of entries) {
    if (!entry.isDirectory() || RUNTIME_CREATED_DIRS.has(entry.name) || covered.has(entry.name)) continue;
    report.orphaned += 1;
    report.orphans.push(`${group.name}/${entry.name}`);
  }
}

export function parseCoverage(source: string): CoverageSpec {
  const groups: Array<{ name: string; title: string; entities: string[] | null }> = [];
  const seen = new Set<string>();
  let current: { name: string; title: string; entities: string[] | null } | null = null;
  for (const { number, text } of logicalLines(source)) {
    const line = stripComment(text).trim();
    if (!line) continue;
    const table = line.match(/^\[groups\.([A-Za-z0-9._-]+)\]$/u);
    if (table) {
      const name = table[1]!;
      validateDirectoryName(name, "group", number);
      const seenKey = name.toLowerCase();
      if (seen.has(seenKey)) throw new Error(`coverage.toml:${number}: duplicate group ${name}`);
      current = { name, title: "", entities: null };
      groups.push(current);
      seen.add(seenKey);
      continue;
    }
    if (!current) throw new Error(`coverage.toml:${number}: expected [groups.<name>] before values`);
    const assign = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+)$/u);
    if (!assign) throw new Error(`coverage.toml:${number}: expected key = value`);
    const key = assign[1]!;
    const value = assign[2]!;
    if (key === "title") {
      current.title = parseString(value, number);
    } else if (key === "entities") {
      current.entities = parseStringArray(value, number, key);
      for (const entity of current.entities) validateDirectoryName(entity, "entity", number);
    } else {
      throw new Error(`coverage.toml:${number}: unsupported key ${key}; expected title or entities`);
    }
  }
  for (const group of groups) {
    if (!group.title) throw new Error(`coverage.toml: group ${group.name} missing title`);
    if (!Array.isArray(group.entities)) throw new Error(`coverage.toml: group ${group.name} missing entities`);
  }
  return {
    collection: "groups",
    entityKey: "entities",
    groups: groups.map((group) => ({ name: group.name, title: group.title, entities: group.entities ?? [] })),
  };
}

function validateDirectoryName(name: string, kind: string, line: number): void {
  if (!SAFE_DIR_SLUG.test(name) || name === "." || name === "..") {
    throw new Error(`coverage.toml:${line}: unsafe ${kind} name ${JSON.stringify(name)}; directory slugs must match [A-Za-z0-9._-]+`);
  }
  if (RESERVED_NAMES.has(name.toLowerCase())) {
    throw new Error(`coverage.toml:${line}: ${kind} name ${JSON.stringify(name)} collides with a reserved top-level name`);
  }
}

function logicalLines(source: string): Array<{ number: number; text: string }> {
  const out: Array<{ number: number; text: string }> = [];
  const lines = source.split(/\r?\n/u);
  let buffer = "";
  let start = 0;
  let arrayDepth = 0;
  lines.forEach((line, index) => {
    const clean = stripComment(line);
    if (!buffer) start = index + 1;
    buffer = buffer ? `${buffer}\n${clean}` : clean;
    arrayDepth += bracketDelta(clean);
    if (arrayDepth > 0) return;
    out.push({ number: start, text: buffer });
    buffer = "";
  });
  if (buffer.trim()) out.push({ number: start, text: buffer });
  return out;
}

function bracketDelta(line: string): number {
  let delta = 0;
  let inString = false;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (char === "\"") inString = !inString;
    if (inString) continue;
    if (char === "[") delta += 1;
    if (char === "]") delta -= 1;
  }
  return delta;
}

function stripComment(line: string): string {
  let inString = false;
  let escaped = false;
  let out = "";
  for (const char of line) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      out += char;
      escaped = true;
      continue;
    }
    if (char === "\"") inString = !inString;
    if (char === "#" && !inString) break;
    out += char;
  }
  return out;
}

function parseString(value: string, line: number): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "string") throw new Error("not a string");
    return parsed;
  } catch {
    throw new Error(`coverage.toml:${line}: expected a quoted string`);
  }
}

function parseStringArray(value: string, line: number, key: string): string[] {
  const normalized = value.replace(/\s+/gu, " ").trim();
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("not a string array");
    return parsed;
  } catch {
    throw new Error(`coverage.toml:${line}: ${key} expected an array of quoted strings`);
  }
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function formatScaffoldReport(report: ScaffoldReport): string {
  return [
    `created: ${report.created}`,
    `skipped: ${report.skipped}`,
    `reset_memory: ${report.resetMemory}`,
    `orphaned: ${report.orphaned}`,
    `agents_regenerated: ${report.agentsRegenerated}`,
    `orphans: ${report.orphans.length ? report.orphans.join(", ") : "none"}`,
  ].join("\n");
}

export const internals = { fromPosix };
