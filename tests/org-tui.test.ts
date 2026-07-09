import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildOrgTreeRows,
  defaultOrgExpanded,
  defaultOrgSelectedPath,
  formatOrgBriefBodyLines,
  formatOrgBriefQueueRow,
  formatOrgBriefStatusLine,
  formatOrgAttentionRow,
  formatOrgDetailLines,
  formatOrgMovedRow,
  formatOrgOpsFooterLine,
  formatOrgOpsHeaderLine,
  formatOrgTreeDisplayRow,
  formatOrgTreeHeaderLine,
  formatOrgTreeRow,
  nextOrgSubview,
} from "../src/tui/org.js";
import { isOrgProject, loadOrgSnapshot, orgSourceFingerprint } from "../src/tui/orgFiles.js";

const dirs: string[] = [];
const TODAY = "2026-07-08";
const FUTURE = "2099-01-01";
const BRIEF_MTIME = new Date("2026-07-08T18:00:00.000Z");

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmpRepo(prefix = "org-tui-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("org TUI detection", () => {
  it("requires both coverage.toml and root AGENTS.md", async () => {
    const repo = await tmpRepo();
    expect(isOrgProject(repo)).toBe(false);

    await writeFile(path.join(repo, "coverage.toml"), "[groups.widgets]\ntitle = \"Widgets\"\nentities = []\n");
    expect(isOrgProject(repo)).toBe(false);

    await writeFile(path.join(repo, "AGENTS.md"), "# root\n");
    expect(isOrgProject(repo)).toBe(true);
  });
});

describe("org TUI fingerprint", () => {
  it("ignores unrelated project files and nested inbox contents", async () => {
    const repo = await fixtureRepo();
    const nestedInboxDir = path.join(repo, "widgets", "wproc", "inbox", "nested");
    await mkdir(nestedInboxDir, { recursive: true });
    await writeFile(path.join(nestedInboxDir, "ignored.txt"), "before\n");

    const before = orgSourceFingerprint(repo);
    await mkdir(path.join(repo, "scratch", "deep"), { recursive: true });
    await writeFile(path.join(repo, "scratch", "deep", "noise.txt"), "not org state\n");
    await writeFile(path.join(nestedInboxDir, "ignored.txt"), "after\n");
    const nestedTime = new Date("2030-01-01T00:00:00.000Z");
    await utimes(path.join(nestedInboxDir, "ignored.txt"), nestedTime, nestedTime);

    expect(orgSourceFingerprint(repo)).toBe(before);

    const brief = path.join(repo, "widgets", "wproc", "BRIEF.md");
    await writeFile(brief, memory(FUTURE, "# Widget Processor\n\nchanged\n"));
    const briefTime = new Date("2030-01-02T00:00:00.000Z");
    await utimes(brief, briefTime, briefTime);

    expect(orgSourceFingerprint(repo)).not.toBe(before);
  });

  it("tracks direct inbox child stats", async () => {
    const repo = await fixtureRepo();
    const before = orgSourceFingerprint(repo);
    const inboxItem = path.join(repo, "widgets", "wproc", "inbox", "old.md");
    const itemTime = new Date("2030-01-03T00:00:00.000Z");
    await utimes(inboxItem, itemTime, itemTime);

    expect(orgSourceFingerprint(repo)).not.toBe(before);
  });
});

