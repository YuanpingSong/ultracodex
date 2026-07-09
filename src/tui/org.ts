import { truncate } from "./format.js";
import { valueSparkline } from "./loops.js";

export type OrgRole = "root" | "group" | "entity";
export type OrgSeverity = "routine" | "notable" | "material" | "urgent";
export const ORG_SUBVIEWS = ["tree", "ops", "briefs"] as const;
export type OrgSubview = typeof ORG_SUBVIEWS[number];

export interface OrgFileRead {
  relPath: string;
  text: string | null;
  mtimeMs?: number;
}

export interface OrgInboxItemRead {
  name: string;
  text: string | null;
  mtimeMs?: number;
}

export interface OrgAgentRead {
  path: string;
  role: OrgRole;
  parent?: string | null;
  brief?: OrgFileRead | null;
  log?: OrgFileRead | null;
  memoryFiles?: OrgFileRead[];
  inboxItems?: OrgInboxItemRead[];
  ticketFiles?: OrgFileRead[];
}

export interface OrgBriefReadState {
  version: number;
  visits: Record<string, string>;
}

export interface OrgSnapshotReads {
  orgName?: string;
  now?: string | number | Date;
  agents: OrgAgentRead[];
  lastWake?: Record<string, unknown>;
  auditHistory?: unknown[];
  ledgerTail?: unknown[];
  briefRead?: OrgBriefReadState;
  warnings?: string[];
}

export interface OrgBriefSnapshot {
  relPath: string;
  updated: string | null;
  confidence: string | null;
  positionExcerpt: string;
  body: string;
  bodyLines: string[];
  mtimeMs: number;
  frontmatter: Record<string, string | string[]>;
}

export interface OrgWakeSnapshot {
  ts: string | null;
  cycle: number | null;
  severity: OrgSeverity;
  durationMs: number | null;
  tokens: number | null;
}

export interface OrgTicketSnapshot {
  id: string;
  from: string;
  to: string;
  opened: string | null;
  deadline: string | null;
  state: string;
  subject: string;
  relPath: string;
}

export interface OrgReviewRow {
  file: string;
  nextReview: string;
}

export interface OrgAgentSnapshot {
  path: string;
  name: string;
  role: OrgRole;
  parent: string | null;
  depth: number;
  severity: OrgSeverity;
  brief: OrgBriefSnapshot;
  logTail: string[];
  inboxCount: number;
  oldestInbox: string | null;
  inboxItems: Array<{ name: string; date: string | null; mtimeMs: number }>;
  openTickets: OrgTicketSnapshot[];
  nearestDeadline: string | null;
  nextReview: string | null;
  overdueReviews: OrgReviewRow[];
  lastWake: OrgWakeSnapshot;
  unread: boolean;
}

export interface OrgAuditSummary {
  date: string | null;
  accuracy: number | null;
  delta: number | null;
  tally: unknown;
  sampled: number | null;
}

export interface OrgMovedRow {
  time: string;
  seat: string;
  severity: OrgSeverity;
  text: string;
}

export interface OrgAttentionRow {
  kind: "overdue" | "ticket" | "review" | "inbox";
  seat: string;
  sort: string;
  text: string;
}

export interface OrgStateFreshness {
  glyph: "●" | "○";
  label: string;
}

export interface OrgTotals {
  seats: number;
  inbox: number;
  openTickets: number;
  overdueReviews: number;
  severity: OrgSeverity;
}

export interface OrgTickInfo {
  today: string;
  latestWake: string | null;
  maxCycle: number;
  lastTick: string;
  freshness: OrgStateFreshness;
  totals: OrgTotals;
  audit: OrgAuditSummary;
  auditSparkline: string;
  routingViolationCount: number;
  whatMoved: OrgMovedRow[];
  attentionRows: OrgAttentionRow[];
}

export interface OrgUnreadBrief {
  path: string;
  label: string;
  updated: string;
  mtimeMs: number;
}

export interface OrgTreeDisplayRow {
  path: string;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  last: boolean;
}

export interface OrgSnapshot {
  orgName: string;
  now: string;
  today: string;
  tickInfo: OrgTickInfo;
  agents: OrgAgentSnapshot[];
  childrenByParent: Record<string, string[]>;
  unreadBriefs: OrgUnreadBrief[];
  auditHistory: unknown[];
  ledgerTail: unknown[];
  warnings: string[];
}

const SEVERITY_RANK: Record<OrgSeverity, number> = {
  routine: 0,
  notable: 1,
  material: 2,
  urgent: 3,
};
const NOTABLE_RANK = SEVERITY_RANK.notable;

