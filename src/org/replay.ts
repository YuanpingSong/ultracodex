import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  addDays,
  agentDir,
  agentRel,
  assertIsoDate,
  fromPosix,
  inlineArray,
  normalizeAgentPath,
  normalizeRepoPath,
  posixJoin,
  quoteScalar,
  safeReaddir,
} from "./common.js";
import { executeTick, scanOrg, type TickOptions } from "./scheduler.js";
import { readLastWakeState } from "./state.js";
import { scaffold, type ScaffoldReport } from "./scaffold.js";

const execFileDefault = promisify(execFileCallback);
const MAX_BUFFER = 64 * 1024 * 1024;

type ExecFile = (
  command: string,
  args: string[],
  options: { cwd: string; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

export interface PublicIngestLedgerRow {
  type: "ingest";
  at: string;
  id: string;
  date: string;
  to: string;
  item: string;
  ref?: string;
  replay?: boolean;
}

export interface ReplayDelivery {
  id: string;
  trueDate: string;
  deliverDate: string;
  to: string;
  item: string;
  ref?: string;
  inboxRelPath: string;
  faultNotes: string[];
  duplicateOf?: string;
}

export type ReplayFault =
  | { type: "drop"; id: string; spec: string }
  | { type: "dup"; id: string; spec: string }
  | { type: "late"; id: string; days: number; spec: string };

export type ReplayFaultRecord = ReplayFault & { matched: number; deliveriesAffected: number };

export interface ReplayDay {
  date: string;
  deliveries: ReplayDelivery[];
}

export interface OrgReplayOptions {
  root?: string;
  from?: string;
  to?: string;
  faults?: string;
  pristine?: boolean;
}

export interface OrgReplayDeps {
  execFile?: ExecFile;
  tickOptions?: TickOptions;
}

export interface OrgReplaySummary {
  ok: true;
  from: string | null;
  to: string | null;
  pristine: boolean;
  pristineReset: ScaffoldReport | null;
  daysSimulated: number;
  cyclesRun: number;
  itemsDelivered: number;
  inboxItemsDelivered: number;
  faultsInjected: ReplayFaultRecord[];
  days: Array<{
    date: string;
    cycle: number;
    itemsDelivered: number;
    inboxItems: number;
    noop: boolean;
    invoked: string[];
    statusLine: string;
  }>;
}

export async function deriveReplayCorpus(rootDir = process.cwd()): Promise<ReplayDelivery[]> {
  const root = path.resolve(rootDir);
  const text = await readTextIfExists(path.join(root, "ingest", "ledger.jsonl"));
  if (!text) return [];

  const candidates: PublicIngestLedgerRow[] = [];
  const replayed = new Set<string>();
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (err) {
      throw new Error(`invalid JSON in ingest/ledger.jsonl line ${index + 1}: ${(err as Error).message}`);
    }
    if (!isRecord(parsed) || parsed.type !== "ingest") continue;
    if (parsed.replay === true) {
      const key = replayMarkerKey(parsed, index + 1);
      if (key) replayed.add(key);
      continue;
    }
    const row = normalizeIngestRow(parsed, index + 1);
    candidates.push(row);
  }

  const rows: ReplayDelivery[] = [];
  for (const row of candidates) {
    const key = corpusKey(row.id, row.to, row.date);
    if (replayed.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: row.id,
      trueDate: row.date,
      deliverDate: row.date,
      to: row.to,
      item: row.item,
      ref: row.ref,
      inboxRelPath: inboxRelPath(row.to, row.item, row.id),
      faultNotes: [],
    });
  }
  return rows.sort(compareDeliveries);
}

export function parseReplayFaults(spec = ""): ReplayFault[] {
  const trimmed = String(spec ?? "").trim();
  if (!trimmed) return [];
  return splitFaultSpec(trimmed, new Set([",", ";"])).map((raw) => {
    const part = raw.trim();
    const pieces = splitFaultSpec(part, new Set([":"]));
    const type = pieces[0];
    const id = decodeFaultId(pieces[1] ?? "", part);
    if (type !== "drop" && type !== "dup" && type !== "late") throw new Error(`unknown fault ${part}`);
    if (!id) throw new Error(`fault ${part} is missing an id`);
    if (type === "drop" || type === "dup") {
      if (pieces.length !== 2) throw wrongFaultShape(part);
      return { type, id, spec: part };
    }
    if (pieces.length !== 3) throw wrongFaultShape(part);
    const days = Number(pieces[2]);
    if (!Number.isInteger(days) || days < 0) throw new Error(`fault ${part} days must be a non-negative integer`);
    return { type, id, days, spec: part };
  });
}

