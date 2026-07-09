import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  dateOnly,
  fromPosix,
  inlineArray,
  labelAgentPath,
  normalizeAgentPath,
  posixJoin,
  quoteScalar,
  safeReaddir,
  sanitizeId as baseSanitizeId,
  todayIso,
} from "./common.js";
import {
  create as createTicket,
  normalizeTicketAgentPath,
  read as readTicket,
  reply as replyToTicket,
  type Ticket,
  TicketError,
} from "./tickets.js";

const INFRASTRUCTURE_SENDERS = new Set(["ops", "audit", "user"]);
const DELIVERY_TYPES = new Set(["NOTIFY", "REQUEST", "REPLY"]);

export interface RoutedMessage {
  id?: string;
  ticketId?: string;
  ticket?: string | Ticket;
  ticketPath?: string;
  ticketRelPath?: string;
  from?: string;
  type?: string;
  to?: string;
  subject?: string;
  body?: string;
  refs?: string[];
  received?: string;
  opened?: string;
  deadline?: string;
  expires?: string;
  overwrite?: boolean;
  at?: string;
}

export interface RouterOptions {
  rootDir?: string;
  root?: string;
  now?: string;
  cycle?: number;
  ledger?: "all";
  feedback?: false;
}

export interface Authorization {
  from: string;
  type: string;
  to: string;
  allowed: true;
  bypass: boolean;
  ticketId?: string;
}

export class RoutingViolationError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(message: string, code = "ROUTING_VIOLATION", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RoutingViolationError";
    this.code = code;
    this.details = details;
  }
}

export function authorize(message: RoutedMessage): Authorization {
  const from = normalizeSender(required(message.from, "from"));
  const type = normalizeType(required(message.type, "type"));
  if (!DELIVERY_TYPES.has(type)) {
    throw new RoutingViolationError(`unsupported delivery type ${JSON.stringify(message.type)}`, "ROUTING_BAD_TYPE", {
      type: message.type,
    });
  }
  if (type === "REPLY") return authorizeReply({ ...message, from, type, ticket: message.ticket as Ticket | undefined });

  const to = normalizeAgentPath(required(message.to, "to"));
  if (isInfrastructureSender(from)) return { from, type, to, allowed: true, bypass: true };

  if (type === "NOTIFY") {
    if (isProperPrefix(to, from)) {
      throw new RoutingViolationError(
        `NOTIFY from ${label(from)} to ancestor ${label(to)} is not authorized`,
        "ROUTING_NOTIFY_UPTREE",
        { from, type, to },
      );
    }
    return { from, type, to, allowed: true, bypass: false };
  }

  if (type === "REQUEST") {
    if (!isProperPrefix(from, to)) {
      throw new RoutingViolationError(
        `REQUEST from ${label(from)} to ${label(to)} requires sender to be a proper ancestor`,
        "ROUTING_REQUEST_NOT_ANCESTOR",
        { from, type, to },
      );
    }
    return { from, type, to, allowed: true, bypass: false };
  }

  throw new RoutingViolationError(`unsupported delivery type ${JSON.stringify(message.type)}`, "ROUTING_BAD_TYPE");
}

export async function deliver(message: RoutedMessage, options: RouterOptions = {}): Promise<Record<string, unknown>> {
  const root = rootDir(options);
  try {
    const type = normalizeType(required(message.type, "type"));
    if (type === "REPLY") return await deliverReply(message, { ...options, rootDir: root });
    const auth = authorize(message);
    if (type === "NOTIFY") {
      const result = await deliverNotify(message, auth, { ...options, rootDir: root });
      await ledgerRoutingDelivery(root, message, auth, result, options);
      return result;
    }
    if (type === "REQUEST") {
      const result = await deliverRequest(message, auth, { ...options, rootDir: root });
      await ledgerRoutingDelivery(root, message, auth, result, options);
      return result;
    }
  } catch (err) {
    if (isRoutingViolation(err)) {
      await ledgerRoutingViolation(root, message, err, options);
      if (options.feedback !== false) {
        const feedback = await writeViolationFeedback(root, message, err, options);
        if (feedback) err.details.feedback = feedback;
      }
      throw err;
    }
    throw err;
  }
  throw new RoutingViolationError(`unsupported delivery type ${JSON.stringify(message.type)}`, "ROUTING_BAD_TYPE");
}