export function buildOrgSnapshot(reads: OrgSnapshotReads): OrgSnapshot {
  const now = normalizeNow(reads.now);
  const today = now.slice(0, 10);
  const warnings = [...(reads.warnings ?? [])];
  const lastWake = normalizeLastWake(reads.lastWake ?? {}, warnings);
  const visits = normalizeBriefVisits(reads.briefRead?.visits ?? {});

  const agents = [...reads.agents]
    .map((agentRead): OrgAgentSnapshot => buildAgentSnapshot(agentRead, { today, lastWake, visits, warnings }))
    .sort(compareAgents);
  const childrenByParent = buildChildrenByParent(agents);
  const maxCycle = Math.max(0, ...agents.map((agent) => agent.lastWake.cycle ?? 0));
  const latestWake = agents
    .map((agent) => agent.lastWake.ts)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1) ?? null;
  const auditHistory = reads.auditHistory ?? [];
  const ledgerTail = reads.ledgerTail ?? [];
  const audit = auditSummary(auditHistory);
  const totals: OrgTotals = {
    seats: agents.length,
    inbox: agents.reduce((sum, agent) => sum + agent.inboxCount, 0),
    openTickets: agents.reduce((sum, agent) => sum + agent.openTickets.length, 0),
    overdueReviews: agents.reduce((sum, agent) => sum + agent.overdueReviews.length, 0),
    severity: maxSeverity(agents.map((agent) => agent.severity)),
  };
  const unreadBriefs = agents
    .filter((agent) => agent.unread)
    .sort((a, b) => b.brief.mtimeMs - a.brief.mtimeMs || a.path.localeCompare(b.path))
    .map((agent) => ({
      path: agent.path,
      label: displayOrgPath(agent.path),
      updated: formatFileDate(agent.brief.updated, agent.brief.mtimeMs),
      mtimeMs: agent.brief.mtimeMs,
    }));
  const whatMoved = extractWhatMoved(agents, maxCycle);
  const attention = attentionRows({ agents, today });
  const tickInfo: OrgTickInfo = {
    today,
    latestWake,
    maxCycle,
    lastTick: formatTick({ today, latestWake, maxCycle }),
    freshness: stateFreshness({ now, latestWake }),
    totals,
    audit,
    auditSparkline: auditSparkline(auditHistory),
    routingViolationCount: routingViolationCount(ledgerTail),
    whatMoved,
    attentionRows: attention,
  };

  return {
    orgName: reads.orgName?.trim() || "org",
    now,
    today,
    tickInfo,
    agents,
    childrenByParent,
    unreadBriefs,
    auditHistory,
    ledgerTail,
    warnings,
  };
}

function buildAgentSnapshot(
  read: OrgAgentRead,
  context: {
    today: string;
    lastWake: Record<string, Partial<OrgWakeSnapshot>>;
    visits: Record<string, string>;
    warnings: string[];
  },
): OrgAgentSnapshot {
  const agentPath = normalizeOrgAgentPath(read.path);
  const role = normalizeRole(read.role, agentPath);
  const parent = read.parent === null ? null : read.parent === undefined ? parentFor(agentPath) : normalizeOrgAgentPath(read.parent);
  const briefRead = read.brief ?? null;
  const briefText = briefRead?.text ?? "";
  const parsedBrief = parseMemoryFile(briefText, briefRead?.relPath ?? agentRel(agentPath, "BRIEF.md"));
  const brief: OrgBriefSnapshot = {
    relPath: briefRead?.relPath ?? agentRel(agentPath, "BRIEF.md"),
    updated: scalar(parsedBrief.frontmatter, "updated"),
    confidence: scalar(parsedBrief.frontmatter, "confidence"),
    positionExcerpt: positionExcerpt(parsedBrief.bodyLines),
    body: parsedBrief.body,
    bodyLines: displayBodyLines(parsedBrief.body),
    mtimeMs: briefRead?.mtimeMs ?? 0,
    frontmatter: parsedBrief.frontmatter,
  };
  const logText = read.log?.text ?? "";
  const parsedLog = parseMemoryFile(logText, read.log?.relPath ?? agentRel(agentPath, "LOG.md"));
  const logLines = displayBodyLines(parsedLog.body).filter((line) => line.trim() !== "");
  const logTail = logLines.slice(-5);
  const inbox = inboxInfo(read.inboxItems ?? []);
  const tickets = (read.ticketFiles ?? []).map(parseTicketFile).filter((ticket) => ticket.state === "open");
  tickets.sort(compareTickets);
  const reviews = reviewInfo(agentPath, read.memoryFiles ?? [briefRead].filter((file): file is OrgFileRead => file !== null), context.warnings);
  const wake = normalizeWakeRecord(context.lastWake[agentPath]);
  const severity = maxSeverity([
    wake.severity,
    ...severityLines(briefText),
    ...severityLines(logText),
  ]);
  return {
    path: agentPath,
    name: agentPath === "." ? ". root" : agentPath.split("/").at(-1) ?? agentPath,
    role,
    parent,
    depth: agentDepth(agentPath),
    severity,
    brief,
    logTail,
    inboxCount: inbox.count,
    oldestInbox: inbox.oldestDate,
    inboxItems: inbox.items,
    openTickets: tickets,
    nearestDeadline: nearestDeadline(tickets),
    nextReview: reviews.nextReview,
    overdueReviews: reviews.rows.filter((row) => row.nextReview <= context.today),
    lastWake: wake,
    unread: briefIsUnread(brief.mtimeMs, context.visits[agentPath]),
  };
}

