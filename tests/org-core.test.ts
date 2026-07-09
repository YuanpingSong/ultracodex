import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askAgent, renderAskScript } from "../src/org/ask.js";
import { lintTree } from "../src/org/lint.js";
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