export async function sendMessage(
  rootOrMessage: string | RoutedMessage,
  messageOrOptions: RoutedMessage | RouterOptions = {},
  options: RouterOptions = {},
): Promise<Record<string, unknown>> {
  if (typeof rootOrMessage === "string") {
    return deliver(messageOrOptions as RoutedMessage, { ...options, rootDir: rootOrMessage });
  }
  return deliver(rootOrMessage, messageOrOptions as RouterOptions);
}

async function deliverNotify(message: RoutedMessage, auth: Authorization, options: RouterOptions): Promise<Record<string, unknown>> {
  const root = rootDir(options);
  const id = sanitizeDeliveryId(message.id ?? generatedDeliveryId(message, options));
  const received = dateOnly(message.received ?? options.now ?? todayIso());
  const relPath = posixJoin(auth.to === "." ? "" : auth.to, "inbox", `${id}.md`);
  const filePath = path.join(root, fromPosix(relPath));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeInboxItem({
    id,
    type: "notify",
    from: auth.from,
    received,
    refs: message.refs ?? [],
    expires: message.expires,
    subject: message.subject,
    body: message.body,
  }), { encoding: "utf8", flag: message.overwrite ? "w" : "wx" });
  return { action: "notify", id, to: auth.to, path: filePath, relPath };
}

async function deliverRequest(message: RoutedMessage, auth: Authorization, options: RouterOptions): Promise<Record<string, unknown>> {
  const ticket = await createTicket({
    id: message.id ?? message.ticketId,
    from: auth.from,
    to: auth.to,
    opened: message.opened ?? message.received ?? dateOnly(options.now ?? todayIso()),
    deadline: message.deadline,
    subject: message.subject ?? "",
    body: message.body ?? "",
  }, options);
  return { action: "ticket", ticket, path: ticket.path, relPath: ticket.relPath };
}

async function deliverReply(message: RoutedMessage, options: RouterOptions): Promise<Record<string, unknown>> {
  const root = rootDir(options);
  let ticket: Ticket | undefined;
  try {
    ticket = await readTicket(replyTicketRef(message), { rootDir: root });
    const auth = authorize({ ...message, type: "REPLY", ticket });
    const updated = await replyToTicket(
      { relPath: ticket.relPath },
      { from: message.from ?? "", body: message.body ?? "", at: message.at ?? message.received ?? options.now },
      { rootDir: root },
    );
    const result = { action: "reply", ticket: updated, path: updated.path, relPath: updated.relPath };
    await ledgerRoutingDelivery(root, message, auth, result, options);
    return result;
  } catch (err) {
    if (err instanceof TicketError && ["TICKET_REPLY_FORBIDDEN", "TICKET_NOT_OPEN"].includes(err.code)) {
      throw ticketRoutingViolation(err, message, ticket);
    }
    throw err;
  }
}

function authorizeReply(message: RoutedMessage & { ticket?: Ticket; from: string; type: string }): Authorization {
  const ticket = message.ticket;
  if (!ticket || typeof ticket !== "object") {
    throw new RoutingViolationError("reply authorization requires a ticket", "ROUTING_REPLY_NO_TICKET", {
      from: message.from,
      ticketId: message.ticketId ?? message.ticket,
    });
  }
  const from = normalizeSender(message.from);
  const ticketTo = normalizeTicketAgentPath(ticket.to);
  if (ticket.state !== "open") {
    throw new RoutingViolationError(
      `ticket ${ticket.id} is ${ticket.state}; replies require open`,
      "ROUTING_REPLY_CLOSED",
      { from, ticketId: ticket.id, state: ticket.state },
    );
  }
  if (from !== ticketTo) {
    throw new RoutingViolationError(
      `ticket ${ticket.id} may only be answered by ${label(ticketTo)}`,
      "ROUTING_REPLY_WRONG_AGENT",
      { from, ticketId: ticket.id, ticketTo },
    );
  }
  return {
    from,
    type: "REPLY",
    to: normalizeTicketAgentPath(ticket.from),
    ticketId: ticket.id,
    allowed: true,
    bypass: false,
  };
}