function parseMemoryFile(text: string, relPath: string): { frontmatter: Record<string, string | string[]>; body: string; bodyLines: string[] } {
  const source = String(text ?? "");
  const lines = source.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: source, bodyLines: source.split(/\r?\n/u) };
  const close = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (close === -1) return { frontmatter: {}, body: source, bodyLines: source.split(/\r?\n/u) };
  const frontmatter: Record<string, string | string[]> = {};
  for (let index = 1; index < close; index += 1) {
    const match = lines[index]?.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!match) continue;
    frontmatter[match[1]!] = parseScalar(match[2] ?? "");
  }
  const body = lines.slice(close + 1).join("\n").replace(/^\n/u, "");
  return { frontmatter, body, bodyLines: body.split(/\r?\n/u) };
}

function parseScalar(raw: string): string | string[] {
  const value = String(raw ?? "").trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((part) => String(parseScalar(part)).trim())
      .filter(Boolean);
  }
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function scalar(fields: Record<string, string | string[]>, key: string): string | null {
  const value = fields[key];
  if (Array.isArray(value) || value === undefined || value === "") return null;
  return value;
}

function displayBodyLines(body: string): string[] {
  const lines = String(body ?? "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\t/gu, "  ").trimEnd());
  return lines.filter((line, index) => line.trim() || (index > 0 && index < lines.length - 1));
}

function positionExcerpt(lines: readonly string[]): string {
  const heading = lines.findIndex((line) => /^#{1,6}\s+.*\bposition/i.test(line));
  if (heading >= 0) {
    const found = lines.slice(heading + 1).find((line) => line.trim() && !/^#{1,6}\s+/u.test(line));
    if (found) return excerpt(found);
  }
  const explicit = lines.find((line) => /\bposition\b/i.test(line) && !/^#{1,6}\s+/u.test(line));
  if (explicit) return excerpt(explicit);
  const first = lines.find((line) => line.trim() && !/^#{1,6}\s+/u.test(line));
  return first ? excerpt(first) : "";
}

function inboxInfo(items: readonly OrgInboxItemRead[]): {
  count: number;
  oldestDate: string | null;
  items: Array<{ name: string; date: string | null; mtimeMs: number }>;
} {
  const rows = items
    .filter((item) => item.name && !item.name.startsWith(".") && item.name !== ".gitkeep")
    .map((item) => {
      const parsed = parseMemoryFile(item.text ?? "", item.name);
      const date = firstDate(
        scalar(parsed.frontmatter, "received"),
        scalar(parsed.frontmatter, "document_date"),
        scalar(parsed.frontmatter, "documentDate"),
        scalar(parsed.frontmatter, "source_date"),
        scalar(parsed.frontmatter, "sourceDate"),
        scalar(parsed.frontmatter, "date"),
        scalar(parsed.frontmatter, "eventDate"),
        item.text,
        item.mtimeMs ? new Date(item.mtimeMs).toISOString().slice(0, 10) : null,
      );
      return { name: item.name, date, mtimeMs: item.mtimeMs ?? 0 };
    })
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")) || a.name.localeCompare(b.name));
  return { count: rows.length, oldestDate: rows[0]?.date ?? null, items: rows };
}

function parseTicketFile(file: OrgFileRead): OrgTicketSnapshot {
  const parsed = parseMemoryFile(file.text ?? "", file.relPath);
  const relAgent = file.relPath.replace(/(?:^|\/)tickets\/[^/]+\.md$/u, "").replace(/\/$/u, "");
  return {
    id: scalar(parsed.frontmatter, "id") ?? file.relPath.split("/").at(-1)?.replace(/\.md$/u, "") ?? "ticket",
    from: normalizeOrgAgentPath(scalar(parsed.frontmatter, "from") ?? "."),
    to: normalizeOrgAgentPath(scalar(parsed.frontmatter, "to") ?? (relAgent || ".")),
    opened: firstDate(scalar(parsed.frontmatter, "opened")),
    deadline: firstDate(scalar(parsed.frontmatter, "deadline")),
    state: String(scalar(parsed.frontmatter, "state") ?? "open"),
    subject: scalar(parsed.frontmatter, "subject") ?? "",
    relPath: file.relPath,
  };
}

function reviewInfo(
  agentPath: string,
  files: readonly OrgFileRead[],
  warnings: string[],
): { nextReview: string | null; rows: OrgReviewRow[] } {
  const rows: OrgReviewRow[] = [];
  for (const file of files) {
    if (!file || file.relPath.endsWith("/AGENTS.md") || file.relPath === "AGENTS.md") continue;
    if (!file.relPath.endsWith(".md")) continue;
    const parsed = parseMemoryFile(file.text ?? "", file.relPath);
    const nextReview = firstDate(scalar(parsed.frontmatter, "next_review"), scalar(parsed.frontmatter, "nextReview"));
    if (!nextReview) continue;
    rows.push({ file: file.relPath || agentRel(agentPath, "BRIEF.md"), nextReview });
  }
  rows.sort((a, b) => a.nextReview.localeCompare(b.nextReview) || a.file.localeCompare(b.file));
  if (files.length === 0) warnings.push(`${displayOrgPath(agentPath)} has no memory files`);
  return { nextReview: rows[0]?.nextReview ?? null, rows };
}

function normalizeLastWake(input: Record<string, unknown>, warnings: string[]): Record<string, Partial<OrgWakeSnapshot>> {
  const raw = isRecord(input.agents) ? input.agents : input;
  const out: Record<string, Partial<OrgWakeSnapshot>> = {};
  for (const [agentPath, value] of Object.entries(raw ?? {})) {
    if (!isRecord(value)) {
      warnings.push(`ignored malformed wake state for ${agentPath}`);
      continue;
    }
    const normalized = normalizeOrgAgentPath(agentPath);
    out[normalized] = {
      ts: stringOrNull(value.lastWake ?? value.ts),
      cycle: integerOrNull(value.cycle),
      severity: normalizeSeverity(value.lastSeverity ?? value.severity),
      durationMs: numberOrNull(value.durationMs ?? value.duration ?? value.ms),
      tokens: numberOrNull(value.tokens ?? value.tokenCount ?? value.totalTokens),
    };
  }
  return out;
}

function normalizeWakeRecord(record: Partial<OrgWakeSnapshot> | undefined): OrgWakeSnapshot {
  return {
    ts: record?.ts ?? null,
    cycle: record?.cycle ?? null,
    severity: normalizeSeverity(record?.severity),
    durationMs: record?.durationMs ?? null,
    tokens: record?.tokens ?? null,
  };
}

function normalizeBriefVisits(visits: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [agentPath, value] of Object.entries(visits ?? {})) {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) out[normalizeOrgAgentPath(agentPath)] = new Date(parsed).toISOString();
  }
  return out;
}

export function auditSummary(rows: readonly unknown[]): OrgAuditSummary {
  const valid = rows
    .filter(isRecord)
    .filter((row) => Object.prototype.hasOwnProperty.call(row, "accuracy"))
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
  const last = valid.at(-1) ?? null;
  const previous = valid.at(-2) ?? null;
  const accuracy = normalizeAccuracy(last?.accuracy);
  const previousAccuracy = normalizeAccuracy(previous?.accuracy);
  return {
    date: typeof last?.date === "string" ? last.date : null,
    accuracy,
    delta: accuracy !== null && previousAccuracy !== null ? round1(accuracy - previousAccuracy) : null,
    tally: last?.tally ?? null,
    sampled: integerOrNull(last?.sampled),
  };
}

export function auditSparkline(rows: readonly unknown[]): string {
  const values = rows
    .filter(isRecord)
    .map((row) => normalizeAccuracy(row.accuracy))
    .filter((value): value is number => value !== null)
    .slice(-12);
  return values.length ? valueSparkline(values) : "n/a";
}

export function routingViolationCount(rows: readonly unknown[]): number {
  return rows.filter((row) => isRecord(row) && (row.type === "routing-violation" || row.type === "escalation")).length;
}

export function stateFreshness(input: { now: string; latestWake: string | null }): OrgStateFreshness {
  if (!input.latestWake) return { glyph: "○", label: "no wake state" };
  const ageMs = Date.parse(input.now) - Date.parse(input.latestWake);
  if (!Number.isFinite(ageMs)) return { glyph: "○", label: "wake state" };
  if (ageMs <= 3 * 60 * 60 * 1000) return { glyph: "●", label: "fresh" };
  if (ageMs <= 24 * 60 * 60 * 1000) return { glyph: "●", label: "today" };
  return { glyph: "○", label: `${Math.ceil(ageMs / (24 * 60 * 60 * 1000))}d stale` };
}

export function extractWhatMoved(agents: readonly OrgAgentSnapshot[], maxCycle: number): OrgMovedRow[] {
  if (maxCycle <= 0) return [];
  return agents
    .filter((agent) => agent.lastWake.cycle === maxCycle && agent.lastWake.ts !== null)
    .map((agent) => {
      const logLine = logLineForCycle(agent.logTail, maxCycle) ?? agent.logTail.at(-1) ?? "";
      return {
        time: agent.lastWake.ts ?? "",
        seat: agent.path,
        severity: maxSeverity([agent.lastWake.severity, lineSeverity(logLine)]),
        text: excerpt(logLine) || "woke",
      };
    })
    .sort((a, b) => b.time.localeCompare(a.time) || a.seat.localeCompare(b.seat));
}

function logLineForCycle(lines: readonly string[], cycle: number): string | null {
  const pattern = new RegExp(`\\bcycle\\s+${escapeRegex(String(cycle))}\\b`, "iu");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (pattern.test(line)) return line;
  }
  return null;
}

export function attentionRows(input: { agents: readonly OrgAgentSnapshot[]; today: string }): OrgAttentionRow[] {
  const rows: OrgAttentionRow[] = [];
  for (const agent of input.agents) {
    for (const ticket of agent.openTickets) {
      rows.push({
        kind: ticket.deadline && ticket.deadline < input.today ? "overdue" : "ticket",
        seat: agent.path,
        sort: `0-${ticket.deadline ?? "9999-99-99"}-${agent.path}`,
        text: `${ticket.deadline ?? "no due"} - ${ticket.subject || ticket.id}`,
      });
    }
    for (const review of agent.overdueReviews) {
      rows.push({
        kind: "review",
        seat: agent.path,
        sort: `1-${review.nextReview}-${agent.path}`,
        text: `${review.nextReview} - ${review.file}`,
      });
    }
    if (agent.inboxCount > 0) {
      rows.push({
        kind: "inbox",
        seat: agent.path,
        sort: `2-${agent.oldestInbox ?? "9999-99-99"}-${agent.path}`,
        text: `${agent.inboxCount} waiting${agent.oldestInbox ? ` - oldest ${shortDate(agent.oldestInbox)}` : ""}`,
      });
    }
  }
  return rows.sort((a, b) => a.sort.localeCompare(b.sort));
}

export function nextOrgSubview(view: OrgSubview): OrgSubview {
  const index = ORG_SUBVIEWS.indexOf(view);
  return ORG_SUBVIEWS[(index + 1) % ORG_SUBVIEWS.length] ?? "tree";
}

export function defaultOrgExpanded(snapshot: OrgSnapshot): Set<string> {
  const out = new Set<string>();
  for (const agent of snapshot.agents) {
    if ((snapshot.childrenByParent[agent.path]?.length ?? 0) > 0) out.add(agent.path);
  }
  return out;
}

export function buildOrgTreeRows(
  snapshot: OrgSnapshot,
  expanded: ReadonlySet<string> | readonly string[] | null = null,
): OrgTreeDisplayRow[] {
  const open = normalizeOrgExpanded(snapshot, expanded);
  const rows: OrgTreeDisplayRow[] = [];
  const seen = new Set<string>();
  const visit = (agentPath: string, depth: number, last: boolean): void => {
    const agent = findAgent(snapshot, agentPath);
    if (!agent) return;
    const children = snapshot.childrenByParent[agentPath] ?? [];
    seen.add(agentPath);
    rows.push({ path: agentPath, depth, hasChildren: children.length > 0, expanded: open.has(agentPath), last });
    if (children.length === 0 || !open.has(agentPath)) return;
    children.forEach((child, index) => visit(child, depth + 1, index === children.length - 1));
  };

  visit(".", 0, true);
  for (const agent of snapshot.agents) {
    if (!seen.has(agent.path)) visit(agent.path, agent.depth, true);
  }
  return rows;
}

export function defaultOrgSelectedPath(
  snapshot: OrgSnapshot,
  selectedPath: string | null | undefined = null,
  rows: readonly OrgTreeDisplayRow[] | null = null,
): string {
  const candidates = rows?.map((row) => row.path) ?? snapshot.agents.map((agent) => agent.path);
  if (selectedPath !== null && selectedPath !== undefined) {
    try {
      const normalized = normalizeOrgAgentPath(selectedPath);
      if (candidates.includes(normalized) && findAgent(snapshot, normalized) !== null) return normalized;
    } catch {
      // Fall through to the snapshot-driven default.
    }
  }
  const material = candidates.find((agentPath) => severityRank(findAgent(snapshot, agentPath)?.severity) >= SEVERITY_RANK.material);
  if (material !== undefined) return material;
  const attention = candidates.find((agentPath) => {
    const agent = findAgent(snapshot, agentPath);
    return agent !== null && (agent.inboxCount > 0 || agent.openTickets.length > 0 || agent.overdueReviews.length > 0);
  });
  return attention ?? candidates[0] ?? ".";
}

export function formatOrgTreeHeaderLine(snapshot: OrgSnapshot, width?: number): string {
  return clipText(
    `Org · ${snapshot.orgName} · tick ${snapshot.tickInfo.lastTick} · audit ${formatAudit(snapshot.tickInfo.audit)}`,
    width,
  );
}

export function formatOrgTreeDisplayRow(
  snapshot: OrgSnapshot,
  row: OrgTreeDisplayRow,
  options: { selected?: boolean; width?: number } = {},
): string {
  const agent = findAgent(snapshot, row.path);
  if (!agent) return "";
  const pointer = options.selected ? "❯ " : "  ";
  const marker = row.hasChildren ? (row.expanded ? "●" : "○") : " ";
  const indent = row.depth === 0 ? "" : "  ".repeat(row.depth);
  const inbox = agent.inboxCount > 0 ? ` inbox ${agent.inboxCount}` : "";
  const wokeThisTick = agent.lastWake.cycle === snapshot.tickInfo.maxCycle && snapshot.tickInfo.maxCycle > 0;
  const woke = wokeThisTick ? "●" : "○";
  const when = agent.lastWake.ts ? formatWakeTime(agent.lastWake.ts, snapshot.today) : "--";
  const severity = severityRank(agent.severity) >= NOTABLE_RANK ? ` ${severityLabel(agent.severity)}` : "";
  return clipText(`${pointer}${indent}${marker} ${agent.name}${inbox} ${woke} ${when}${severity}`, options.width);
}

export function formatOrgOpsHeaderLine(snapshot: OrgSnapshot, width?: number): string {
  const info = snapshot.tickInfo;
  return clipText(
    `${info.freshness.glyph} ${info.freshness.label} · tick ${info.lastTick} · seats ${info.totals.seats} · inbox ${info.totals.inbox} · tickets ${info.totals.openTickets} · audit ${formatAudit(info.audit)} Δ${signedPct(info.audit.delta)}`,
    width,
  );
}

export function formatOrgOpsFooterLine(snapshot: OrgSnapshot, width?: number): string {
  return clipText(
    `audit trend ${snapshot.tickInfo.auditSparkline} · routing violations ${snapshot.tickInfo.routingViolationCount}`,
    width,
  );
}

export function formatOrgBriefQueueRow(
  row: OrgUnreadBrief | null,
  options: { selected?: boolean; width?: number } = {},
): string {
  const pointer = options.selected ? "❯ " : "  ";
  const text = row === null ? "none" : `${row.updated} ${row.label}`;
  return clipText(`${pointer}${text}`, options.width);
}

export function formatOrgBriefStatusLine(snapshot: OrgSnapshot, agentPath: string, width?: number): string {
  const agent = findAgent(snapshot, agentPath);
  return clipText(
    `${agent?.brief.relPath ?? "BRIEF.md"} · unread ${snapshot.unreadBriefs.length} · j/k unread · v view`,
    width,
  );
}

export function formatOrgBriefBodyLines(
  snapshot: OrgSnapshot,
  agentPath: string,
  options: { maxLines?: number; width?: number } = {},
): string[] {
  const agent = findAgent(snapshot, agentPath);
  const lines = agent?.brief.bodyLines.length ? agent.brief.bodyLines : ["(empty brief)"];
  return lines.slice(0, options.maxLines ?? 18).map((line) => clipText(line, options.width));
}

export function formatOrgTreeRow(
  snapshot: OrgSnapshot,
  agentPath: string,
  options: { selected?: boolean; width?: number } = {},
): string {
  const agent = findAgent(snapshot, agentPath);
  if (!agent) return "";
  const pointer = options.selected ? "❯ " : "  ";
  const indent = agent.depth === 0 ? "" : `${"  ".repeat(Math.max(0, agent.depth - 1))}${agent.depth > 1 ? "  " : ""}`;
  const inbox = agent.inboxCount > 0 ? ` inbox ${agent.inboxCount}` : "";
  const wokeThisTick = agent.lastWake.cycle === snapshot.tickInfo.maxCycle && snapshot.tickInfo.maxCycle > 0;
  const woke = wokeThisTick ? "●" : "○";
  const when = agent.lastWake.ts ? formatWakeTime(agent.lastWake.ts, snapshot.today) : "--";
  const severity = severityRank(agent.severity) >= NOTABLE_RANK ? ` ${severityLabel(agent.severity)}` : "";
  return clipText(`${pointer}${indent}${agent.name}${inbox} ${woke} ${when}${severity}`, options.width);
}

export function formatOrgDetailLines(
  snapshot: OrgSnapshot,
  agentPath: string,
  options: { width?: number; briefLines?: number } = {},
): string[] {
  const agent = findAgent(snapshot, agentPath);
  if (!agent) return [];
  const lastWake = agent.lastWake.ts
    ? `${formatWakeTime(agent.lastWake.ts, snapshot.today)} ${agent.lastWake.severity} c${agent.lastWake.cycle ?? "-"}${formatWakeStats(agent.lastWake)}`
    : "never";
  const inbox = agent.oldestInbox ? `${agent.inboxCount} oldest ${shortDate(agent.oldestInbox)}` : String(agent.inboxCount);
  const tickets = agent.openTickets.length
    ? `${agent.openTickets.length} open due ${shortDate(agent.nearestDeadline)}`
    : "0 open";
  const lines = [
    `${displayOrgPath(agent.path)} ${agent.role}`,
    `last wake ${lastWake}`,
    `inbox ${inbox}`,
    `tickets ${tickets}`,
    `next_review ${agent.nextReview ?? "none"}`,
    `BRIEF ${agent.brief.updated ?? "--"} ${agent.brief.confidence ?? "--"}`,
    ...agent.brief.bodyLines.slice(0, options.briefLines ?? 12),
  ];
  return lines.map((line) => clipText(line, options.width));
}

export function formatOrgMovedRow(row: OrgMovedRow, width?: number): string {
  return clipText(`${padRight(formatMoveTime(row.time), 5)} ${padRight(displayOrgPath(row.seat), 18)} ${padRight(severityLabel(row.severity), 8)} ${row.text}`, width);
}

export function formatOrgAttentionRow(row: OrgAttentionRow, width?: number): string {
  return clipText(`${padRight(row.kind, 7)} ${padRight(displayOrgPath(row.seat), 18)} ${row.text}`, width);
}

export function formatAudit(audit: OrgAuditSummary): string {
  return audit.accuracy === null ? "n/a" : `${trimNumber(audit.accuracy)}%`;
}

export function signedPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  const sign = value > 0 ? "+" : "";
  return `${sign}${trimNumber(value)}pp`;
}

export function formatWakeTime(value: string, today: string): string {
  const date = firstDate(value);
  const time = String(value ?? "").match(/T(\d{2}:\d{2})/u)?.[1] ?? null;
  if (date && date !== today) return shortDate(date);
  return time ?? shortDate(date) ?? "--";
}

export function formatMoveTime(value: string): string {
  return String(value ?? "").match(/T(\d{2}:\d{2})/u)?.[1] ?? String(value ?? "").match(/\d{2}:\d{2}/u)?.[0] ?? "--:--";
}

export function formatFileDate(updated: string | null, mtimeMs: number): string {
  if (updated && /^\d{4}-\d{2}-\d{2}$/u.test(updated)) return shortDate(updated);
  if (mtimeMs) return shortDate(new Date(mtimeMs).toISOString().slice(0, 10));
  return "--";
}

export function severityLabel(value: unknown): string {
  const severity = normalizeSeverity(value);
  return severity === "routine" ? "-" : severity;
}

export function normalizeSeverity(value: unknown): OrgSeverity {
  const severity = String(value ?? "routine").toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity) ? severity as OrgSeverity : "routine";
}