describe("org TUI folds", () => {
  it("builds a snapshot with severity, unread, inbox, tickets, reviews, movement, attention, and audit trend", async () => {
    const repo = await fixtureRepo();
    const { snapshot } = loadOrgSnapshot(repo, "2026-07-08T19:00:00.000Z");
    const wproc = snapshot.agents.find((agent) => agent.path === "widgets/wproc");
    const tlint = snapshot.agents.find((agent) => agent.path === "tools/tlint");

    expect(wproc).toMatchObject({
      role: "entity",
      depth: 2,
      severity: "material",
      inboxCount: 2,
      oldestInbox: "2026-07-01",
      nearestDeadline: "2026-07-10",
      nextReview: "2026-07-06",
      unread: true,
    });
    expect(wproc?.brief.positionExcerpt).toContain("Widget processor demand");
    expect(wproc?.openTickets.map((ticket) => ticket.subject)).toEqual(["Resolve widget drift"]);
    expect(tlint).toMatchObject({ severity: "urgent", unread: false });

    expect(snapshot.tickInfo.totals).toMatchObject({ seats: 5, inbox: 2, openTickets: 2, severity: "urgent" });
    expect(snapshot.tickInfo.whatMoved.map((row) => [row.seat, row.severity])).toEqual([
      ["tools/tlint", "urgent"],
      ["widgets/wproc", "material"],
    ]);
    expect(snapshot.tickInfo.whatMoved[0]?.text).toContain("lint queue blocked");
    expect(snapshot.tickInfo.auditSparkline).toBe("▁▅█");
    expect(snapshot.tickInfo.routingViolationCount).toBe(1);
    expect(snapshot.unreadBriefs.map((row) => row.path)).toEqual(["widgets/wproc"]);

    const attention = snapshot.tickInfo.attentionRows.map((row) => `${row.kind}:${row.seat}:${row.text}`);
    expect(attention).toContain("overdue:tools/tlint:2026-07-05 - Fix tool lint");
    expect(attention).toContain("ticket:widgets/wproc:2026-07-10 - Resolve widget drift");
    expect(attention).toContain("review:widgets/wproc:2026-07-06 - widgets/wproc/BRIEF.md");
    expect(attention).toContain("inbox:widgets/wproc:2 waiting - oldest 07-01");
  });

  it("formats tree, detail, moved, and attention rows", async () => {
    const repo = await fixtureRepo();
    const { snapshot } = loadOrgSnapshot(repo, "2026-07-08T19:00:00.000Z");

    expect(formatOrgTreeRow(snapshot, "widgets/wproc", { selected: true })).toBe(
      "❯     wproc inbox 2 ● 18:31 material",
    );

    const detail = formatOrgDetailLines(snapshot, "widgets/wproc", { briefLines: 2 }).join("\n");
    expect(detail).toContain("widgets/wproc entity");
    expect(detail).toContain("last wake 18:31 material c5 (2m 6.7k)");
    expect(detail).toContain("inbox 2 oldest 07-01");
    expect(detail).toContain("tickets 1 open due 07-10");
    expect(detail).toContain("next_review 2026-07-06");
    expect(detail).toContain("BRIEF 2026-07-08 likely");

    expect(formatOrgMovedRow(snapshot.tickInfo.whatMoved[0]!)).toContain("tools/tlint");
    expect(formatOrgMovedRow(snapshot.tickInfo.whatMoved[0]!)).toContain("urgent");
    expect(formatOrgAttentionRow(snapshot.tickInfo.attentionRows[0]!)).toContain("Fix tool lint");
  });

  it("formats rows for the tree, ops, and briefs sub-views", async () => {
    const repo = await fixtureRepo();
    const { snapshot } = loadOrgSnapshot(repo, "2026-07-08T19:00:00.000Z");
    const expanded = defaultOrgExpanded(snapshot);
    const rows = buildOrgTreeRows(snapshot, expanded);
    const wprocRow = rows.find((row) => row.path === "widgets/wproc");

    expect(nextOrgSubview("tree")).toBe("ops");
    expect(formatOrgTreeHeaderLine(snapshot)).toContain("Org ·");
    expect(defaultOrgSelectedPath(snapshot, "widgets/wproc", rows)).toBe("widgets/wproc");
    expect(wprocRow).toBeTruthy();
    expect(formatOrgTreeDisplayRow(snapshot, wprocRow!, { selected: true })).toContain("wproc inbox 2 ● 18:31 material");

    expect(formatOrgOpsHeaderLine(snapshot)).toContain("seats 5 · inbox 2 · tickets 2 · audit 100% Δ+5pp");
    expect(formatOrgOpsFooterLine(snapshot)).toBe("audit trend ▁▅█ · routing violations 1");

    expect(formatOrgBriefBodyLines(snapshot, "widgets/wproc", { maxLines: 1 })).toEqual(["# Widget Processor"]);
    expect(formatOrgBriefQueueRow(snapshot.unreadBriefs[0]!, { selected: true })).toContain("widgets/wproc");
    expect(formatOrgBriefStatusLine(snapshot, "widgets/wproc")).toContain("widgets/wproc/BRIEF.md · unread 1");
  });
});