function ticketRoutingViolation(error: TicketError, message: RoutedMessage, ticket?: Ticket): RoutingViolationError {
  const from = normalizeSender(message.from ?? "");
  if (error.code === "TICKET_NOT_OPEN") {
    return new RoutingViolationError(error.message, "ROUTING_REPLY_CLOSED", {
      from,
      ticketId: ticket?.id,
      state: ticket?.state,
    });
  }
  return new RoutingViolationError(error.message, "ROUTING_REPLY_WRONG_AGENT", {
    from,
    ticketId: ticket?.id,
    ticketTo: ticket?.to,
  });
}

async function ledgerRoutingViolation(root: string, message: RoutedMessage, error: RoutingViolationError, options: RouterOptions): Promise<void> {
  const ledgerPath = path.join(root, "ingest", "ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const row = {
    type: "routing-violation",
    at: timestamp(options.now),
    from: message.from ?? null,
    messageType: message.type ?? null,
    to: message.to ?? message.ticketId ?? message.ticket ?? null,
    code: error.code,
    reason: error.message,
  };
  await appendFile(ledgerPath, `${JSON.stringify(row)}\n`, "utf8");
}

async function ledgerRoutingDelivery(
  root: string,
  message: RoutedMessage,
  auth: Authorization,
  result: Record<string, unknown>,
  options: RouterOptions,
): Promise<void> {
  const ledgerPath = path.join(root, "ingest", "ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const row: Record<string, unknown> = {
    type: "routing-delivery",
    at: timestamp(options.now),
    from: auth.from,
    messageType: auth.type,
    to: auth.to,
    action: result.action,
    routedTo: result.relPath ?? null,
  };
  if (options.cycle !== undefined && options.cycle !== null) row.cycle = options.cycle;
  if (message.id ?? message.ticketId) row.id = message.id ?? message.ticketId;
  await appendFile(ledgerPath, `${JSON.stringify(row)}\n`, "utf8");
}

interface InboxItem {
  id: string;
  type: string;
  from: string;
  received: string;
  refs: string[];
  expires?: string;
  subject?: string;
  body?: string;
}

function serializeInboxItem(item: InboxItem): string {
  const lines = [
    "---",
    `id: ${quoteScalar(item.id)}`,
    `type: ${item.type}`,
    `from: ${quoteScalar(label(item.from))}`,
    `received: ${item.received}`,
    `refs: ${inlineArray(item.refs)}`,
  ];
  if (item.expires) lines.push(`expires: ${dateOnly(item.expires)}`);
  lines.push("---", "");
  const body: string[] = [];
  if (item.subject) body.push(`# ${String(item.subject).trim()}`, "");
  if (item.body) body.push(String(item.body).replace(/\s*$/u, ""));
  lines.push(body.join("\n"), "");
  return lines.join("\n");
}

async function writeViolationFeedback(
  root: string,
  message: RoutedMessage,
  error: RoutingViolationError,
  options: RouterOptions,
): Promise<Record<string, unknown> | null> {
  const from = message.from ? normalizeSender(message.from) : null;
  if (!from || isInfrastructureSender(from)) return null;
  const date = dateOnly(options.now ?? todayIso());
  const number = await nextRejectionNumber(root, from, date);
  const id = `rejected-${date}-${number}`;
  const relPath = posixJoin(from === "." ? "" : from, "inbox", `${id}.md`);
  const filePath = path.join(root, fromPosix(relPath));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeRejectionFeedback({ id, date, message, reason: error.message }), {
    encoding: "utf8",
    flag: "wx",
  });
  return { action: "notify", id, to: from, path: filePath, relPath };
}