export function severityRank(value: unknown): number {
  return SEVERITY_RANK[normalizeSeverity(value)] ?? 0;
}

export function maxSeverity(values: readonly unknown[]): OrgSeverity {
  let max: OrgSeverity = "routine";
  for (const value of values) {
    const severity = normalizeSeverity(value);
    if (severityRank(severity) > severityRank(max)) max = severity;
  }
  return max;
}

export function lineSeverity(line: unknown): OrgSeverity | null {
  const match = String(line ?? "").match(/\bseverity\s*[:=]\s*(routine|notable|material|urgent)\b/iu);
  return match ? normalizeSeverity(match[1]) : null;
}

export function severityLines(text: string): OrgSeverity[] {
  return String(text ?? "").split(/\r?\n/u).map(lineSeverity).filter((value): value is OrgSeverity => value !== null);
}

export function normalizeOrgAgentPath(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\\/gu, "/");
  if (!raw || raw === "." || raw === "./" || raw === "root") return ".";
  const normalized = raw.replace(/^\.\//u, "").replace(/\/+$/u, "");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`agent path escapes repo root: ${JSON.stringify(value)}`);
    parts.push(part);
  }
  return parts.length ? parts.join("/") : ".";
}

export function displayOrgPath(agentPath: string): string {
  const normalized = normalizeOrgAgentPath(agentPath);
  return normalized === "." ? ". root" : normalized;
}

