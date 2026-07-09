import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  addDays,
  dateOnly,
  fromPosix,
  inlineArray,
  isIsoDate,
  labelAgentPath,
  normalizeAgentPath,
  normalizeRepoPath,
  parseFrontmatter,
  posixJoin,
  quoteScalar,
  safeReaddir,
  scalarField,
  sanitizeId as baseSanitizeId,
  todayIso,
} from "./common.js";

const STATES = new Set(["open", "done", "declined", "expired"]);
const TERMINAL_STATES = new Set(["done", "declined", "expired"]);
const REQUIRED_FIELDS = ["id", "from", "to", "opened", "deadline", "state", "subject"] as const;
const DEFAULT_DEADLINE_DAYS = 7;
const SKIP_SCAN_DIRS = new Set([".git", ".ultracodex", "docs", "ingest", "node_modules", "templates"]);

export interface Ticket {
  id: string;
  from: string;
  to: string;
  opened: string;
  deadline: string;
  state: string;
  subject: string;
  body: string;
  replies: string;
  rawBody: string;
  path: string;
  relPath: string;
}

export interface TicketRef {
  id?: string;
  ticketId?: string;
  to?: string;
  agent?: string;
  path?: string;
  relPath?: string;
}

export interface CreateTicketRequest {
  id?: string;
  ticketId?: string;
  from: string;
  to: string;
  opened?: string;
  deadline?: string;
  subject: string;
  body?: string;
  spec?: string;
}

export interface TicketOptions {
  rootDir?: string;
  root?: string;
  opened?: string;
  deadline?: string;
  agent?: string;
  to?: string;
  state?: string;
  now?: string;
  at?: string;
}

export class TicketError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code = "TICKET_ERROR", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TicketError";
    this.code = code;
    this.details = details;
  }
}

export async function create(request: CreateTicketRequest, options: TicketOptions = {}): Promise<Ticket> {
  const root = rootDir(options);
  const opened = request.opened ?? options.opened ?? todayIso();
  const deadline = request.deadline ?? options.deadline ?? addDays(opened, DEFAULT_DEADLINE_DAYS);
  const ticket = {
    id: sanitizeId(request.id ?? request.ticketId ?? generatedTicketId(request.subject, opened)),
    from: normalizeTicketAgentPath(required(request.from, "from")),
    to: normalizeTicketAgentPath(required(request.to, "to")),
    opened,
    deadline,
    state: "open",
    subject: String(required(request.subject, "subject")),
  };
  const body = String(request.body ?? request.spec ?? "");
  validateTicket(ticket);

  const relPath = ticketRelPath(ticket.to, ticket.id);
  const filePath = path.join(root, fromPosix(relPath));
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, serializeTicket(ticket, body), { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new TicketError(`ticket ${ticket.id} already exists for ${labelAgentPath(ticket.to)}`, "TICKET_EXISTS", {
        id: ticket.id,
        to: ticket.to,
        relPath,
      });
    }
    throw err;
  }
  return { ...ticket, body, replies: "", rawBody: body.replace(/\s*$/u, "\n"), path: filePath, relPath };
}

export async function read(ref: string | TicketRef, options: TicketOptions = {}): Promise<Ticket> {
  const root = rootDir(options);
  const resolved = await resolveTicketPath(root, ref, options);
  const text = await readFile(resolved.path, "utf8");
  const parsed = parseTicketText(text, resolved.relPath);
  return { ...parsed, path: resolved.path, relPath: resolved.relPath };
}