async function fixtureRepo(): Promise<string> {
  const repo = await tmpRepo();
  await writeFile(path.join(repo, "coverage.toml"), [
    "[groups.widgets]",
    "title = \"Widgets\"",
    "entities = [\"wproc\"]",
    "",
    "[groups.tools]",
    "title = \"Tools\"",
    "entities = [\"tlint\"]",
    "",
  ].join("\n"));

  await rootAgent(repo);
  await groupAgent(repo, "widgets");
  await entityAgent(repo, "widgets", "wproc", {
    briefReview: "2026-07-06",
    briefBody: [
      "# Widget Processor",
      "",
      "## Position",
      "- likely: Widget processor demand needs follow-up. severity:material",
      "",
      "## Notes",
      "- backlog needs owner review.",
    ].join("\n"),
    logBody: [
      "- 2026-07-08 - cycle 4 - baseline widget check - severity:routine",
      "- 2026-07-08 - cycle 5 - widget drift changed plan - severity:material",
    ].join("\n"),
  });
  await groupAgent(repo, "tools");
  await entityAgent(repo, "tools", "tlint", {
    logBody: "- 2026-07-08 - cycle 5 - lint queue blocked - severity:urgent\n",
  });

  await writeInbox(repo, "widgets/wproc", "old.md", "2026-07-01", "2026-06-30");
  await writeInbox(repo, "widgets/wproc", "new.md", "2026-07-07");
  await writeTicket(repo, "widgets/wproc", {
    id: "widget-drift",
    deadline: "2026-07-10",
    state: "open",
    subject: "Resolve widget drift",
  });
  await writeTicket(repo, "widgets/wproc", {
    id: "closed-widget",
    deadline: "2026-07-09",
    state: "done",
    subject: "Closed widget item",
  });
  await writeTicket(repo, "tools/tlint", {
    id: "tool-lint",
    deadline: "2026-07-05",
    state: "open",
    subject: "Fix tool lint",
  });

  await mkdir(path.join(repo, ".ultracodex", "org", "state"), { recursive: true });
  await writeFile(path.join(repo, ".ultracodex", "org", "state", "last-wake.json"), `${JSON.stringify({
    ".": { lastWake: "2026-07-08T18:10:00.000Z", cycle: 4, lastSeverity: "routine" },
    widgets: { lastWake: "2026-07-08T18:20:00.000Z", cycle: 4, lastSeverity: "routine" },
    "widgets/wproc": {
      lastWake: "2026-07-08T18:31:00.000Z",
      cycle: 5,
      lastSeverity: "material",
      durationMs: 120000,
      tokens: 6700,
    },
    tools: { lastWake: "2026-07-08T18:21:00.000Z", cycle: 4, lastSeverity: "routine" },
    "tools/tlint": { lastWake: "2026-07-08T18:35:00.000Z", cycle: 5, lastSeverity: "urgent" },
  }, null, 2)}\n`);
  await writeFile(path.join(repo, ".ultracodex", "org", "state", "audit-history.jsonl"), [
    JSON.stringify({ date: "2026-07-01", accuracy: 0.9, tally: { verified: 9, unsupported: 1 }, sampled: 10 }),
    JSON.stringify({ date: "2026-07-04", accuracy: 0.95, tally: { verified: 19, unsupported: 1 }, sampled: 20 }),
    JSON.stringify({ date: "2026-07-08", accuracy: 1, tally: { verified: 20, unsupported: 0 }, sampled: 20 }),
    "",
  ].join("\n"));
  await writeFile(path.join(repo, ".ultracodex", "org", "state", "briefs-read.json"), `${JSON.stringify({
    version: 1,
    visits: {
      ".": "2026-07-08T20:00:00.000Z",
      widgets: "2026-07-08T20:00:00.000Z",
      "widgets/wproc": "2026-07-08T17:00:00.000Z",
      tools: "2026-07-08T20:00:00.000Z",
      "tools/tlint": "2026-07-08T20:00:00.000Z",
    },
  }, null, 2)}\n`);
  await mkdir(path.join(repo, "ingest"), { recursive: true });
  await writeFile(path.join(repo, "ingest", "ledger.jsonl"), [
    JSON.stringify({ type: "routing-violation", at: "2026-07-08T18:00:00.000Z", from: "widgets/wproc", to: "widgets" }),
    JSON.stringify({ type: "routing-delivery", at: "2026-07-08T18:05:00.000Z", from: "tools/tlint", to: "tools" }),
    "",
  ].join("\n"));

  return repo;
}