export function applyReplayFaults(deliveries: ReplayDelivery[], faults: ReplayFault[] = []): {
  deliveries: ReplayDelivery[];
  faults: ReplayFaultRecord[];
} {
  const records = faults.map((fault) => ({ ...fault, matched: 0, deliveriesAffected: 0 })) as ReplayFaultRecord[];
  const output: ReplayDelivery[] = [];
  for (const delivery of deliveries) {
    const drops = faultIndexes(records, delivery.id, "drop");
    if (drops.length) {
      for (const index of drops) {
        records[index]!.matched += 1;
        records[index]!.deliveriesAffected += 1;
      }
      continue;
    }

    let shifted = { ...delivery, faultNotes: [...delivery.faultNotes] };
    for (const index of faultIndexes(records, delivery.id, "late")) {
      const fault = records[index]!;
      if (fault.type !== "late") continue;
      fault.matched += 1;
      fault.deliveriesAffected += 1;
      shifted = {
        ...shifted,
        deliverDate: addDays(shifted.deliverDate, fault.days),
        faultNotes: [...shifted.faultNotes, `fault late:${fault.id}:${fault.days}`],
      };
    }
    output.push(shifted);

    for (const index of faultIndexes(records, delivery.id, "dup")) {
      const fault = records[index]!;
      fault.matched += 1;
      fault.deliveriesAffected += 1;
      output.push({
        ...shifted,
        deliverDate: addDays(shifted.deliverDate, 1),
        duplicateOf: delivery.id,
        faultNotes: [...shifted.faultNotes, `fault dup:${fault.id}`],
      });
    }
  }
  return { deliveries: output.sort(compareDeliveries), faults: records };
}

export function windowReplayDays(deliveries: ReplayDelivery[], options: { from?: string; to?: string } = {}): ReplayDay[] {
  const from = options.from ?? firstDeliveryDate(deliveries);
  const to = options.to ?? lastDeliveryDate(deliveries);
  if (!from || !to) return [];
  assertIsoDate(from, "--from");
  assertIsoDate(to, "--to");
  if (from > to) throw new Error("--from must be on or before --to");

  const byDate = new Map<string, ReplayDelivery[]>();
  for (const delivery of deliveries) {
    if (delivery.deliverDate < from || delivery.deliverDate > to) continue;
    const rows = byDate.get(delivery.deliverDate) ?? [];
    rows.push(delivery);
    byDate.set(delivery.deliverDate, rows);
  }
  return dateRange(from, to).map((date) => ({
    date,
    deliveries: (byDate.get(date) ?? []).sort(compareDeliveries),
  }));
}

export async function writeReplayDayInboxItems(rootDir: string, date: string, deliveries: ReplayDelivery[]): Promise<string[]> {
  assertIsoDate(date, "date");
  const root = path.resolve(rootDir);
  const written: string[] = [];
  for (const delivery of deliveries.sort(compareDeliveries)) {
    const relPath = delivery.inboxRelPath;
    const absolute = path.join(root, fromPosix(relPath));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, renderReplayInboxItem({ ...delivery, deliverDate: date }), "utf8");
    written.push(relPath);
  }
  return written;
}

