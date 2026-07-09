import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  agentDepth,
  agentDir,
  agentRel,
  assertIsoDate,
  dateOnly,
  escapeRegex,
  firstDate,
  fromPosix,
  maybeReadText,
  normalizeAgentPath,
  parseLooseFrontmatter,
  posixJoin,
  safeReaddir,
  todayIso,
} from "./common.js";
import { formatFinding, jsonFindings, lintTree, type Finding, type LintOptions } from "./lint.js";
import { deliver, type RoutedMessage, type RouterOptions } from "./router.js";
import { parseCoverage } from "./scaffold.js";
import {
  normalizeWakeState,
  readLastWakeState,
  STATE_RELATIVE_PATH,
  writeLastWakeState,
  type WakeState,
} from "./state.js";
import { expire, type Ticket } from "./tickets.js";
import { wakeAgent as defaultWakeAgent, type WakeResult } from "./wake.js";

const execFileDefault = promisify(execFileCallback);
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_INBOX_THRESHOLD = 1;
const DEFAULT_DEPENDENCY_THRESHOLD = 1;
const SEVERITY_RANK: Record<string, number> = { routine: 0, notable: 1, material: 2, urgent: 3 };
const MEMORY_FILES_BY_ROLE: Record<string, string[]> = {
  root: ["BRIEF.md", "LOG.md"],
  group: ["BRIEF.md", "THESIS.md", "LOG.md"],
  entity: ["BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"],
};
const SCAN_LINE_FILES = ["LOG.md", "BRIEF.md"];

export interface OrgAgent {
  path: string;
  role: "root" | "group" | "entity";
  parent: string | null;
}

export interface OrgScan {
  agents: OrgAgent[];
  byPath: Map<string, OrgAgent>;
  childrenByParent: Map<string, OrgAgent[]>;
  groups: Record<string, string[]>;
}

export interface TriggerPlan {
  date: string;
  wake: string[];
  wakes: Array<{ agent: string; role: string; reasons: unknown[] }>;
  triggers: Record<"time" | "quantity" | "content" | "dependency", unknown[]>;
  counts: Record<string, number>;
  agents: Array<{ path: string; role: string; parent: string | null }>;
}

export interface TickOptions {
  date?: string;
  now?: string;
  concurrency?: number | string;
  maxRounds?: number;
  cycle?: number;
  lastWake?: WakeState;
  wakeAgent?: (agentPath: string, context: { root: string; date: string; cycle: number; reasons: unknown[] }) => Promise<Partial<WakeResult> | null | undefined>;
  deliverMessage?: typeof deliver;
  expireTickets?: typeof expire;
  lint?: boolean;
  repair?: boolean;
  commit?: boolean;
  tickets?: boolean;
  inboxThreshold?: number;
  dependencyThreshold?: number;
  execFile?: ExecFile;
}