async function rootAgent(repo: string): Promise<void> {
  await agent(repo, ".", {
    briefBody: "# Root\n\n## Position\n- routine baseline.",
    logBody: "- 2026-07-08 - cycle 4 - root quiet - severity:routine\n",
  });
}

async function groupAgent(repo: string, group: string): Promise<void> {
  await agent(repo, group, {
    extraFiles: ["THESIS.md"],
    briefBody: `# ${group}\n\n## Position\n- routine group baseline.`,
    logBody: `- 2026-07-08 - cycle 4 - ${group} quiet - severity:routine\n`,
  });
}

async function entityAgent(
  repo: string,
  group: string,
  entity: string,
  options: { briefReview?: string; briefBody?: string; logBody?: string } = {},
): Promise<void> {
  await agent(repo, `${group}/${entity}`, {
    briefReview: options.briefReview,
    briefBody: options.briefBody ?? `# ${entity}\n\n## Position\n- routine entity baseline.`,
    logBody: options.logBody ?? `- 2026-07-08 - cycle 4 - ${entity} quiet - severity:routine\n`,
    extraFiles: ["IDENTITY.md", "THESIS.md", "WATCHLIST.md"],
  });
  await mkdir(path.join(repo, group, entity, "FACTS"), { recursive: true });
}

async function agent(
  repo: string,
  relPath: string,
  options: { briefReview?: string; briefBody: string; logBody: string; extraFiles?: string[] },
): Promise<void> {
  const dir = relPath === "." ? repo : path.join(repo, ...relPath.split("/"));
  await mkdir(path.join(dir, "inbox"), { recursive: true });
  await mkdir(path.join(dir, "tickets"), { recursive: true });
  await writeFile(path.join(dir, "AGENTS.md"), `# ${relPath}\n`);
  await writeFile(path.join(dir, "BRIEF.md"), memory(options.briefReview ?? FUTURE, options.briefBody));
  await writeFile(path.join(dir, "LOG.md"), memory(FUTURE, options.logBody));
  for (const file of options.extraFiles ?? []) {
    await writeFile(path.join(dir, file), memory(FUTURE, `# ${file}\n`));
  }
  await utimes(path.join(dir, "BRIEF.md"), BRIEF_MTIME, BRIEF_MTIME);
}

function memory(nextReview: string, body: string): string {
  return [
    "---",
    `updated: ${TODAY}`,
    "sources: []",
    "confidence: likely",
    `next_review: ${nextReview}`,
    "---",
    "",
    body.replace(/\s*$/u, ""),
    "",
  ].join("\n");
}

async function writeInbox(repo: string, agentPath: string, filename: string, received: string, documentDate?: string): Promise<void> {
  const dir = path.join(repo, ...agentPath.split("/"), "inbox");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), [
    "---",
    `id: ${filename.replace(/\.md$/u, "")}`,
    "type: notify",
    "from: ops",
    `received: ${received}`,
    "refs: []",
    "---",
    "",
    documentDate ? `Document date: ${documentDate}` : `Event date: ${received}`,
    "",
  ].join("\n"));
}

async function writeTicket(
  repo: string,
  agentPath: string,
  ticket: { id: string; deadline: string; state: string; subject: string },
): Promise<void> {
  const dir = path.join(repo, ...agentPath.split("/"), "tickets");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${ticket.id}.md`), [
    "---",
    `id: ${ticket.id}`,
    "from: .",
    `to: ${agentPath}`,
    `opened: ${TODAY}`,
    `deadline: ${ticket.deadline}`,
    `state: ${ticket.state}`,
    `subject: ${ticket.subject}`,
    "---",
    "",
    "Body.",
    "",
  ].join("\n"));
}