export function serializeRejectionFeedback({
  id,
  date,
  message,
  reason,
}: {
  id: string;
  date: string;
  message: RoutedMessage;
  reason: string;
}): string {
  return [
    "---",
    `id: ${id}`,
    "type: notify",
    "from: ops",
    `received: ${date}`,
    "refs: []",
    "---",
    "",
    "Rejected message:",
    `> type: ${JSON.stringify(message.type ?? null)}`,
    `> to: ${JSON.stringify(rejectedMessageTarget(message))}`,
    `> subject: ${JSON.stringify(message.subject ?? null)}`,
    "",
    `Rejection reason: ${reason}`,
    "",
    "Review the routing rules before sending another message.",
    "",
  ].join("\n");
}

async function nextRejectionNumber(root: string, agentPath: string, date: string): Promise<number> {
  const inboxDir = path.join(root, fromPosix(posixJoin(agentPath === "." ? "" : agentPath, "inbox")));
  const pattern = new RegExp(`^rejected-${date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)\\.md$`);
  let max = 0;
  for (const entry of await safeReaddir(inboxDir)) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function replyTicketRef(message: RoutedMessage): string | { relPath?: string; id?: string; to?: string } {
  if (message.ticketPath) return { relPath: message.ticketPath };
  if (message.ticketRelPath) return { relPath: message.ticketRelPath };
  if (message.ticket && typeof message.ticket === "object") {
    if (message.ticket.relPath) return { relPath: message.ticket.relPath };
    if (message.ticket.id && message.ticket.to) return { id: message.ticket.id, to: message.ticket.to };
  }
  if (message.ticketId || message.ticket) return { id: String(message.ticketId ?? message.ticket) };
  if (message.id && !message.subject) return { id: message.id };
  throw new RoutingViolationError("reply delivery requires ticketId, ticket, or ticketPath", "ROUTING_REPLY_NO_TICKET", {
    from: message.from,
  });
}

function normalizeType(type: unknown): string {
  const raw = String(type ?? "").trim().toUpperCase();
  if (raw === "REPLY-TO-TICKET" || raw === "REPLY_TO_TICKET") return "REPLY";
  return raw;
}

function normalizeSender(sender: unknown): string {
  const raw = String(sender ?? "").trim();
  if (INFRASTRUCTURE_SENDERS.has(raw)) return raw;
  return normalizeAgentPath(raw);
}

function isInfrastructureSender(sender: string): boolean {
  return INFRASTRUCTURE_SENDERS.has(sender);
}

function isProperPrefix(prefix: string, target: string): boolean {
  if (prefix === target) return false;
  if (prefix === ".") return target !== ".";
  return target.startsWith(`${prefix}/`);
}

function required(value: unknown, field: string): string {
  if (value === undefined || value === null || String(value) === "") {
    throw new RoutingViolationError(`missing required ${field}`, "ROUTING_MISSING_FIELD", { field });
  }
  return String(value);
}

function isRoutingViolation(error: unknown): error is RoutingViolationError {
  return error instanceof RoutingViolationError;
}

function sanitizeDeliveryId(value: unknown): string {
  try {
    return baseSanitizeId(value, "delivery id");
  } catch (err) {
    throw new RoutingViolationError((err as Error).message, "ROUTING_INVALID_ID", { id: value });
  }
}

function generatedDeliveryId(message: RoutedMessage, options: RouterOptions): string {
  const date = dateOnly(options.now ?? message.received ?? todayIso());
  const subject = String(message.subject ?? message.body ?? "notify")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40) || "notify";
  return `notify-${date}-${subject}`;
}

function timestamp(now: unknown): string {
  if (!now) return new Date().toISOString();
  const text = String(now);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return `${text}T00:00:00.000Z`;
  return text;
}

function rootDir(options: RouterOptions = {}): string {
  return path.resolve(options.rootDir ?? options.root ?? process.cwd());
}

function label(agentPath: string): string {
  return labelAgentPath(agentPath);
}

function rejectedMessageTarget(message: RoutedMessage): unknown {
  return message.to ?? message.ticketId ?? message.ticket ?? null;
}