export function agentRel(agentPath: string, file: string): string {
  const normalized = normalizeOrgAgentPath(agentPath);
  return normalized === "." ? file : `${normalized}/${file}`.replace(/\/+/gu, "/");
}

export function agentDepth(agentPath: string): number {
  const normalized = normalizeOrgAgentPath(agentPath);
  return normalized === "." ? 0 : normalized.split("/").length;
}

function buildChildrenByParent(agents: readonly OrgAgentSnapshot[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const agent of agents) out[agent.path] = [];
  for (const agent of agents) {
    if (agent.parent === null) continue;
    if (!out[agent.parent]) out[agent.parent] = [];
    out[agent.parent]!.push(agent.path);
  }
  for (const children of Object.values(out)) children.sort(compareAgentPath);
  return out;
}

function compareAgents(left: OrgAgentSnapshot, right: OrgAgentSnapshot): number {
  return compareAgentPath(left.path, right.path);
}

function compareAgentPath(left: string, right: string): number {
  if (left === right) return 0;
  if (left === ".") return -1;
  if (right === ".") return 1;
  return left.localeCompare(right);
}

function compareTickets(left: OrgTicketSnapshot, right: OrgTicketSnapshot): number {
  return (left.deadline ?? "").localeCompare(right.deadline ?? "") || left.to.localeCompare(right.to) || left.id.localeCompare(right.id);
}