type ExecFile = (
  command: string,
  args: string[],
  options: { cwd: string; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

export async function evaluateTriggers(rootDir = process.cwd(), options: TickOptions = {}): Promise<TriggerPlan> {
  const root = path.resolve(rootDir);
  const date = assertIsoDate(options.date ?? todayIso(), "date");
  const state = normalizeWakeState(options.lastWake ?? await readLastWakeState(root));
  const org = await scanOrg(root);
  const threshold = Number.isInteger(options.inboxThreshold) ? Number(options.inboxThreshold) : DEFAULT_INBOX_THRESHOLD;
  const dependencyThreshold = Number.isInteger(options.dependencyThreshold) ? Number(options.dependencyThreshold) : DEFAULT_DEPENDENCY_THRESHOLD;
  const wakes = new Map<string, { agent: string; role: string; reasons: unknown[] }>();
  const triggers: TriggerPlan["triggers"] = { time: [], quantity: [], content: [], dependency: [] };

  for (const agent of org.agents) {
    const due = await dueReviewFiles(root, agent, date);
    if (!due.length) continue;
    const reason = { class: "time", agent: agent.path, files: due };
    triggers.time.push(reason);
    addWake(wakes, agent.path, agent.role, reason);
  }

  for (const agent of org.agents) {
    const inboxDepth = await countInboxItems(root, agent.path);
    if (inboxDepth < threshold) continue;
    const reason = { class: "quantity", agent: agent.path, inboxDepth, threshold };
    triggers.quantity.push(reason);
    addWake(wakes, agent.path, agent.role, reason);
  }

  for (const agent of org.agents) {
    if (!agent.parent) continue;
    const parent = org.byPath.get(agent.parent);
    if (!parent) continue;
    const rows = await materialLinesSinceParentWake(root, agent, state[parent.path]?.lastWake);
    for (const row of rows) {
      const reason = { class: "content", agent: parent.path, source: agent.path, ...row };
      triggers.content.push(reason);
      addWake(wakes, parent.path, parent.role, reason);
    }
  }

  for (const parent of org.agents) {
    const children = org.childrenByParent.get(parent.path) ?? [];
    if (!children.length) continue;
    const completedChildren = children
      .filter((child) => wakeAfter(state[child.path]?.lastWake, state[parent.path]?.lastWake))
      .map((child) => child.path);
    if (completedChildren.length < dependencyThreshold) continue;
    const reason = { class: "dependency", agent: parent.path, completedChildren, threshold: dependencyThreshold };
    triggers.dependency.push(reason);
    addWake(wakes, parent.path, parent.role, reason);
  }

  const wakeList = [...wakes.values()].sort((a, b) => agentDepth(b.agent) - agentDepth(a.agent) || a.agent.localeCompare(b.agent));
  return {
    date,
    wake: wakeList.map((item) => item.agent),
    wakes: wakeList,
    triggers,
    counts: Object.fromEntries(Object.entries(triggers).map(([key, rows]) => [key, rows.length])),
    agents: org.agents.map((agent) => ({ path: agent.path, role: agent.role, parent: agent.parent })),
  };
}

export async function executeTick(rootDir = process.cwd(), options: TickOptions = {}): Promise<Record<string, unknown>> {
  const root = path.resolve(rootDir);
  const date = assertIsoDate(options.date ?? todayIso(), "date");
  const concurrency = normalizeConcurrency(options.concurrency ?? DEFAULT_CONCURRENCY);
  const execFile = options.execFile ?? execFileDefault as ExecFile;
  let state = normalizeWakeState(options.lastWake ?? await readLastWakeState(root));
  const cycle = options.cycle ?? nextStateCycle(state);
  const invoked = new Set<string>();
  const succeeded = new Set<string>();
  const failedWakes: Array<{ agent: string; error: string }> = [];
  const results: Array<Record<string, unknown> & { agent: string; role: string; result: Partial<WakeResult> | null }> = [];
  const plans: TriggerPlan[] = [];
  let lastPlan: TriggerPlan | null = null;
  let outboxRejections = 0;
  const ticketExpiry = options.tickets === false ? { expired: [], deliveries: [] } : await expireTickets(root, { ...options, date, cycle });
  const runtimeWritePaths = new Set<string>(runtimePathsFromTicketExpiry(ticketExpiry));

  for (let round = 0; round < (options.maxRounds ?? 20); round += 1) {
    const plan = await evaluateTriggers(root, { ...options, date, lastWake: state });
    lastPlan = plan;
    plans.push(plan);
    const pending = plan.wakes.filter((item) => !invoked.has(item.agent));
    if (!pending.length) break;
    const deepest = Math.max(...pending.map((item) => agentDepth(item.agent)));
    const batch = pending.filter((item) => agentDepth(item.agent) === deepest);
    const runner = options.wakeAgent ?? ((target: string, context: { root: string; date: string; cycle: number; reasons: unknown[] }) =>
      defaultWakeAgent(target, context));
    const batchResults = await runBounded(batch, concurrency, async (item) => {
      const target = options.wakeAgent ? item.agent : agentDir(root, item.agent);
      // Per-wake tolerance: one failed wake must not abort the tick. The seat
      // keeps its state unstamped so it stays due and retries next tick.
      try {
        const result = await runner(target, { root, date, cycle, reasons: item.reasons });
        return { agent: item.agent, role: item.role, result: result ?? null };
      } catch (err) {
        return {
          agent: item.agent,
          role: item.role,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
    const stampedAt = options.now ?? new Date().toISOString();
    for (const row of batchResults) {
      invoked.add(row.agent);
      if ("error" in row && row.error !== undefined) {
        failedWakes.push({ agent: row.agent, error: String(row.error) });
        results.push({ agent: row.agent, role: row.role, result: null, error: String(row.error) });
        continue;
      }
      succeeded.add(row.agent);
      const outboxResult = await deliverWakeOutbox(root, row.agent, row.result, { ...options, date, cycle });
      const enriched: Record<string, unknown> & { agent: string; role: string; result: Partial<WakeResult> | null } = {
        ...row,
        deliveries: outboxResult.deliveries,
      };
      if (outboxResult.rejections.length) enriched.rejections = outboxResult.rejections;
      outboxRejections += outboxResult.rejections.length;
      runtimeWritePaths.add(agentRel(row.agent, ".thread"));
      for (const delivery of outboxResult.deliveries) {
        if (typeof delivery.relPath === "string") runtimeWritePaths.add(delivery.relPath);
      }
      for (const rejection of outboxResult.rejections) {
        if (typeof rejection.feedback?.relPath === "string") runtimeWritePaths.add(rejection.feedback.relPath);
      }
      const severity = normalizeSeverity(row.result?.severity);
      state[row.agent] = { lastWake: stampedAt, cycle, lastSeverity: severity };
      results.push(enriched);
    }
    await writeLastWakeState(root, state);
  }

  if (!invoked.size) {
    // A no-wake tick is a pure no-op — no lint, no repair, no commit — so
    // repeated ticks with nothing due are side-effect-free by construction.
    // `org lint` covers on-demand checks.
    const statusLine = `tick ${date}: no wakes`;
    return {
      date,
      cycle,
      noop: true,
      statusLine,
      plan: lastPlan ?? plans.at(-1),
      ticketExpiry,
      post: { lint: "skipped", repairs: 0, committed: false },
    };
  }

  const post = await postTick(root, {
    ...options,
    date,
    cycle,
    // Lint liveness (missing LOG entries) applies only to wakes that ran;
    // failed wakes are retried next tick, not lint-flagged for silence.
    invoked: [...succeeded].sort(),
    results,
    runtimeWritePaths: [...runtimeWritePaths],
    execFile,
  });
  const highWater = maxSeverity(results.map((row) => row.result?.severity));
  const rejectionSummary = outboxRejections ? `, ${outboxRejections} outbox ${outboxRejections === 1 ? "rejection" : "rejections"}` : "";
  const failureSummary = failedWakes.length ? `, ${failedWakes.length} failed` : "";
  const counts = `${succeeded.size} wakes${failureSummary}, max ${highWater}${rejectionSummary}`;
  return {
    date,
    cycle,
    noop: false,
    statusLine: `tick ${date}: ${counts}`,
    counts,
    outboxRejections,
    invoked: [...invoked].sort(),
    failedWakes,
    results,
    plans,
    ticketExpiry,
    post,
  };
}

export async function statusOverview(rootDir = process.cwd(), options: TickOptions = {}): Promise<Record<string, unknown>> {
  const root = path.resolve(rootDir);
  const date = assertIsoDate(options.date ?? todayIso(), "date");
  const state = await readLastWakeState(root);
  const org = await scanOrg(root);
  const agents = [];
  for (const agent of org.agents) {
    const overdueReviews = await dueReviewFiles(root, agent, date);
    const inboxDepth = await countInboxItems(root, agent.path);
    const openTickets = await countOpenTickets(root, agent.path);
    const highWater = await severityHighWater(root, agent.path);
    agents.push({
      path: agent.path,
      role: agent.role,
      lastWake: state[agent.path]?.lastWake ?? null,
      cycle: state[agent.path]?.cycle ?? null,
      lastSeverity: state[agent.path]?.lastSeverity ?? null,
      inboxDepth,
      openTickets,
      overdueReviews,
      severityHighWater: highWater,
    });
  }
  return {
    date,
    totals: {
      agents: agents.length,
      inboxDepth: agents.reduce((sum, agent) => sum + agent.inboxDepth, 0),
      openTickets: agents.reduce((sum, agent) => sum + agent.openTickets, 0),
      overdueReviews: agents.reduce((sum, agent) => sum + agent.overdueReviews.length, 0),
      severityHighWater: maxSeverity(agents.map((agent) => agent.severityHighWater)),
    },
    agents,
  };
}

export async function scanOrg(rootDir = process.cwd()): Promise<OrgScan> {
  const root = path.resolve(rootDir);
  const groups = await groupsFromCoverage(root) ?? await groupsFromScan(root);
  const agents: OrgAgent[] = [{ path: ".", role: "root", parent: null }];
  const childrenByParent = new Map<string, OrgAgent[]>([[".", []]]);
  for (const [groupName, entityPaths] of Object.entries(groups)) {
    const group: OrgAgent = { path: groupName, role: "group", parent: "." };
    agents.push(group);
    childrenByParent.get(".")!.push(group);
    childrenByParent.set(groupName, []);
    for (const entityPath of entityPaths) {
      const entity: OrgAgent = { path: entityPath, role: "entity", parent: groupName };
      agents.push(entity);
      childrenByParent.get(groupName)!.push(entity);
      childrenByParent.set(entityPath, []);
    }
  }
  return { agents, byPath: new Map(agents.map((agent) => [agent.path, agent])), childrenByParent, groups };
}

async function groupsFromCoverage(root: string): Promise<Record<string, string[]> | null> {
  const text = await maybeReadText(path.join(root, "coverage.toml"));
  if (text === null) return null;
  try {
    const coverage = parseCoverage(text);
    if (!coverage.groups.length) return null;
    return Object.fromEntries(coverage.groups.map((group) => [group.name, group.entities.map((entity) => posixJoin(group.name, entity))]));
  } catch {
    return null;
  }
}

async function groupsFromScan(root: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const entry of await safeReaddir(root)) {
    if (!entry.isDirectory() || shouldSkipTopLevel(entry.name)) continue;
    const groupDir = path.join(root, entry.name);
    if (!(await hasFiles(groupDir, ["AGENTS.md", "BRIEF.md", "THESIS.md", "LOG.md"]))) continue;
    out[entry.name] = [];
    for (const child of await safeReaddir(groupDir)) {
      if (!child.isDirectory()) continue;
      const entityPath = posixJoin(entry.name, child.name);
      if (await hasFiles(path.join(groupDir, child.name), ["AGENTS.md", "BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"])) {
        out[entry.name]!.push(entityPath);
      }
    }
  }
  return out;
}

function shouldSkipTopLevel(name: string): boolean {
  return name.startsWith(".") || ["docs", "templates", "ingest", "node_modules"].includes(name);
}

async function hasFiles(dir: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    try {
      const info = await stat(path.join(dir, file));
      if (!info.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function postTick(
  root: string,
  options: TickOptions & {
    invoked: string[];
    results: Array<{ result: Partial<WakeResult> | null }>;
    runtimeWritePaths: string[];
    execFile: ExecFile;
    cycle: number;
    date: string;
  },
): Promise<Record<string, unknown>> {
  const invoked = options.invoked ?? [];
  let diffPaths: string[] = [];
  if ((options.lint !== false || options.commit === true) && invoked.length > 0) {
    diffPaths = filterRuntimeDiffPaths(await gitStatusPaths(root, options.execFile), options.runtimeWritePaths);
  }
  let repairs = 0;
  let findings: Finding[] = [];
  if (options.lint !== false) {
    for (let round = 0; round <= 2; round += 1) {
      const lintOptions: LintOptions = {};
      if (invoked.length > 0) {
        lintOptions.cycle = options.cycle;
        lintOptions.diffPaths = diffPaths.join("\n");
        lintOptions.invokedPaths = invoked.join(",");
      }
      findings = await lintTree(root, lintOptions);
      if (!hasErrors(findings) || round === 2 || options.repair !== true) break;
      const agents = repairAgents(findings);
      if (!agents.length) break;
      await runRepair(root, { date: options.date, cycle: options.cycle, findings: jsonFindings(findings), execFile: options.execFile });
      repairs += agents.length;
      for (const agent of agents) {
        if (!invoked.includes(agent)) invoked.push(agent);
      }
      diffPaths = filterRuntimeDiffPaths(await gitStatusPaths(root, options.execFile), options.runtimeWritePaths);
    }
    if (hasErrors(findings)) throw new Error(`org-lint failed after tick:\n${findings.map(formatFinding).join("\n")}`);
  }
  let committed = false;
  if (options.commit === true) {
    const max = maxSeverity(options.results.map((row) => row.result?.severity));
    const message = `tick ${options.date}: ${options.results.length} wakes, max ${max}${repairs ? `, ${repairs} repairs` : ""}`;
    await options.execFile("git", ["add", "-A"], { cwd: root });
    await options.execFile("git", ["commit", "--allow-empty", "-m", message], { cwd: root });
    committed = true;
  }
  return { lint: options.lint === false ? "skipped" : "passed", repairs, committed };
}

function filterRuntimeDiffPaths(diffPaths: string[], runtimeWritePaths: string[]): string[] {
  const runtimeOwned = new Set([STATE_RELATIVE_PATH, ...runtimeWritePaths.map((relPath) => relPath.split(path.sep).join("/"))]);
  return diffPaths.filter((rawPath) => !runtimeOwned.has(rawPath.split(path.sep).join("/")));
}

async function expireTickets(root: string, options: TickOptions & { date: string; cycle: number }): Promise<{ expired: unknown[]; deliveries: Record<string, unknown>[] }> {
  const expireImpl = options.expireTickets ?? expire;
  const result = await expireImpl(options.date, { rootDir: root });
  const deliveries = [];
  for (const notification of result.notifications ?? []) deliveries.push(await deliverRuntimeMessage(root, notification, options));
  return { expired: (result.expired ?? []).map(ticketSummary), deliveries };
}

async function deliverWakeOutbox(
  root: string,
  agentPath: string,
  result: Partial<WakeResult> | null,
  options: TickOptions & { date: string; cycle: number },
): Promise<{ deliveries: Record<string, unknown>[]; rejections: RejectionSummary[] }> {
  const outbox = result?.outbox ?? [];
  if (!Array.isArray(outbox) || !outbox.length) return { deliveries: [], rejections: [] };
  const deliveries: Record<string, unknown>[] = [];
  const rejections: RejectionSummary[] = [];
  let rejectionNumber = await nextRejectionNumber(root, agentPath, options.date);
  for (const message of outbox) {
    const routedMessage = { ...(message as Record<string, unknown>), from: agentPath } as RoutedMessage;
    try {
      deliveries.push(await deliverRuntimeMessage(root, routedMessage, options));
    } catch (err) {
      if (!isRoutingDeliveryError(err)) throw err;
      const feedback = routingErrorFeedback(err) ?? await writeOutboxRejectionFeedback(root, agentPath, routedMessage, err as Error, {
        ...options,
        rejectionNumber,
      });
      rejectionNumber += 1;
      rejections.push({
        action: "rejected",
        from: agentPath,
        type: routedMessage.type ?? null,
        to: rejectedMessageTarget(routedMessage),
        subject: routedMessage.subject ?? null,
        code: String((err as { code?: unknown }).code ?? ""),
        reason: (err as Error).message,
        feedback,
      });
    }
  }
  return { deliveries, rejections };
}

interface RejectionSummary {
  action: "rejected";
  from: string;
  type: string | null;
  to: unknown;
  subject: string | null;
  code: string;
  reason: string;
  feedback: Record<string, unknown>;
}

async function deliverRuntimeMessage(
  root: string,
  message: RoutedMessage,
  options: TickOptions & RouterOptions,
): Promise<Record<string, unknown>> {
  const deliverImpl = options.deliverMessage ?? deliver;
  return deliverImpl(message, { rootDir: root, now: options.now ?? options.date, cycle: options.cycle, feedback: false });
}

async function writeOutboxRejectionFeedback(
  root: string,
  agentPath: string,
  message: RoutedMessage,
  error: Error,
  options: TickOptions & { date: string; rejectionNumber: number },
): Promise<Record<string, unknown>> {
  const id = `rejected-${options.date}-${options.rejectionNumber}`;
  const relPath = agentRel(agentPath, posixJoin("inbox", `${id}.md`));
  const filePath = path.join(root, fromPosix(relPath));
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(filePath, serializeOutboxRejectionFeedback({ id, date: options.date, message, reason: error.message }), { encoding: "utf8", flag: "wx" });
    return { action: "notify", id, to: normalizeAgentPath(agentPath), path: filePath, relPath };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return { action: "notify", id, to: normalizeAgentPath(agentPath), path: filePath, relPath, reused: true };
  }
}

function serializeOutboxRejectionFeedback({
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
    "Rejected outbox message:",
    `> type: ${JSON.stringify(message.type ?? null)}`,
    `> to: ${JSON.stringify(rejectedMessageTarget(message))}`,
    `> subject: ${JSON.stringify(message.subject ?? null)}`,
    "",
    `Rejection reason: ${reason}`,
    "",
    "consult the OUTBOX RULES in your wake instructions; record unmet needs in your LOG/WATCHLIST instead",
    "",
  ].join("\n");
}

async function nextRejectionNumber(root: string, agentPath: string, date: string): Promise<number> {
  const entries = await safeReaddir(path.join(agentDir(root, agentPath), "inbox"));
  const pattern = new RegExp(`^rejected-${escapeRegex(date)}-(\\d+)\\.md$`, "u");
  let max = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function rejectedMessageTarget(message: RoutedMessage): unknown {
  return message.to ?? message.ticketId ?? message.ticket ?? null;
}

function isRoutingDeliveryError(error: unknown): boolean {
  return (error as { name?: unknown })?.name === "RoutingViolationError" || String((error as { code?: unknown })?.code ?? "").startsWith("ROUTING_");
}

function routingErrorFeedback(error: unknown): Record<string, unknown> | null {
  const feedback = (error as { details?: { feedback?: unknown } })?.details?.feedback;
  return feedback && typeof feedback === "object" && !Array.isArray(feedback) ? feedback as Record<string, unknown> : null;
}

async function runRepair(
  root: string,
  options: { date: string; cycle: number; findings: unknown; execFile: ExecFile },
): Promise<void> {
  const args = JSON.stringify({ date: options.date, cycle: options.cycle, findings: options.findings });
  const command = process.env.ULTRACODEX_BIN ?? process.execPath;
  const prefix = process.env.ULTRACODEX_BIN ? [] : [cliEntryPath()];
  await options.execFile(command, [...prefix, "run", "org-lint-repair", "--args", args, "--json"], { cwd: root });
}

function cliEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

async function gitStatusPaths(root: string, execFile: ExecFile): Promise<string[]> {
  try {
    const { stdout } = await execFile("git", ["status", "--short", "-uall"], { cwd: root, maxBuffer: 1024 * 1024 });
    return parseGitStatusPaths(stdout);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") return [];
    throw error;
  }
}

function parseGitStatusPaths(stdout: string): string[] {
  const out: string[] = [];
  for (const line of String(stdout ?? "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    const arrow = raw.indexOf(" -> ");
    out.push(arrow >= 0 ? raw.slice(arrow + 4) : raw);
  }
  return out.sort();
}

async function dueReviewFiles(root: string, agent: OrgAgent, date: string): Promise<Array<{ file: string; next_review: string }>> {
  const due = [];
  for (const file of await memoryFiles(root, agent)) {
    const rel = agentRel(agent.path, file);
    const text = await maybeReadText(path.join(root, fromPosix(rel)));
    if (text === null) continue;
    const nextReview = parseNextReview(text);
    if (nextReview && nextReview <= date) due.push({ file: rel, next_review: nextReview });
  }
  return due.sort((a, b) => a.file.localeCompare(b.file));
}

async function memoryFiles(root: string, agent: OrgAgent): Promise<string[]> {
  const expected = MEMORY_FILES_BY_ROLE[agent.role] ?? [];
  const markdown = (await safeReaddir(agentDir(root, agent.path)))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "AGENTS.md")
    .map((entry) => entry.name);
  return [...new Set([...expected, ...markdown])].sort();
}

async function materialLinesSinceParentWake(
  root: string,
  agent: OrgAgent,
  parentLastWake: string | undefined,
): Promise<Array<{ file: string; line: number; date: string | null; severity: string; text: string }>> {
  const rows: Array<{ file: string; line: number; date: string | null; severity: string; text: string }> = [];
  const materialRank = SEVERITY_RANK.material ?? 2;
  for (const file of SCAN_LINE_FILES) {
    const rel = agentRel(agent.path, file);
    const text = await maybeReadText(path.join(root, fromPosix(rel)));
    if (text === null) continue;
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const severity = lineSeverity(line);
      if (severityRank(severity) < materialRank) continue;
      const lineDate = firstDate(line);
      if (!lineIsSince(lineDate, parentLastWake)) continue;
      rows.push({ file: rel, line: index + 1, date: lineDate, severity: normalizeSeverity(severity), text: line.trim() });
    }
  }
  return rows;
}

async function countInboxItems(root: string, agentPath: string): Promise<number> {
  return (await safeReaddir(path.join(agentDir(root, agentPath), "inbox")))
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name !== ".gitkeep").length;
}

async function countOpenTickets(root: string, agentPath: string): Promise<number> {
  let count = 0;
  for (const entry of await safeReaddir(path.join(agentDir(root, agentPath), "tickets"))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = await maybeReadText(path.join(agentDir(root, agentPath), "tickets", entry.name));
    const state = frontmatterField(text ?? "", "state");
    if (!state || state === "open") count += 1;
  }
  return count;
}

async function severityHighWater(root: string, agentPath: string): Promise<string> {
  let max = "routine";
  for (const file of SCAN_LINE_FILES) {
    const text = await maybeReadText(path.join(agentDir(root, agentPath), file));
    if (text === null) continue;
    for (const line of text.split(/\r?\n/u)) {
      const severity = lineSeverity(line);
      if (severityRank(severity) > severityRank(max)) max = normalizeSeverity(severity);
    }
  }
  return max;
}

function parseNextReview(text: string): string | null {
  return frontmatterField(text, "next_review", /^\d{4}-\d{2}-\d{2}$/u);
}

function frontmatterField(text: string, key: string, valueRe: RegExp | null = null): string | null {
  const fields = parseLooseFrontmatter(text);
  const value = fields[key.toLowerCase().replace(/[-_\s]/gu, "")];
  if (!value || (valueRe && !valueRe.test(value))) return null;
  return value;
}

function addWake(wakes: Map<string, { agent: string; role: string; reasons: unknown[] }>, agentPath: string, role: string, reason: unknown): void {
  const agent = normalizeAgentPath(agentPath);
  if (!wakes.has(agent)) wakes.set(agent, { agent, role, reasons: [] });
  wakes.get(agent)!.reasons.push(reason);
}

function lineSeverity(line: string): string | null {
  const match = line.match(/\bseverity\s*[:=]\s*(routine|notable|material|urgent)\b/iu);
  return match ? match[1]!.toLowerCase() : null;
}

function normalizeSeverity(value: unknown): string {
  const severity = String(value ?? "routine").toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity) ? severity : "routine";
}

function normalizeConcurrency(value: unknown): number {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`concurrency must be a positive integer, got ${JSON.stringify(value)}`);
  return concurrency;
}

function severityRank(value: unknown): number {
  return SEVERITY_RANK[normalizeSeverity(value)] ?? 0;
}

function maxSeverity(values: unknown[]): string {
  let max = "routine";
  for (const value of values) {
    const severity = normalizeSeverity(value);
    if (severityRank(severity) > severityRank(max)) max = severity;
  }
  return max;
}

function lineIsSince(lineDate: string | null, lastWake: string | undefined): boolean {
  if (!lastWake) return true;
  if (!lineDate) return false;
  const lastDate = dateOnly(lastWake);
  return !lastDate || lineDate > lastDate;
}

function wakeAfter(childWake: string | undefined, parentWake: string | undefined): boolean {
  if (!childWake) return false;
  if (!parentWake) return true;
  return String(childWake) > String(parentWake);
}

function nextStateCycle(state: WakeState): number {
  let max = 0;
  for (const row of Object.values(state)) {
    const cycle = Number(row?.cycle);
    if (Number.isInteger(cycle) && cycle > max) max = cycle;
  }
  return max + 1;
}

function repairAgents(findings: Finding[]): string[] {
  return [...new Set(findings.map((finding) => finding.agent || "."))].sort();
}

function hasErrors(findings: Finding[]): boolean {
  return findings.some((finding) => finding.level === "ERROR");
}

function ticketSummary(ticket: Ticket): Record<string, unknown> {
  return { id: ticket.id, from: ticket.from, to: ticket.to, deadline: ticket.deadline, state: ticket.state, relPath: ticket.relPath };
}

function runtimePathsFromTicketExpiry(ticketExpiry: { expired: unknown[]; deliveries: Record<string, unknown>[] }): string[] {
  const paths: string[] = [];
  for (const ticket of ticketExpiry.expired) {
    if (ticket && typeof ticket === "object" && typeof (ticket as { relPath?: unknown }).relPath === "string") paths.push((ticket as { relPath: string }).relPath);
  }
  for (const delivery of ticketExpiry.deliveries) {
    if (typeof delivery.relPath === "string") paths.push(delivery.relPath);
  }
  return paths;
}

async function runBounded<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current]!, current);
    }
  }));
  return results;
}

export const internals = { parseGitStatusPaths };