export async function runOrgReplay(options: OrgReplayOptions = {}, deps: OrgReplayDeps = {}): Promise<OrgReplaySummary> {
  const root = path.resolve(options.root ?? process.cwd());
  const corpus = await deriveReplayCorpus(root);
  const faults = parseReplayFaults(options.faults ?? "");
  const transformed = applyReplayFaults(corpus, faults);
  const from = options.from ?? firstDeliveryDate(transformed.deliveries);
  const to = options.to ?? lastDeliveryDate(transformed.deliveries);
  const days = windowReplayDays(transformed.deliveries, { from: from ?? undefined, to: to ?? undefined });
  const execFile = deps.execFile ?? execFileDefault as ExecFile;

  let pristineReset: ScaffoldReport | null = null;
  if (options.pristine) {
    await assertReplayBranch(root, execFile);
    pristineReset = await scaffold(root, from ?? new Date().toISOString().slice(0, 10), { resetMemory: true });
  }
  if (days.length || options.pristine) await resetAgentInboxes(root);

  const summary: OrgReplaySummary = {
    ok: true,
    from: from ?? null,
    to: to ?? null,
    pristine: Boolean(options.pristine),
    pristineReset,
    daysSimulated: days.length,
    cyclesRun: 0,
    itemsDelivered: 0,
    inboxItemsDelivered: 0,
    faultsInjected: transformed.faults,
    days: [],
  };

  for (const day of days) {
    const cycle = await nextTickCycle(root);
    const inboxItems = await writeReplayDayInboxItems(root, day.date, day.deliveries);
    await appendReplayLedgerRows(root, day.date, cycle, day.deliveries);
    const tick = await executeTick(root, {
      ...deps.tickOptions,
      date: day.date,
      cycle,
      commit: false,
    });
    const invoked = Array.isArray(tick.invoked) ? tick.invoked.map(String).sort() : [];
    summary.cyclesRun += 1;
    summary.itemsDelivered += day.deliveries.length;
    summary.inboxItemsDelivered += inboxItems.length;
    summary.days.push({
      date: day.date,
      cycle,
      itemsDelivered: day.deliveries.length,
      inboxItems: inboxItems.length,
      noop: Boolean(tick.noop),
      invoked,
      statusLine: String(tick.statusLine ?? `tick ${day.date}`),
    });
  }

  return summary;
}

async function appendReplayLedgerRows(rootDir: string, date: string, cycle: number, deliveries: ReplayDelivery[]): Promise<void> {
  if (!deliveries.length) return;
  const rows = deliveries.map((delivery) => {
    const row: Record<string, unknown> = {
      type: "ingest",
      at: `${date}T00:00:00.000Z`,
      id: delivery.id,
      date,
      to: delivery.to,
      item: delivery.item,
      replay: true,
      cycle,
    };
    if (delivery.ref) row.ref = delivery.ref;
    if (delivery.trueDate !== date) row.originalDate = delivery.trueDate;
    if (delivery.duplicateOf) row.duplicateOf = delivery.duplicateOf;
    if (delivery.faultNotes.length) row.faults = delivery.faultNotes;
    return JSON.stringify(row);
  });
  const ledgerPath = path.join(path.resolve(rootDir), "ingest", "ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${rows.join("\n")}\n`, "utf8");
}

async function assertReplayBranch(root: string, execFile: ExecFile): Promise<void> {
  let current = "";
  try {
    current = (await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, maxBuffer: MAX_BUFFER })).stdout.trim();
  } catch (err) {
    throw new Error(`--pristine requires checking the current git branch: ${(err as Error).message}`);
  }
  if (!current.startsWith("replay/")) {
    throw new Error(`--pristine requires the current git branch to start with "replay/" (current: ${current || "unknown"})`);
  }
}

async function resetAgentInboxes(root: string): Promise<void> {
  const org = await scanOrg(root);
  for (const agent of org.agents) {
    const inbox = path.join(agentDir(root, agent.path), "inbox");
    for (const entry of await safeReaddir(inbox)) {
      if (!entry.isFile() || entry.name === ".gitkeep") continue;
      await rm(path.join(inbox, entry.name), { force: true });
    }
  }
}

async function nextTickCycle(root: string): Promise<number> {
  const state = await readLastWakeState(root);
  let max = 0;
  for (const record of Object.values(state)) {
    const cycle = Number(record?.cycle);
    if (Number.isInteger(cycle) && cycle > max) max = cycle;
  }
  return max + 1;
}

function normalizeIngestRow(row: Record<string, unknown>, line: number): PublicIngestLedgerRow {
  const at = stringField(row, "at", line);
  const id = stringField(row, "id", line);
  const date = assertIsoDate(stringField(row, "date", line), `ingest/ledger.jsonl line ${line} date`);
  const to = normalizeAgentPath(stringField(row, "to", line));
  const item = stringField(row, "item", line);
  const ref = optionalStringField(row, "ref", line);
  return ref === undefined
    ? { type: "ingest", at, id, date, to, item, replay: row.replay === true }
    : { type: "ingest", at, id, date, to, item, ref, replay: row.replay === true };
}

function replayMarkerKey(row: Record<string, unknown>, line: number): string | null {
  try {
    const id = stringField(row, "id", line);
    const to = normalizeAgentPath(stringField(row, "to", line));
    const date = assertIsoDate(
      optionalStringField(row, "originalDate", line) ?? stringField(row, "date", line),
      `ingest/ledger.jsonl line ${line} replay date`,
    );
    return corpusKey(id, to, date);
  } catch {
    return null;
  }
}