function parentFor(agentPath: string): string | null {
  const normalized = normalizeOrgAgentPath(agentPath);
  if (normalized === ".") return null;
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
}

function normalizeRole(role: string, agentPath: string): OrgRole {
  if (role === "root" || role === "group" || role === "entity") return role;
  if (agentPath === ".") return "root";
  return agentDepth(agentPath) === 1 ? "group" : "entity";
}

function nearestDeadline(tickets: readonly OrgTicketSnapshot[]): string | null {
  return tickets.map((ticket) => ticket.deadline).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
}

function briefIsUnread(mtimeMs: number, visitedAt: string | undefined): boolean {
  if (!mtimeMs) return false;
  if (!visitedAt) return true;
  const visited = Date.parse(visitedAt);
  return !Number.isFinite(visited) || mtimeMs > visited + 1;
}

function formatTick(input: { today: string; latestWake: string | null; maxCycle: number }): string {
  if (input.maxCycle > 0) {
    const date = input.latestWake ? firstDate(input.latestWake) : null;
    return `${date ?? input.today} c${input.maxCycle}`;
  }
  if (input.latestWake) return formatWakeTime(input.latestWake, input.today);
  return "--";
}

function formatWakeStats(wake: OrgWakeSnapshot): string {
  const parts: string[] = [];
  if (wake.durationMs !== null) parts.push(formatDuration(wake.durationMs));
  if (wake.tokens !== null) parts.push(formatTokens(wake.tokens));
  return parts.length ? ` (${parts.join(" ")})` : "";
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value >= 60_000) return `${Math.round(value / 60_000)}m`;
  if (value >= 1000) return `${Math.round(value / 1000)}s`;
  return `${Math.round(value)}ms`;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value >= 1000) return `${trimNumber(value / 1000)}k`;
  return String(value);
}