export async function list(options: TicketOptions | string = {}, filters: TicketOptions = {}): Promise<Ticket[]> {
  const opts: TicketOptions = typeof options === "string" ? { ...filters, rootDir: options } : options;
  const root = rootDir(opts);
  const agent = opts.agent ?? opts.to;
  const files = agent === undefined || agent === null
    ? await findTicketFiles(root)
    : await ticketsForAgent(root, normalizeTicketAgentPath(agent));
  const tickets: Ticket[] = [];
  for (const file of files) {
    try {
      const ticket = await read({ relPath: file.relPath }, { rootDir: root });
      if (opts.state && ticket.state !== opts.state) continue;
      tickets.push(ticket);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return tickets.sort((left, right) =>
    left.to.localeCompare(right.to) || left.opened.localeCompare(right.opened) || left.id.localeCompare(right.id),
  );
}

export async function listTickets(rootDir = process.cwd(), filters: TicketOptions = {}): Promise<Ticket[]> {
  return list({ ...filters, rootDir });
}

export async function transition(ref: string | TicketRef, state: string, options: TicketOptions = {}): Promise<Ticket> {
  if (!STATES.has(state)) throw new TicketError(`invalid ticket state ${JSON.stringify(state)}`, "TICKET_INVALID_STATE", { state });
  const root = rootDir(options);
  const current = await read(ref, { rootDir: root, ...options });
  if (TERMINAL_STATES.has(current.state) && current.state !== state) {
    throw new TicketError(`ticket ${current.id} is already ${current.state}`, "TICKET_CLOSED", {
      id: current.id,
      state: current.state,
    });
  }
  await writeFile(current.path, serializeTicket({ ...current, state }, current.rawBody), "utf8");
  return read({ relPath: current.relPath }, { rootDir: root });
}

export async function reply(
  ref: string | TicketRef,
  input: { from: string; body: string; at?: string },
  options: TicketOptions = {},
): Promise<Ticket> {
  const root = rootDir(options);
  const current = await read(ref, { rootDir: root, ...options });
  const from = normalizeTicketAgentPath(required(input.from, "from"));
  if (current.state !== "open") {
    throw new TicketError(`ticket ${current.id} is ${current.state}; replies require open`, "TICKET_NOT_OPEN", {
      id: current.id,
      state: current.state,
    });
  }
  if (from !== current.to) {
    throw new TicketError(`ticket ${current.id} may only be answered by ${labelAgentPath(current.to)}`, "TICKET_REPLY_FORBIDDEN", {
      id: current.id,
      from,
      to: current.to,
    });
  }
  const entry = formatReplyEntry({
    from,
    at: input.at ?? options.at ?? todayIso(),
    body: String(required(input.body, "body")),
  });
  const body = appendReplyBlock(current.rawBody, entry);
  await writeFile(current.path, serializeTicket({ ...current, state: "done" }, body), "utf8");
  return read({ relPath: current.relPath }, { rootDir: root });
}

export async function expire(
  nowOrOptions: string | TicketOptions = todayIso(),
  maybeOptions: TicketOptions = {},
): Promise<{ expired: Ticket[]; notifications: ExpiryNotification[]; artifacts: ExpiryNotification[] }> {
  let now: string;
  let options: TicketOptions;
  if (typeof nowOrOptions === "object" && nowOrOptions !== null) {
    options = nowOrOptions;
    now = options.now ?? todayIso();
  } else {
    now = String(nowOrOptions);
    options = maybeOptions;
  }
  const today = dateOnly(now);
  if (!isIsoDate(today)) throw new TicketError("now is not a valid YYYY-MM-DD date", "TICKET_INVALID_DATE");
  const openTickets = await list({ ...options, state: "open" });
  const expired: Ticket[] = [];
  const notifications: ExpiryNotification[] = [];
  for (const ticket of openTickets) {
    if (ticket.deadline >= today) continue;
    const updated = await transition({ relPath: ticket.relPath }, "expired", options);
    expired.push(updated);
    notifications.push(expiryNotification(updated, today));
  }
  return { expired, notifications, artifacts: notifications };
}

interface ParsedTicket extends Omit<Ticket, "path" | "relPath"> {}

export function parseTicketText(text: string, relPath = "(ticket)"): ParsedTicket {
  let parsed;
  try {
    parsed = parseFrontmatter(text, relPath);
  } catch (err) {
    throw new TicketError((err as Error).message, "TICKET_INVALID_FRONTMATTER", { relPath });
  }
  const ticket = {
    id: scalar(parsed.fields, "id", relPath),
    from: normalizeTicketAgentPath(scalar(parsed.fields, "from", relPath)),
    to: normalizeTicketAgentPath(scalar(parsed.fields, "to", relPath)),
    opened: scalar(parsed.fields, "opened", relPath),
    deadline: scalar(parsed.fields, "deadline", relPath),
    state: scalar(parsed.fields, "state", relPath),
    subject: scalar(parsed.fields, "subject", relPath),
  };
  validateTicket(ticket, relPath);
  const rawBody = parsed.body;
  const replyStart = rawBody.search(/^## Reply\b/mu);
  const body = replyStart === -1 ? rawBody : rawBody.slice(0, replyStart).replace(/\s+$/u, "\n");
  const replies = replyStart === -1 ? "" : rawBody.slice(replyStart);
  return { ...ticket, body, replies, rawBody };
}

export function normalizeTicketAgentPath(value: unknown): string {
  try {
    return normalizeAgentPath(value);
  } catch (err) {
    throw new TicketError((err as Error).message, "TICKET_INVALID_PATH");
  }
}

export function ticketRelPath(agentPath: string, id: string): string {
  const normalizedAgent = normalizeTicketAgentPath(agentPath);
  const safeId = sanitizeId(id);
  return posixJoin(normalizedAgent === "." ? "" : normalizedAgent, "tickets", `${safeId}.md`);
}

function serializeTicket(ticket: Pick<Ticket, "id" | "from" | "to" | "opened" | "deadline" | "state" | "subject">, body: string): string {
  const normalized = {
    id: ticket.id,
    from: normalizeTicketAgentPath(ticket.from),
    to: normalizeTicketAgentPath(ticket.to),
    opened: ticket.opened,
    deadline: ticket.deadline,
    state: ticket.state,
    subject: ticket.subject,
  };
  validateTicket(normalized);
  return [
    "---",
    `id: ${quoteScalar(normalized.id)}`,
    `from: ${quoteScalar(labelAgentPath(normalized.from))}`,
    `to: ${quoteScalar(labelAgentPath(normalized.to))}`,
    `opened: ${normalized.opened}`,
    `deadline: ${normalized.deadline}`,
    `state: ${normalized.state}`,
    `subject: ${quoteScalar(normalized.subject)}`,
    "---",
    "",
    String(body ?? "").replace(/\s*$/u, "\n"),
  ].join("\n");
}

function validateTicket(
  ticket: Pick<Ticket, "id" | "from" | "to" | "opened" | "deadline" | "state" | "subject">,
  relPath = "(ticket)",
): void {
  for (const field of REQUIRED_FIELDS) {
    const value = ticket[field];
    if (value === undefined || value === null || String(value) === "") {
      throw new TicketError(`${relPath} frontmatter missing ${field}`, "TICKET_INVALID_FRONTMATTER", { field, relPath });
    }
  }
  sanitizeId(ticket.id);
  assertTicketDate(ticket.opened, "opened", relPath);
  assertTicketDate(ticket.deadline, "deadline", relPath);
  if (!STATES.has(ticket.state)) {
    throw new TicketError(`${relPath} frontmatter state ${JSON.stringify(ticket.state)} is invalid`, "TICKET_INVALID_FRONTMATTER", {
      field: "state",
      relPath,
      state: ticket.state,
    });
  }
}

async function resolveTicketPath(root: string, ref: string | TicketRef, options: TicketOptions): Promise<{ path: string; relPath: string }> {
  if (typeof ref === "string") {
    if (options.to || options.agent) {
      const relPath = ticketRelPath(options.to ?? options.agent ?? ".", ref);
      return { path: path.join(root, fromPosix(relPath)), relPath };
    }
    if (ref.endsWith(".md") || ref.includes("/")) return resolveTicketPath(root, { relPath: ref }, options);
    return findUniqueTicket(root, ref);
  }
  if (!ref || typeof ref !== "object") throw new TicketError("ticket reference must be a ticket id, path, or {to,id}", "TICKET_BAD_REF");
  if (ref.path) {
    const absolute = path.isAbsolute(ref.path) ? path.resolve(ref.path) : path.resolve(root, ref.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new TicketError(`ticket path is outside root: ${ref.path}`, "TICKET_INVALID_PATH");
    }
    return { path: absolute, relPath: relative.split(path.sep).join("/") };
  }
  if (ref.relPath) {
    const normalized = normalizeTicketRepoPath(ref.relPath);
    return { path: path.join(root, fromPosix(normalized)), relPath: normalized };
  }
  const id = ref.id ?? ref.ticketId;
  const agent = ref.to ?? ref.agent;
  if (id && agent) {
    const relPath = ticketRelPath(agent, id);
    return { path: path.join(root, fromPosix(relPath)), relPath };
  }
  if (id) return findUniqueTicket(root, id);
  throw new TicketError("ticket reference must include id and to, relPath, or path", "TICKET_BAD_REF");
}

async function findUniqueTicket(root: string, id: string): Promise<{ path: string; relPath: string }> {
  const safeId = sanitizeId(id);
  const matches = (await findTicketFiles(root)).filter((file) => path.basename(file.relPath) === `${safeId}.md`);
  if (matches.length === 0) throw new TicketError(`ticket ${safeId} not found`, "TICKET_NOT_FOUND", { id: safeId });
  if (matches.length > 1) throw new TicketError(`ticket ${safeId} is ambiguous; pass the target agent`, "TICKET_AMBIGUOUS", { id: safeId });
  return matches[0]!;
}

async function ticketsForAgent(root: string, agent: string): Promise<{ path: string; relPath: string }[]> {
  const dirRel = posixJoin(agent === "." ? "" : agent, "tickets");
  const dir = path.join(root, fromPosix(dirRel));
  return (await safeReaddir(dir))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."))
    .map((entry) => ({ path: path.join(dir, entry.name), relPath: posixJoin(dirRel, entry.name) }));
}

async function findTicketFiles(root: string, dir = root, rel = ""): Promise<{ path: string; relPath: string }[]> {
  const out: { path: string; relPath: string }[] = [];
  for (const entry of await safeReaddir(dir)) {
    if (entry.name.startsWith(".") || SKIP_SCAN_DIRS.has(entry.name)) continue;
    const entryPath = path.join(dir, entry.name);
    const entryRel = posixJoin(rel, entry.name);
    if (entry.isDirectory() && entry.name === "tickets") {
      out.push(
        ...(await safeReaddir(entryPath))
          .filter((ticket) => ticket.isFile() && ticket.name.endsWith(".md") && !ticket.name.startsWith("."))
          .map((ticket) => ({ path: path.join(entryPath, ticket.name), relPath: posixJoin(entryRel, ticket.name) })),
      );
      continue;
    }
    if (entry.isDirectory()) out.push(...(await findTicketFiles(root, entryPath, entryRel)));
  }
  return out;
}

function scalar(fields: Record<string, unknown>, field: string, relPath: string): string {
  try {
    return scalarField(fields as Record<string, string | string[]>, field, relPath);
  } catch (err) {
    throw new TicketError((err as Error).message, "TICKET_INVALID_FRONTMATTER", { field, relPath });
  }
}

function appendReplyBlock(rawBody: string, entry: string): string {
  const trimmed = String(rawBody ?? "").replace(/\s*$/u, "\n");
  if (/^## Reply\b/mu.test(trimmed)) return `${trimmed.replace(/\s*$/u, "\n\n")}${entry}\n`;
  return `${trimmed}\n## Reply\n\n${entry}\n`;
}

function formatReplyEntry({ from, at, body }: { from: string; at: string; body: string }): string {
  return `- ${dateOnly(at)} \u00b7 from ${labelAgentPath(from)}\n\n${String(body).replace(/\s*$/u, "")}`;
}

interface ExpiryNotification {
  from: "ops";
  type: "NOTIFY";
  to: string;
  id: string;
  subject: string;
  body: string;
  refs: string[];
}

function expiryNotification(ticket: Ticket, now: string): ExpiryNotification {
  return {
    from: "ops",
    type: "NOTIFY",
    to: ticket.from,
    id: `expired-${ticket.id}`,
    subject: `Ticket ${ticket.id} expired: ${ticket.subject}`,
    body: `Ticket ${ticket.id} to ${labelAgentPath(ticket.to)} expired on ${ticket.deadline} without an open reply as of ${now}.`,
    refs: [ticket.relPath],
  };
}

function sanitizeId(value: unknown): string {
  try {
    return baseSanitizeId(value, "ticket id");
  } catch (err) {
    throw new TicketError((err as Error).message, "TICKET_INVALID_ID", { id: value });
  }
}

function generatedTicketId(subject: string, opened: string): string {
  const slug = String(subject ?? "request")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40) || "request";
  return `ticket-${opened}-${slug}`;
}

function rootDir(options: TicketOptions = {}): string {
  return path.resolve(options.rootDir ?? options.root ?? process.cwd());
}

function required(value: unknown, field: string): string {
  if (value === undefined || value === null || String(value) === "") {
    throw new TicketError(`missing required ${field}`, "TICKET_MISSING_FIELD", { field });
  }
  return String(value);
}

function assertTicketDate(value: string, field: string, relPath: string): void {
  if (!isIsoDate(value)) {
    throw new TicketError(`${relPath} frontmatter ${field} is not a valid YYYY-MM-DD date`, "TICKET_INVALID_DATE", {
      field,
      value,
      relPath,
    });
  }
}

function normalizeTicketRepoPath(value: unknown): string {
  const normalized = normalizeRepoPath(value);
  if (normalized === null) throw new TicketError(`path escapes repo root: ${JSON.stringify(value)}`, "TICKET_INVALID_PATH");
  return normalized;
}

export const internals = { inlineArray };