function corpusKey(id: string, to: string, date: string): string {
  return `${id}\0${to}\0${date}`;
}

function stringField(row: Record<string, unknown>, field: string, line: number): string {
  const value = row[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ingest/ledger.jsonl line ${line} ingest row missing string ${field}`);
  }
  return value.trim();
}

function optionalStringField(row: Record<string, unknown>, field: string, line: number): string | undefined {
  const value = row[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`ingest/ledger.jsonl line ${line} ingest row ${field} must be a string`);
  }
  return value.trim();
}

function splitFaultSpec(value: string, separators: Set<string>): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escape = false;
  for (const char of value) {
    if (escape) {
      current += char;
      escape = false;
      continue;
    }
    if (quoted && char === "\\") {
      current += char;
      escape = true;
      continue;
    }
    if (char === "\"") quoted = !quoted;
    if (!quoted && separators.has(char)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quoted) throw new Error(`fault spec has an unterminated quoted id`);
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function decodeFaultId(value: string, spec: string): string {
  const id = value.trim();
  if (!id) return "";
  if (!id.startsWith("\"")) return id;
  try {
    const parsed = JSON.parse(id) as unknown;
    if (typeof parsed !== "string") throw new Error("not a string");
    return parsed.trim();
  } catch (err) {
    throw new Error(`fault ${spec} has an invalid quoted id: ${(err as Error).message}`);
  }
}

function wrongFaultShape(part: string): Error {
  return new Error(`fault ${part} has the wrong shape; quote ids containing ":", "," or ";" as JSON strings`);
}

function inboxRelPath(agentPath: string, item: string, id: string): string {
  const normalizedItem = normalizeRepoPath(item);
  if (normalizedItem && normalizedItem.endsWith(".md") && (normalizedItem.startsWith("inbox/") || normalizedItem.includes("/inbox/"))) {
    return normalizedItem;
  }
  if (normalizedItem && normalizedItem.endsWith(".md") && !normalizedItem.includes("/")) {
    return agentRel(agentPath, posixJoin("inbox", normalizedItem));
  }
  return agentRel(agentPath, posixJoin("inbox", `${escapeFallbackFilename(id)}.md`));
}

function escapeFallbackFilename(id: string): string {
  let out = "";
  for (const char of id) {
    if (/^[A-Za-z0-9._-]$/u.test(char)) {
      out += char;
      continue;
    }
    for (const byte of Buffer.from(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out || "item";
}

function renderReplayInboxItem(delivery: ReplayDelivery): string {
  const refs = delivery.ref ? [delivery.ref] : [];
  const title = delivery.item.endsWith(".md") ? `Ingest ${delivery.id}` : delivery.item;
  const lines = [
    "---",
    `id: ${quoteScalar(delivery.id)}`,
    "type: ingest",
    "from: ingest",
    `received: ${delivery.deliverDate}`,
    `refs: ${inlineArray(refs)}`,
    "---",
    "",
    `# ${title}`,
    "",
    `Item: ${delivery.item}`,
    `Source date: ${delivery.trueDate}`,
  ];
  if (delivery.ref) lines.push(`Reference: ${delivery.ref}`);
  if (delivery.duplicateOf) lines.push(`Duplicate of: ${delivery.duplicateOf}`);
  if (delivery.faultNotes.length) lines.push(`Replay faults: ${delivery.faultNotes.join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

function faultIndexes(faults: ReplayFaultRecord[], id: string, type: ReplayFault["type"]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < faults.length; index += 1) {
    const fault = faults[index];
    if (fault?.type === type && fault.id === id) indexes.push(index);
  }
  return indexes;
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function firstDeliveryDate(deliveries: ReplayDelivery[]): string | null {
  return deliveries.length ? deliveries[0]!.deliverDate : null;
}

function lastDeliveryDate(deliveries: ReplayDelivery[]): string | null {
  return deliveries.length ? deliveries[deliveries.length - 1]!.deliverDate : null;
}

function compareDeliveries(left: ReplayDelivery, right: ReplayDelivery): number {
  return left.deliverDate.localeCompare(right.deliverDate)
    || left.to.localeCompare(right.to)
    || left.inboxRelPath.localeCompare(right.inboxRelPath)
    || left.id.localeCompare(right.id)
    || Number(Boolean(left.duplicateOf)) - Number(Boolean(right.duplicateOf));
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