function normalizeNow(value: string | number | Date | undefined): string {
  const date = value === undefined ? new Date() : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function normalizeAccuracy(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return round1(n <= 1 ? n * 100 : n);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function trimNumber(value: number): string {
  if (!Number.isFinite(Number(value))) return "n/a";
  return Number(value).toFixed(1).replace(/\.0$/u, "");
}

function firstDate(...values: unknown[]): string | null {
  for (const value of values) {
    const match = String(value ?? "").match(/\b(\d{4}-\d{2}-\d{2})\b/u);
    if (match) return match[1]!;
  }
  return null;
}

function shortDate(value: unknown): string {
  const date = firstDate(value);
  return date ? date.slice(5) : "--";
}

function excerpt(text: unknown): string {
  return truncate(
    String(text ?? "")
      .replace(/^\s*[-*]\s*/u, "")
      .replace(/\s+/gu, " ")
      .trim(),
    120,
  );
}

function clipText(text: string, width: number | undefined): string {
  const value = String(text ?? "").replace(/\r?\n/gu, " ");
  if (width === undefined) return value;
  const safeWidth = Math.max(0, Math.trunc(width));
  if (safeWidth <= 0) return "";
  if (value.length <= safeWidth) return value;
  if (safeWidth === 1) return "…";
  return `${value.slice(0, safeWidth - 1)}…`;
}

function padRight(value: string, width: number): string {
  const clipped = clipText(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - clipped.length))}`;
}

function findAgent(snapshot: OrgSnapshot, agentPath: string): OrgAgentSnapshot | null {
  const normalized = normalizeOrgAgentPath(agentPath);
  return snapshot.agents.find((agent) => agent.path === normalized) ?? null;
}

function normalizeOrgExpanded(
  snapshot: OrgSnapshot,
  expanded: ReadonlySet<string> | readonly string[] | null,
): Set<string> {
  if (expanded === null) return defaultOrgExpanded(snapshot);
  const raw = expanded instanceof Set ? [...expanded] : [...expanded];
  const out = new Set<string>();
  for (const agentPath of raw) {
    try {
      const normalized = normalizeOrgAgentPath(agentPath);
      if (findAgent(snapshot, normalized) !== null) out.add(normalized);
    } catch {
      // Ignore bad UI state; the next render will rebuild a valid set.
    }
  }
  return out;
}

function integerOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
