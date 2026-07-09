import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askAgent, renderAskScript } from "../src/org/ask.js";
import { runOrgAudit } from "../src/org/audit.js";
import { lintTree } from "../src/org/lint.js";
import {
  applyReplayFaults,
  deriveReplayCorpus,
  parseReplayFaults,
  runOrgReplay,
  windowReplayDays,
  writeReplayDayInboxItems,
  type ReplayDelivery,
} from "../src/org/replay.js";
import { deliver, RoutingViolationError } from "../src/org/router.js";
import { executeTick, evaluateTriggers, statusOverview } from "../src/org/scheduler.js";
import { initOrg, parseCoverage, scaffold } from "../src/org/scaffold.js";
import { readLastWakeState, writeLastWakeState } from "../src/org/state.js";
import { create, expire, read, reply, TicketError, transition } from "../src/org/tickets.js";
import { renderWakeScript, wakeAgent } from "../src/org/wake.js";
import { loadScript } from "../src/loader.js";
import { validateWorkflowScript } from "../src/validate.js";
import type { WorkflowGlobals } from "../src/types.js";

const dirs: string[] = [];
const TODAY = "2026-07-07";
const FUTURE = "2099-01-01";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.ORG_WAKE_CAP;
  delete process.env.ULTRACODEX_BIN;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmpRepo(prefix = "org-core-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function rootAgent(repo: string, nextReview = FUTURE, body = ""): Promise<void> {
  await mkdir(path.join(repo, "inbox"), { recursive: true });
  await writeFile(path.join(repo, "AGENTS.md"), "# root\n");
  await writeFile(path.join(repo, "BRIEF.md"), memory(nextReview, body));
  await writeFile(path.join(repo, "LOG.md"), memory(nextReview, body));
}

async function groupAgent(repo: string, group: string, nextReview = FUTURE, logBody = ""): Promise<void> {
  const dir = path.join(repo, group);
  await mkdir(path.join(dir, "inbox"), { recursive: true });
  await writeFile(path.join(dir, "AGENTS.md"), `# ${group}\n`);
  await writeFile(path.join(dir, "BRIEF.md"), memory(nextReview));
  await writeFile(path.join(dir, "THESIS.md"), memory(nextReview, "- group claim [source:group]\n"));
  await writeFile(path.join(dir, "LOG.md"), memory(nextReview, logBody));
}

async function entityAgent(repo: string, group: string, entity: string, nextReview = FUTURE, logBody = "", briefBody = ""): Promise<void> {
  const dir = path.join(repo, group, entity);
  await mkdir(path.join(dir, "inbox"), { recursive: true });
  await mkdir(path.join(dir, "FACTS"), { recursive: true });
  await writeFile(path.join(dir, "AGENTS.md"), `# ${entity}\n`);
  await writeFile(path.join(dir, "BRIEF.md"), memory(nextReview, briefBody));
  await writeFile(path.join(dir, "IDENTITY.md"), memory(nextReview));
  await writeFile(path.join(dir, "THESIS.md"), memory(nextReview, "- entity claim [source:entity]\n"));
  await writeFile(path.join(dir, "LOG.md"), memory(nextReview, logBody));
  await writeFile(path.join(dir, "WATCHLIST.md"), memory(nextReview, `- Review ${FUTURE}\n`));
}

async function twoGroupOrg(): Promise<string> {
  const repo = await tmpRepo();
  await rootAgent(repo);
  await groupAgent(repo, "alpha");
  await entityAgent(repo, "alpha", "w1");
  await entityAgent(repo, "alpha", "w2");
  await groupAgent(repo, "beta");
  await entityAgent(repo, "beta", "b1");
  return repo;
}

function memory(nextReview = FUTURE, body = "# Memory\n"): string {
  return [
    "---",
    `updated: ${TODAY}`,
    "sources: []",
    "confidence: possible",
    `next_review: ${nextReview}`,
    "---",
    "",
    body,
  ].join("\n");
}

async function inboxItem(repo: string, agentPath: string, filename: string, received = TODAY, sourceDate?: string): Promise<void> {
  const dir = path.join(repo, ...agentPath.split("/"), "inbox");
  await mkdir(dir, { recursive: true });
  const lines = ["---", `id: ${filename.replace(/\.md$/u, "")}`, "type: notify", "from: ops", `received: ${received}`, "refs: []", "---", ""];
  if (sourceDate) lines.push(`Document date: ${sourceDate}`, "");
  await writeFile(path.join(dir, filename), lines.join("\n"));
}

async function ledgerRows(repo: string): Promise<Array<Record<string, unknown>>> {
  const file = path.join(repo, "ingest", "ledger.jsonl");
  const text = fs.existsSync(file) ? await readFile(file, "utf8") : "";
  return text.trim() ? text.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

function workflowGlobals(overrides?: Partial<WorkflowGlobals>): WorkflowGlobals {
  return {
    agent: async () => null,
    parallel: async (thunks) => Promise.all(thunks.map((thunk) => thunk().catch(() => null))),
    pipeline: async (items) => items,
    phase: () => {},
    log: () => {},
    args: undefined,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    workflow: async () => null,
    ...overrides,
  };
}

describe("org state and tickets", () => {
  it("stores normalized wake state under package-owned state", async () => {
    const repo = await tmpRepo();
    await writeLastWakeState(repo, {
      root: { lastWake: "2026-07-07T00:00:00.000Z", cycle: 2, lastSeverity: "routine" },
      "alpha/w1/": { lastWake: "2026-07-07T01:00:00.000Z", cycle: 3, lastSeverity: "urgent" },
    });

    await expect(stat(path.join(repo, ".ultracodex", "org", "state", "last-wake.json"))).resolves.toBeTruthy();
    await expect(stat(path.join(repo, "runtime", "state", "last-wake.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readLastWakeState(repo)).resolves.toEqual({
      ".": { lastWake: "2026-07-07T00:00:00.000Z", cycle: 2, lastSeverity: "routine" },
      "alpha/w1": { lastWake: "2026-07-07T01:00:00.000Z", cycle: 3, lastSeverity: "urgent" },
    });
  });

  it("handles ticket lifecycle, replies, and expiry notices", async () => {
    const repo = await twoGroupOrg();
    const created = await create({
      id: "question-1",
      from: ".",
      to: "alpha/w1",
      opened: TODAY,
      deadline: "2026-07-09",
      subject: "Check item",
      body: "Please answer.",
    }, { rootDir: repo });
    expect(created.relPath).toBe("alpha/w1/tickets/question-1.md");

    await expect(reply({ to: "alpha/w1", id: "question-1" }, { from: "alpha/w2", body: "No." }, { rootDir: repo }))
      .rejects.toMatchObject({ code: "TICKET_REPLY_FORBIDDEN" });
    const answered = await reply({ to: "alpha/w1", id: "question-1" }, { from: "alpha/w1", at: "2026-07-08", body: "Answer." }, { rootDir: repo });
    expect(answered.state).toBe("done");
    expect(answered.replies).toBe("## Reply\n\n- 2026-07-08 \u00b7 from alpha/w1\n\nAnswer.\n");
    await expect(transition({ to: "alpha/w1", id: "question-1" }, "open", { rootDir: repo }))
      .rejects.toBeInstanceOf(TicketError);

    await create({ id: "old", from: ".", to: "alpha/w2", opened: "2026-07-01", deadline: "2026-07-05", subject: "Old", body: "Body" }, { rootDir: repo });
    const expired = await expire(TODAY, { rootDir: repo });
    expect(expired.expired.map((ticket) => ticket.id)).toEqual(["old"]);
    expect(expired.notifications[0]).toMatchObject({ from: "ops", to: ".", id: "expired-old" });
    await expect(read({ to: "alpha/w2", id: "old" }, { rootDir: repo })).resolves.toMatchObject({ state: "expired" });
  });
});

describe("org router", () => {
  it("enforces authority, ledgers violations, and writes sender feedback", async () => {
    const repo = await twoGroupOrg();
    await expect(deliver({ id: "bad-up", from: "alpha/w1", type: "NOTIFY", to: "alpha", subject: "No", body: "Body" }, { rootDir: repo, now: TODAY }))
      .rejects.toBeInstanceOf(RoutingViolationError);

    const feedback = await readFile(path.join(repo, "alpha", "w1", "inbox", "rejected-2026-07-07-1.md"), "utf8");
    expect(feedback).toContain("> type: \"NOTIFY\"");
    expect((await ledgerRows(repo))[0]).toMatchObject({ type: "routing-violation", code: "ROUTING_NOTIFY_UPTREE" });

    await expect(deliver({ id: "cross", from: "alpha", type: "REQUEST", to: "beta/b1", subject: "No", body: "Body" }, { rootDir: repo, now: TODAY }))
      .rejects.toMatchObject({ code: "ROUTING_REQUEST_NOT_ANCESTOR" });
    const ops = await deliver({ id: "ops-req", from: "ops", type: "REQUEST", to: "beta/b1", subject: "Ops", body: "Body" }, { rootDir: repo, now: TODAY });
    expect(ops.relPath).toBe("beta/b1/tickets/ops-req.md");
    expect((await ledgerRows(repo)).some((row) => row.type === "routing-delivery" && row.routedTo === "beta/b1/tickets/ops-req.md")).toBe(true);
  });

  it("allows only the ticket target to reply to an open ticket", async () => {
    const repo = await twoGroupOrg();
    await deliver({ id: "reply-ticket", from: "alpha", type: "REQUEST", to: "alpha/w1", subject: "Need answer", body: "Body" }, { rootDir: repo, now: TODAY });
    await expect(deliver({ from: "alpha/w2", type: "REPLY", ticketId: "reply-ticket", body: "Wrong" }, { rootDir: repo, now: TODAY }))
      .rejects.toMatchObject({ code: "ROUTING_REPLY_WRONG_AGENT" });
    await expect(deliver({ from: "alpha/w1", type: "REPLY", ticketId: "reply-ticket", body: "Right" }, { rootDir: repo, now: TODAY }))
      .resolves.toMatchObject({ action: "reply", relPath: "alpha/w1/tickets/reply-ticket.md" });
  });
});

describe("org scheduler", () => {
  it("evaluates all trigger classes", async () => {
    const repo = await tmpRepo();
    await rootAgent(repo);
    await groupAgent(repo, "alpha");
    await entityAgent(repo, "alpha", "w1", "2026-07-01", "- 2026-07-07 - cycle 4 - material update - severity:material\n");
    await inboxItem(repo, "alpha/w1", "notice.md");

    const plan = await evaluateTriggers(repo, {
      date: TODAY,
      lastWake: {
        ".": { lastWake: "2026-07-07T10:00:00.000Z", cycle: 3 },
        alpha: { lastWake: "2026-07-06T00:00:00.000Z", cycle: 3 },
        "alpha/w1": { lastWake: "2026-07-07T11:00:00.000Z", cycle: 4 },
      },
    });

    expect(plan.triggers.time).toHaveLength(1);
    expect(plan.triggers.quantity).toHaveLength(1);
    expect(plan.triggers.content).toHaveLength(1);
    expect(plan.triggers.dependency).toHaveLength(1);
    expect(plan.wake[0]).toBe("alpha/w1");
  });

  it("ticks deepest batches first, advances state, delivers outbox, and stays idempotent", async () => {
    const repo = await twoGroupOrg();
    await writeFile(path.join(repo, "alpha", "w1", "BRIEF.md"), memory("2026-07-01"));
    const calls: string[] = [];

    const first = await executeTick(repo, {
      date: TODAY,
      now: "2026-07-07T12:00:00.000Z",
      lint: false,
      tickets: false,
      wakeAgent: async (agentPath) => {
        calls.push(agentPath);
        const inbox = path.join(repo, ...agentPath.split("/"), "inbox");
        if (fs.existsSync(inbox)) {
          for (const name of fs.readdirSync(inbox)) {
            if (!name.startsWith(".")) fs.rmSync(path.join(inbox, name), { force: true });
          }
        }
        if (agentPath === "alpha/w1") {
          await writeFile(path.join(repo, "alpha", "w1", "BRIEF.md"), memory(FUTURE));
        }
        return {
          changed: true,
          severity: agentPath === "alpha/w1" ? "material" : "routine",
          logLine: "stub",
          outbox: agentPath === "alpha/w1"
            ? [
                { id: "to-beta", type: "NOTIFY", to: "beta/b1", subject: "Read", body: "Body", refs: [] },
                { id: "bad", type: "REQUEST", to: "beta/b1", subject: "Bad", body: "Body", refs: [] },
              ]
            : [],
        };
      },
    });

    expect(calls[0]).toBe("alpha/w1");
    expect(first.outboxRejections).toBe(1);
    const firstRows = first.results as Array<{ agent: string; deliveries?: Array<{ relPath: string }> }>;
    expect(firstRows.find((row) => row.agent === "alpha/w1")?.deliveries?.[0]?.relPath).toBe("beta/b1/inbox/to-beta.md");
    const rejectionFeedback = await readFile(path.join(repo, "alpha", "w1", "inbox", "rejected-2026-07-07-1.md"), "utf8");
    expect(rejectionFeedback).toContain("Rejected outbox message:");
    expect(rejectionFeedback).toContain("> type: \"REQUEST\"");
    expect(rejectionFeedback).toContain("consult the OUTBOX RULES in your wake instructions; record unmet needs in your LOG/WATCHLIST instead");
    expect(rejectionFeedback).not.toContain("Review the routing rules before sending another message.");
    expect(await readLastWakeState(repo)).toMatchObject({ "alpha/w1": { cycle: 1, lastSeverity: "material" } });
    fs.rmSync(path.join(repo, "alpha", "w1", "inbox", "rejected-2026-07-07-1.md"), { force: true });

    calls.length = 0;
    const second = await executeTick(repo, {
      date: TODAY,
      lastWake: await readLastWakeState(repo),
      lint: false,
      tickets: false,
      wakeAgent: async (agentPath) => {
        calls.push(agentPath);
        return { changed: false, severity: "routine", logLine: "stub", outbox: [] };
      },
    });
    expect(second.noop).toBe(true);
    expect(calls).toEqual([]);
  });

  it("lints a default tick after a valid request outbox creates a ticket", async () => {
    const repo = await twoGroupOrg();
    await writeFile(path.join(repo, "alpha", "BRIEF.md"), memory(TODAY));

    const result = await executeTick(repo, {
      date: TODAY,
      now: "2026-07-07T12:00:00.000Z",
      maxRounds: 1,
      execFile: async () => ({ stdout: " M alpha/LOG.md\n" }),
      wakeAgent: async (agentPath, context) => {
        await writeFile(path.join(repo, ...agentPath.split("/"), "LOG.md"), memory(FUTURE, `- ${context.date} - cycle ${context.cycle} - handled item - severity:notable\n`));
        return {
          changed: true,
          severity: "notable",
          logLine: "stub",
          outbox: [
            { id: "child-question", type: "REQUEST", to: "alpha/w1", subject: "Question", body: "Body", refs: [] },
          ],
        };
      },
    });

    expect(result).toMatchObject({ noop: false, post: { lint: "passed" } });
    await expect(read({ id: "child-question", to: "alpha/w1" }, { rootDir: repo })).resolves.toMatchObject({
      id: "child-question",
      state: "open",
    });
  });

  it("does not overwrite router-created feedback for outbox violations", async () => {
    const repo = await twoGroupOrg();
    await writeFile(path.join(repo, "alpha", "w1", "BRIEF.md"), memory(TODAY));

    const result = await executeTick(repo, {
      date: TODAY,
      now: "2026-07-07T12:00:00.000Z",
      maxRounds: 1,
      lint: false,
      tickets: false,
      deliverMessage: async (message) => deliver(message, { rootDir: repo, now: TODAY }),
      wakeAgent: async (agentPath) => {
        if (agentPath === "alpha/w1") {
          await writeFile(path.join(repo, "alpha", "w1", "BRIEF.md"), memory(FUTURE));
        }
        return {
          changed: true,
          severity: "routine",
          logLine: "stub",
          outbox: [{ id: "bad", type: "REQUEST", to: "beta/b1", subject: "Bad", body: "Body", refs: [] }],
        };
      },
    });

    expect(result).toMatchObject({ outboxRejections: 1 });
    const feedback = await readFile(path.join(repo, "alpha", "w1", "inbox", "rejected-2026-07-07-1.md"), "utf8");
    expect(feedback).toContain("Rejected message:");
    expect(feedback).toContain("Review the routing rules before sending another message.");
    expect(feedback).not.toContain("Rejected outbox message:");
  });

  it("requires LOG liveness for invoked agents even without ledger deliveries", async () => {
    const repo = await twoGroupOrg();
    await mkdir(path.join(repo, "ingest"), { recursive: true });
    await writeFile(path.join(repo, "ingest", "ledger.jsonl"), "");
    const findings = await lintTree(repo, { today: TODAY, cycle: 11, invokedPaths: ["alpha/w1"] });
    expect(findings).toContainEqual(expect.objectContaining({
      level: "ERROR",
      path: "alpha/w1/LOG.md",
      message: "missing LOG entry mentioning cycle 11",
    }));

    await writeFile(path.join(repo, "alpha", "w1", "BRIEF.md"), memory(TODAY));
    await expect(executeTick(repo, {
      date: TODAY,
      now: "2026-07-07T12:00:00.000Z",
      maxRounds: 1,
      tickets: false,
      execFile: async () => ({ stdout: " M alpha/w1/BRIEF.md\n" }),
      wakeAgent: async (agentPath) => {
        await writeFile(path.join(repo, ...agentPath.split("/"), "BRIEF.md"), memory(FUTURE));
        return { changed: true, severity: "routine", logLine: "stub", outbox: [] };
      },
    })).rejects.toThrow(/missing LOG entry mentioning cycle 1/u);
  });

  it("treats a no-wake tick as a pure no-op (no lint, no side effects)", async () => {
    const repo = await twoGroupOrg();
    // Even with a lint-broken file present, a tick with nothing due must not
    // lint, repair, or fail — `org lint` covers on-demand checks.
    await writeFile(path.join(repo, "BRIEF.md"), "# missing metadata\n");
    const result = await executeTick(repo, { date: TODAY, tickets: false });
    expect(result).toMatchObject({ noop: true, post: { lint: "skipped", repairs: 0, committed: false } });
  });

  it("does not commit or advance state for repeated no-wake ticks with commit", async () => {
    const repo = await twoGroupOrg();
    const execFile = vi.fn(async () => ({ stdout: "" }));
    const before = await readLastWakeState(repo);

    const first = await executeTick(repo, { date: TODAY, tickets: false, commit: true, execFile });
    const afterFirst = await readLastWakeState(repo);
    const second = await executeTick(repo, { date: TODAY, tickets: false, commit: true, execFile });
    const afterSecond = await readLastWakeState(repo);

    expect(first).toMatchObject({ noop: true, post: { repairs: 0, committed: false } });
    expect(second).toMatchObject({ noop: true, post: { repairs: 0, committed: false } });
    expect(afterFirst).toEqual(before);
    expect(afterSecond).toEqual(before);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("fails loudly when git status fails for a reason other than missing git", async () => {
    const repo = await twoGroupOrg();
    await mkdir(path.join(repo, "ingest"), { recursive: true });
    await writeFile(path.join(repo, "ingest", "ledger.jsonl"), "");
    await writeFile(path.join(repo, "alpha", "w1", "BRIEF.md"), memory(TODAY));
    const statusError = Object.assign(new Error("git status unavailable"), { code: "EACCES" });

    await expect(executeTick(repo, {
      date: TODAY,
      now: "2026-07-07T12:00:00.000Z",
      maxRounds: 1,
      tickets: false,
      execFile: async () => {
        throw statusError;
      },
      wakeAgent: async (agentPath, context) => {
        const dir = path.join(repo, ...agentPath.split("/"));
        await writeFile(path.join(dir, "BRIEF.md"), memory(FUTURE));
        await writeFile(path.join(dir, "LOG.md"), memory(FUTURE, `- ${context.date} - cycle ${context.cycle} - handled item - severity:routine\n`));
        return { changed: true, severity: "routine", logLine: "stub", outbox: [] };
      },
    })).rejects.toThrow(/git status unavailable/u);
  });

  it("expires overdue tickets before planning and reports status", async () => {
    const repo = await twoGroupOrg();
    await create({ id: "stale", from: ".", to: "alpha/w1", opened: "2026-07-01", deadline: "2026-07-05", subject: "Old", body: "Body" }, { rootDir: repo });
    const result = await executeTick(repo, {
      date: TODAY,
      now: "2026-07-07T12:00:00.000Z",
      maxRounds: 1,
      lint: false,
      wakeAgent: async () => ({ changed: false, severity: "routine", logLine: "stub", outbox: [] }),
    });
    expect((result.ticketExpiry as { expired: Array<{ id: string }> }).expired[0]?.id).toBe("stale");
    const status = await statusOverview(repo, { date: TODAY });
    expect((status.totals as { agents: number }).agents).toBe(6);
  });
});

describe("org replay", () => {
  it("derives R1 ingest rows, dedupes by id/to/date, and ignores replay rows", async () => {
    const repo = await tmpRepo();
    await mkdir(path.join(repo, "ingest"), { recursive: true });
    await writeFile(path.join(repo, "ingest", "ledger.jsonl"), [
      JSON.stringify({ type: "ingest", at: "2026-07-01T00:00:00.000Z", id: "item-a", date: "2026-07-01", to: "alpha/w1", item: "notice.md", ref: "cache/item-a.txt" }),
      JSON.stringify({ type: "ingest", at: "2026-07-01T00:00:01.000Z", id: "item-a", date: "2026-07-01", to: "alpha/w1", item: "notice.md" }),
      JSON.stringify({ type: "routing-delivery", at: "2026-07-01T00:00:02.000Z", routedTo: "alpha/w1/inbox/notice.md" }),
      JSON.stringify({ type: "ingest", at: "2026-07-01T00:00:03.000Z", id: "replayed", date: "2026-07-01", to: "alpha/w1", item: "old.md", replay: true }),
      JSON.stringify({ type: "ingest", at: "2026-07-01T00:00:04.000Z", id: "already", date: "2026-07-01", to: "alpha/w1", item: "again.md" }),
      JSON.stringify({ type: "ingest", at: "2026-07-01T00:00:05.000Z", id: "already", date: "2026-07-01", to: "alpha/w1", item: "again.md", replay: true }),
      JSON.stringify({ type: "ingest", at: "2026-07-01T00:00:06.000Z", id: "late-original", date: "2026-07-01", to: "alpha/w1", item: "late.md" }),
      JSON.stringify({ type: "ingest", at: "2026-07-03T00:00:00.000Z", id: "late-original", date: "2026-07-03", originalDate: "2026-07-01", to: "alpha/w1", item: "late.md", replay: true }),
      JSON.stringify({ type: "ingest", at: "2026-07-02T00:00:00.000Z", id: "root-item", date: "2026-07-02", to: ".", item: "inbox/root-item.md" }),
      "",
    ].join("\n"));

    const corpus = await deriveReplayCorpus(repo);

    expect(corpus.map((row) => [row.id, row.to, row.inboxRelPath, row.ref ?? null])).toEqual([
      ["item-a", "alpha/w1", "alpha/w1/inbox/notice.md", "cache/item-a.txt"],
      ["root-item", ".", "inbox/root-item.md", null],
    ]);
    expect(windowReplayDays(corpus, { from: "2026-07-01", to: "2026-07-02" }).map((day) => [day.date, day.deliveries.length])).toEqual([
      ["2026-07-01", 1],
      ["2026-07-02", 1],
    ]);
  });

  it("accepts generic ingest and fault ids while escaping fallback filenames", async () => {
    const repo = await tmpRepo();
    await mkdir(path.join(repo, "ingest"), { recursive: true });
    await writeFile(path.join(repo, "ingest", "ledger.jsonl"), `${JSON.stringify({
      type: "ingest",
      at: "2026-07-01T00:00:00.000Z",
      id: "@scope/pkg@1.2.3",
      date: "2026-07-01",
      to: "alpha/w1",
      item: "cache-only",
    })}\n`);

    const corpus = await deriveReplayCorpus(repo);

    expect(corpus).toHaveLength(1);
    expect(corpus[0]?.id).toBe("@scope/pkg@1.2.3");
    expect(corpus[0]?.inboxRelPath).toBe("alpha/w1/inbox/%40scope%2Fpkg%401.2.3.md");
    expect(parseReplayFaults("drop:\"@scope/pkg:1.2.3\";late:\"url:feed/item,one;two\":2")).toEqual([
      { type: "drop", id: "@scope/pkg:1.2.3", spec: "drop:\"@scope/pkg:1.2.3\"" },
      { type: "late", id: "url:feed/item,one;two", days: 2, spec: "late:\"url:feed/item,one;two\":2" },
    ]);
  });

  it("applies drop, duplicate, and late replay faults", () => {
    const result = applyReplayFaults([
      replayDelivery("drop-me", "2026-07-01"),
      replayDelivery("dup-me", "2026-07-01"),
      replayDelivery("late-me", "2026-07-01"),
    ], parseReplayFaults("drop:drop-me;dup:dup-me;late:late-me:2"));

    expect(result.deliveries.map((row) => `${row.id}:${row.deliverDate}:${row.duplicateOf ?? "-"}`)).toEqual([
      "dup-me:2026-07-01:-",
      "dup-me:2026-07-02:dup-me",
      "late-me:2026-07-03:-",
    ]);
    expect(result.faults.map((fault) => [fault.spec, fault.matched, fault.deliveriesAffected])).toEqual([
      ["drop:drop-me", 1, 1],
      ["dup:dup-me", 1, 1],
      ["late:late-me:2", 1, 1],
    ]);
  });

  it("refuses pristine replay unless the current branch is replay-prefixed", async () => {
    const repo = await tmpRepo();
    const execFile = vi.fn(async () => ({ stdout: "main\n" }));

    await expect(runOrgReplay({ root: repo, pristine: true }, { execFile }))
      .rejects.toThrow(/current git branch to start with "replay\/"/u);
    expect(execFile).toHaveBeenCalledWith("git", ["rev-parse", "--abbrev-ref", "HEAD"], expect.objectContaining({ cwd: repo }));
  });

  it("resets pristine memory through scaffold stubs on replay branches", async () => {
    const repo = await tmpRepo();
    await writeFile(path.join(repo, "coverage.toml"), [
      "[groups.alpha]",
      "title = \"Alpha\"",
      "entities = [\"w1\"]",
      "",
    ].join("\n"));
    await initOrg(repo, { date: TODAY });
    await writeFile(path.join(repo, "alpha", "w1", "BRIEF.md"), memory(FUTURE, "Changed memory\n"));
    const execFile = vi.fn(async () => ({ stdout: "replay/test\n" }));

    const summary = await runOrgReplay({ root: repo, from: TODAY, to: TODAY, pristine: true }, { execFile, tickOptions: { lint: false, tickets: false } });

    expect(summary.pristineReset?.resetMemory).toBeGreaterThan(0);
    await expect(readFile(path.join(repo, "alpha", "w1", "BRIEF.md"), "utf8")).resolves.toContain("PLACEHOLDER: This file awaits its first cycle.");
  });

  it("replays rows through tick and stamps replay ledger rows", async () => {
    const repo = await twoGroupOrg();
    await mkdir(path.join(repo, "ingest"), { recursive: true });
    await writeFile(path.join(repo, "ingest", "ledger.jsonl"), `${JSON.stringify({
      type: "ingest",
      at: "2026-07-01T00:00:00.000Z",
      id: "item-a",
      date: TODAY,
      to: "alpha/w1",
      item: "notice.md",
      ref: "cache/item-a.txt",
    })}\n`);
    const calls: string[] = [];

    const summary = await runOrgReplay({ root: repo, from: TODAY, to: TODAY }, {
      tickOptions: {
        lint: false,
        tickets: false,
        wakeAgent: async (agentPath) => {
          calls.push(agentPath);
          const inbox = path.join(repo, ...agentPath.split("/"), "inbox");
          for (const entry of fs.existsSync(inbox) ? fs.readdirSync(inbox) : []) {
            if (!entry.startsWith(".")) fs.rmSync(path.join(inbox, entry), { force: true });
          }
          return { changed: true, severity: "routine", logLine: "stub", outbox: [] };
        },
      },
    });

    expect(summary).toMatchObject({ daysSimulated: 1, cyclesRun: 1, itemsDelivered: 1, inboxItemsDelivered: 1 });
    expect(calls).toContain("alpha/w1");
    const rows = await ledgerRows(repo);
    expect(rows).toContainEqual(expect.objectContaining({
      type: "ingest",
      id: "item-a",
      date: TODAY,
      to: "alpha/w1",
      item: "notice.md",
      ref: "cache/item-a.txt",
      replay: true,
      cycle: 1,
    }));
  });

  it("does not redeliver rows already marked by replay output", async () => {
    const repo = await twoGroupOrg();
    await mkdir(path.join(repo, "ingest"), { recursive: true });
    await writeFile(path.join(repo, "ingest", "ledger.jsonl"), `${JSON.stringify({
      type: "ingest",
      at: "2026-07-01T00:00:00.000Z",
      id: "item-a",
      date: TODAY,
      to: "alpha/w1",
      item: "notice.md",
    })}\n`);

    const tickOptions = {
      lint: false,
      tickets: false,
      wakeAgent: async (agentPath: string) => {
        const inbox = path.join(repo, ...agentPath.split("/"), "inbox");
        for (const entry of fs.existsSync(inbox) ? fs.readdirSync(inbox) : []) {
          if (!entry.startsWith(".")) fs.rmSync(path.join(inbox, entry), { force: true });
        }
        return { changed: true, severity: "routine" as const, logLine: "stub", outbox: [] };
      },
    };

    const first = await runOrgReplay({ root: repo, from: TODAY, to: TODAY }, { tickOptions });
    const second = await runOrgReplay({ root: repo, from: TODAY, to: TODAY }, { tickOptions });

    expect(first.itemsDelivered).toBe(1);
    expect(second.itemsDelivered).toBe(0);
    const replayRows = (await ledgerRows(repo)).filter((row) => row.type === "ingest" && row.id === "item-a" && row.replay === true);
    expect(replayRows).toHaveLength(1);
  });

  it("writes generic replay inbox items", async () => {
    const repo = await tmpRepo();
    const written = await writeReplayDayInboxItems(repo, TODAY, [replayDelivery("item-a", TODAY)]);

    expect(written).toEqual(["alpha/w1/inbox/item-a.md"]);
    await expect(readFile(path.join(repo, "alpha", "w1", "inbox", "item-a.md"), "utf8")).resolves.toContain("type: ingest");
  });
});

function replayDelivery(id: string, date: string): ReplayDelivery {
  return {
    id,
    trueDate: date,
    deliverDate: date,
    to: "alpha/w1",
    item: `${id}.md`,
    ref: `cache/${id}.txt`,
    inboxRelPath: `alpha/w1/inbox/${id}.md`,
    faultNotes: [],
  };
}

describe("org wake and ask", () => {
  it("renders wake args, caps inbox, flags historical items, parses envelopes, and records thread id", async () => {
    const repo = await twoGroupOrg();
    process.env.ORG_WAKE_CAP = "2";
    process.env.ULTRACODEX_BIN = "stub-engine";
    await inboxItem(repo, "alpha/w1", "third.md", "2026-07-03");
    await inboxItem(repo, "alpha/w1", "first.md", "2026-07-01", "2026-06-01");
    await inboxItem(repo, "alpha/w1", "second.md", "2026-07-02");
    let call: { command: string; args: string[]; cwd: string; script: string } | undefined;
    const result = await wakeAgent(path.join(repo, "alpha", "w1"), {
      date: TODAY,
      cycle: 5,
      reason: "test",
      execImpl: async (command, args, options) => {
        call = { command, args, cwd: options.cwd, script: await readFile(args[1]!, "utf8") };
        return {
          stdout: JSON.stringify({
            result: { changed: false, severity: "routine", logLine: "line", outbox: [] },
            journal: [{ t: "agent_thread", threadId: "thread-1" }],
          }),
        };
      },
    });

    expect(result.outbox).toEqual([]);
    expect(call?.command).toBe("stub-engine");
    expect(call?.args.slice(0, 3)).toEqual(["run", call.args[1], "--json"]);
    expect(call?.cwd).toBe(path.join(repo, "alpha", "w1"));
    const wakeJson = JSON.parse(call!.script.match(/const WAKE = (\{[\s\S]*?\})\n\nconst WAKE_SCHEMA/u)![1]!);
    expect(wakeJson.inbox.items).toEqual(["first.md", "second.md"]);
    expect(wakeJson.inbox.backlog).toBe(1);
    expect(wakeJson.inbox.historical).toEqual(["first.md"]);
    expect(await readFile(path.join(repo, "alpha", "w1", ".thread"), "utf8")).toBe("thread-1\n");
  });

  it("uses the package CLI by default and rejects malformed engine output", async () => {
    const repo = await twoGroupOrg();
    let command = "";
    let args: string[] = [];
    await expect(wakeAgent(path.join(repo, "alpha", "w1"), {
      date: TODAY,
      cycle: 1,
      execImpl: async (cmd, argv) => {
        command = cmd;
        args = argv;
        return { stdout: "{bad" };
      },
    })).rejects.toThrow(/malformed JSON/);
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/cli\.js$/u);
  });

  it("generates ask scripts and appends QA logs", async () => {
    const repo = await twoGroupOrg();
    const script = renderAskScript({ question: "What changed?", role: "entity", agentPath: "alpha/w1", agentLabel: "w1" });
    expect(script).toContain("agentType: 'Explore'");
    expect(script).toContain("Do not edit, create, delete, or move files");
    const result = await askAgent(path.join(repo, "alpha", "w1"), "What changed?", {
      now: "2026-07-07T12:00:00.000Z",
      execImpl: async () => ({ stdout: JSON.stringify({ result: { answer: "No change.", sources: ["BRIEF.md"] } }) }),
    });
    expect(result.answer).toBe("No change.");
    expect(await readFile(path.join(repo, "alpha", "w1", "QA.log.md"), "utf8")).toContain("- BRIEF.md");
    await expect(renderWakeScript("entity", {
      date: TODAY,
      cycle: 1,
      reason: "test",
      role: "entity",
      agentPath: "alpha/w1",
      agentLabel: "w1",
      inbox: { items: [], backlog: 0, historical: [] },
    })).resolves.toContain("WAKE_SCHEMA");
    await expect(renderWakeScript("group", {
      date: TODAY,
      cycle: 1,
      reason: "test",
      role: "group",
      agentPath: "alpha",
      agentLabel: "alpha",
      inbox: { items: ["old.md"], backlog: 1, historical: ["old.md"] },
    })).resolves.toContain("Historical backfill items");
    await expect(renderWakeScript("root", {
      date: TODAY,
      cycle: 1,
      reason: "test",
      role: "root",
      agentPath: ".",
      agentLabel: "root",
      inbox: { items: ["old.md"], backlog: 1, historical: ["old.md"] },
    })).resolves.toContain("Historical backfill items");
  });

  it("requires a LOG entry in every wake prompt, including null entries", async () => {
    const wakeArgs = {
      date: TODAY,
      cycle: 1,
      reason: "test",
      inbox: { items: [], backlog: 0, historical: [] },
    };
    const mandate = "Append a LOG entry for every wake. If nothing changed, append a null LOG entry for this cycle with severity:routine.";

    await expect(renderWakeScript("root", {
      ...wakeArgs,
      role: "root",
      agentPath: ".",
      agentLabel: "root",
    })).resolves.toContain(mandate);
    await expect(renderWakeScript("group", {
      ...wakeArgs,
      role: "group",
      agentPath: "alpha",
      agentLabel: "alpha",
    })).resolves.toContain(mandate);
    await expect(renderWakeScript("entity", {
      ...wakeArgs,
      role: "entity",
      agentPath: "alpha/w1",
      agentLabel: "w1",
    })).resolves.toContain(mandate);
  });
});

describe("org lint repair workflow", () => {
  it("runs two bounded rounds and narrows the second round to remaining offenders", async () => {
    const source = await readFile(path.join(PROJECT_ROOT, "workflows", "org-lint-repair.js"), "utf8");
    expect(validateWorkflowScript(source, { strict: true })).toEqual([]);

    const calls: Array<{ label: string; prompt: string }> = [];
    const loaded = loadScript(source, { strict: true });
    const result = await loaded.body(workflowGlobals({
      args: {
        date: TODAY,
        cycle: 9,
        findings: [
          { agent: "alpha", file: "alpha/BRIEF.md", line: 12, message: "missing source" },
          { agent: "beta/widgets", file: "beta/widgets/LOG.md", line: 4, message: "missing cycle entry" },
        ],
      },
      phase: () => {},
      log: () => {},
      agent: async (prompt, opts) => {
        const label = String(opts?.label ?? "");
        calls.push({ label, prompt });
        if (label === "org-lint-repair:alpha:r1") return { fixed: ["alpha/BRIEF.md"], remaining: ["alpha follow-up"] };
        if (label === "org-lint-repair:beta/widgets:r1") return { fixed: ["beta/widgets/LOG.md"], remaining: [] };
        if (label === "org-lint-repair:alpha:r2") return { fixed: ["alpha follow-up"], remaining: [] };
        throw new Error(`unexpected repair call ${label}`);
      },
    }));

    expect((result as { rounds: number }).rounds).toBe(2);
    expect(calls.map((call) => call.label)).toEqual([
      "org-lint-repair:alpha:r1",
      "org-lint-repair:beta/widgets:r1",
      "org-lint-repair:alpha:r2",
    ]);
    expect(calls[2]?.prompt).toContain("- alpha follow-up");
    expect(calls[2]?.prompt).not.toContain("beta/widgets/LOG.md");
  });
});

describe("org audit", () => {
  const AUDIT_RESULT = {
    accuracy: 0.5,
    tally: { verified: 1, unsupported: 1, contradicted: 0, uncheckable: 0 },
    sampled: 2,
    done: false,
    findings: [
      {
        agent: "alpha/w1",
        file: "alpha/w1/THESIS.md",
        line: 8,
        claim: "- supported claim [source:alpha/w1/FACTS/source.txt]",
        verdict: "verified",
        note: "matched source",
      },
      {
        agent: "beta/b1",
        file: "beta/b1/BRIEF.md",
        line: 12,
        claim: "- unsupported claim [source:beta/b1/FACTS/source.txt]",
        verdict: "unsupported",
        note: "source did not contain claim",
      },
    ],
  };

  it("appends audit history idempotently by date, sampled count, and accuracy", async () => {
    const repo = await twoGroupOrg();
    const execFile = vi.fn(async () => ({ stdout: JSON.stringify({ ...AUDIT_RESULT, findings: [] }) }));

    await runOrgAudit({ root: repo, sample: 2, date: TODAY }, { execFile });
    await runOrgAudit({ root: repo, sample: 2, date: TODAY }, { execFile });

    const history = await readFile(path.join(repo, ".ultracodex", "org", "state", "audit-history.jsonl"), "utf8");
    const rows = history.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toEqual([
      {
        date: TODAY,
        accuracy: 0.5,
        tally: { verified: 1, unsupported: 1, contradicted: 0, uncheckable: 0 },
        sampled: 2,
      },
    ]);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("delivers every audit finding as an audit notify to the owning agent", async () => {
    const repo = await twoGroupOrg();
    const execFile = vi.fn(async () => ({ stdout: JSON.stringify(AUDIT_RESULT) }));

    const summary = await runOrgAudit({ root: repo, sample: 2, date: TODAY }, { execFile });

    expect(summary.notifications).toBe(2);
    const first = await readFile(path.join(repo, "alpha", "w1", "inbox", `audit-${TODAY}-1.md`), "utf8");
    expect(first).toContain("from: \"audit\"");
    expect(first).toContain("Verdict: verified");
    const second = await readFile(path.join(repo, "beta", "b1", "inbox", `audit-${TODAY}-2.md`), "utf8");
    expect(second).toContain("Verdict: unsupported");
    expect((await ledgerRows(repo)).filter((row) => row.type === "routing-delivery" && row.from === "audit")).toHaveLength(2);
  });

  it("passes sample args to the packaged builtin path through the CLI runner", async () => {
    const repo = await twoGroupOrg();
    const shadowDir = path.join(repo, ".ultracodex", "workflows");
    await mkdir(shadowDir, { recursive: true });
    await writeFile(
      path.join(shadowDir, "org-audit.js"),
      "export const meta = { name: 'org-audit', description: 'shadow' }\nreturn { accuracy: 1, tally: {}, findings: [], sampled: 0, done: true }\n",
      "utf8",
    );
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const execFile = vi.fn(async (command: string, args: string[], options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: JSON.stringify({ accuracy: 1, tally: { verified: 0, unsupported: 0, contradicted: 0, uncheckable: 0 }, sampled: 0, findings: [], done: true }) };
    });

    await runOrgAudit({ root: repo, sample: 7, date: TODAY }, { execFile });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args[0]).toMatch(/cli\.js$/u);
    expect(calls[0]?.args.slice(1)).toEqual([
      "run",
      path.join(PROJECT_ROOT, "workflows", "org-audit.js"),
      "--args",
      JSON.stringify({ sample: 7 }),
      "--json",
    ]);
    expect(calls[0]?.cwd).toBe(repo);
  });

  it("derives accuracy and done from the normalized tally", async () => {
    const repo = await twoGroupOrg();
    const execFile = vi.fn(async () => ({
      stdout: JSON.stringify({
        accuracy: 1,
        tally: { verified: 1, unsupported: 1, contradicted: 0, uncheckable: 0 },
        sampled: 2,
        findings: [],
        done: true,
      }),
    }));

    const summary = await runOrgAudit({ root: repo, sample: 2, date: TODAY }, { execFile });

    expect(summary.accuracy).toBe(0.5);
    expect(summary.done).toBe(false);
    const history = await readFile(path.join(repo, ".ultracodex", "org", "state", "audit-history.jsonl"), "utf8");
    expect(JSON.parse(history.trim()) as Record<string, unknown>).toMatchObject({ accuracy: 0.5, sampled: 2 });
  });

  it("audits only sources cited in the claim text", async () => {
    const source = await readFile(path.join(PROJECT_ROOT, "workflows", "org-audit.js"), "utf8");
    expect(validateWorkflowScript(source, { strict: true })).toEqual([]);
    const prompts: string[] = [];
    const loaded = loadScript(source, { strict: true });

    const result = await loaded.body(workflowGlobals({
      args: { sample: 1 },
      agent: async (prompt, opts) => {
        const label = String(opts?.label ?? "");
        prompts.push(prompt);
        if (label === "audit:collect") {
          return {
            claims: [{
              agent: "alpha/w1",
              file: "alpha/w1/THESIS.md",
              line: 4,
              claim: "- Throughput rose 12%",
              sources: ["alpha/w1/FACTS/source.txt"],
            }],
          };
        }
        return { verdict: "uncheckable", note: "no cited source" };
      },
    }));

    const auditPrompt = prompts.find((prompt) => prompt.includes("Cited source payloads:")) ?? "";
    expect(auditPrompt).toContain("Cited source payloads:\n(none)");
    expect(auditPrompt).not.toContain("alpha/w1/FACTS/source.txt");
    expect((result as { tally: { uncheckable: number } }).tally.uncheckable).toBe(1);
  });
});

describe("org scaffold and lint", () => {
  it("initializes canonical coverage, refuses reserved names, and preserves memory files", async () => {
    const repo = await tmpRepo();
    await writeFile(path.join(repo, "coverage.toml"), [
      "[groups.alpha]",
      "title = \"Alpha\"",
      "entities = [\"w1\", \"w2\"]",
      "",
    ].join("\n"));
    const report = await initOrg(repo, { date: TODAY });
    expect(report.created).toBeGreaterThan(0);
    expect(await lintTree(repo, { today: TODAY })).toEqual([]);
    const before = await readFile(path.join(repo, "alpha", "w1", "BRIEF.md"), "utf8");
    await scaffold(repo, TODAY);
    expect(await readFile(path.join(repo, "alpha", "w1", "BRIEF.md"), "utf8")).toBe(before);
    expect(() => parseCoverage("[groups.ingest]\ntitle = \"Bad\"\nentities = [\"x\"]\n")).toThrow(/reserved/);
    for (const name of ["ops", "runtime", "workflows", "audit", "user"]) {
      expect(() => parseCoverage(`[groups.${name}]\ntitle = "Bad"\nentities = ["x"]\n`)).toThrow(/reserved/);
    }
    expect(() => parseCoverage("[groups.alpha]\ntitle = \"Bad\"\nentities = [\"not/slug\"]\n")).toThrow(/unsafe/);
  });

  it("reports each lint check class", async () => {
    const repo = await twoGroupOrg();
    await writeFile(path.join(repo, "coverage.toml"), "[groups.alpha]\ntitle = \"Alpha\"\nentities = [\"w1\"]\n");
    await rm(path.join(repo, "alpha", "w1", "LOG.md"));
    await writeFile(path.join(repo, "BRIEF.md"), "# no frontmatter\n");
    await writeFile(path.join(repo, "alpha", "BRIEF.md"), memory(FUTURE).replace("confidence: possible", "confidence: certain"));
    await writeFile(path.join(repo, "alpha", "w1", "BRIEF.md"), memory(FUTURE, Array.from({ length: 81 }, (_, i) => `line ${i}`).join("\n")));
    await writeFile(path.join(repo, "alpha", "w1", "WATCHLIST.md"), memory(FUTURE, "- Undated item\n- Old item 2020-01-01\n"));
    await writeFile(path.join(repo, "alpha", "w1", "THESIS.md"), memory(FUTURE, "- Bare claim\n"));
    await mkdir(path.join(repo, "ingest"), { recursive: true });
    await writeFile(path.join(repo, "ingest", "ledger.jsonl"), `${JSON.stringify({ cycle: 8, routedTo: "alpha/w1/inbox/item.md" })}\n`);

    const findings = await lintTree(repo, {
      today: TODAY,
      cycle: 8,
      diffPaths: ["alpha/BRIEF.md", "README.md", ".ultracodex/org/state/last-wake.json"],
      invokedPaths: ["alpha/w1"],
    });
    const messages = findings.map((finding) => `${finding.level} ${finding.path} ${finding.message}`);
    expect(messages.some((line) => line.includes("alpha/w1/LOG.md missing required file"))).toBe(true);
    expect(messages.some((line) => line.includes("BRIEF.md missing frontmatter"))).toBe(true);
    expect(messages.some((line) => line.includes("confidence"))).toBe(true);
    expect(messages.some((line) => line.includes("max is 80"))).toBe(true);
    expect(messages.some((line) => line.includes("no valid YYYY-MM-DD date"))).toBe(true);
    expect(messages.some((line) => line.includes("expired on 2020-01-01"))).toBe(true);
    expect(messages.some((line) => line.includes("has no provenance ref"))).toBe(true);
    expect(messages.some((line) => line.includes("missing LOG entry mentioning cycle 8"))).toBe(true);
    expect(messages.some((line) => line.includes("belongs to alpha but --invoked did not include it"))).toBe(true);
    expect(messages.some((line) => line.includes("outside an invoked agent directory"))).toBe(true);
  });

  it("accepts allowed severity markers in memory bodies", async () => {
    const repo = await twoGroupOrg();
    await writeFile(path.join(repo, "alpha", "w1", "LOG.md"), memory(FUTURE, [
      "- 2026-07-07 - cycle 1 - routine note - severity:routine",
      "- 2026-07-07 - cycle 2 - notable note - severity = notable",
      "- 2026-07-07 - cycle 3 - material note - severity:material",
      "- 2026-07-07 - cycle 4 - urgent note - severity:urgent",
      "",
    ].join("\n")));

    expect(await lintTree(repo, { today: TODAY })).toEqual([]);
  });

  it("reports unsupported severity markers in memory bodies", async () => {
    const repo = await twoGroupOrg();
    await writeFile(path.join(repo, "alpha", "w1", "LOG.md"), memory(FUTURE, "- 2026-07-07 - cycle 1 - note - severity:critical\n"));

    const findings = await lintTree(repo, { today: TODAY });

    expect(findings).toContainEqual(expect.objectContaining({
      level: "ERROR",
      path: "alpha/w1/LOG.md",
      line: 8,
      message: "severity marker \"critical\" is not in contract vocabulary",
    }));
  });
});
