import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runnerMain } from "../src/runner.js";
import { readJournal } from "../src/journal.js";
import { createRunDir } from "../src/rundir.js";
import { newRunId } from "../src/ids.js";
import { fakeCodexPath } from "./helpers.js";
import type {
  AgentEndEvent,
  AgentStartEvent,
  ControlCommand,
  RunEndEvent,
  RunOptions,
  RunStartEvent,
} from "../src/types.js";

const dirs: string[] = [];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function setupRun(
  script: string,
  opts?: {
    argsJson?: unknown;
    budgetTotal?: number | null;
    control?: ControlCommand[];
    strict?: boolean;
    concurrency?: number;
  },
): { projectDir: string; runDir: string; runId: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-runner-"));
  dirs.push(projectDir);
  fs.mkdirSync(path.join(projectDir, ".ultracodex"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".ultracodex", "config.toml"),
    `[route]\n"*" = "codex"\n\n[backends.codex]\nbinary = ${JSON.stringify(fakeCodexPath())}\n`,
  );
  const runId = newRunId();
  const runDir = createRunDir(projectDir, runId);
  fs.writeFileSync(path.join(runDir, "script.js"), script, "utf8");
  let argsPath: string | null = null;
  if (opts?.argsJson !== undefined) {
    fs.writeFileSync(path.join(runDir, "args.json"), JSON.stringify(opts.argsJson), "utf8");
    argsPath = "args.json";
  }
  const options: RunOptions = {
    runId,
    runDir,
    scriptPath: path.join(runDir, "script.js"),
    argsPath,
    budgetTotal: opts?.budgetTotal ?? null,
    concurrency: opts?.concurrency ?? 2,
    strict: opts?.strict ?? false,
    projectDir,
  };
  fs.writeFileSync(path.join(runDir, "options.json"), JSON.stringify(options), "utf8");
  if (opts?.control) {
    fs.writeFileSync(
      path.join(runDir, "control.jsonl"),
      opts.control.map((c) => JSON.stringify(c)).join("\n") + "\n",
    );
  }
  return { projectDir, runDir, runId };
}

function builtinScript(name: string): string {
  return fs.readFileSync(path.join(repoRoot, "workflows", `${name}.js`), "utf8");
}

async function withScriptedReplies<T>(replies: unknown[], fn: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-replies-"));
  dirs.push(dir);
  const file = path.join(dir, "replies.json");
  fs.writeFileSync(file, JSON.stringify({ index: 0, replies }), "utf8");
  const prev = process.env.FAKE_CODEX_REPLY_FILE;
  process.env.FAKE_CODEX_REPLY_FILE = file;
  try {
    const result = await fn();
    expect(JSON.parse(fs.readFileSync(file, "utf8")).index).toBe(replies.length);
    return result;
  } finally {
    if (prev === undefined) delete process.env.FAKE_CODEX_REPLY_FILE;
    else process.env.FAKE_CODEX_REPLY_FILE = prev;
  }
}

function lastEvent(runDir: string): RunEndEvent {
  const events = readJournal(runDir);
  const last = events.at(-1)!;
  expect(last.t).toBe("run_end");
  return last as RunEndEvent;
}

describe("runnerMain end-to-end", () => {
  it("runs a script against the fake codex: journal, result.json, pid cleanup", async () => {
    const script = `export const meta = { name: 'e2e', description: 'end to end demo' }
phase('Work')
const hi = await agent('please greet [[reply:hi]]', { label: 'greeter' })
log('got ' + hi)
return { greeting: hi }
`;
    const { runDir, runId } = setupRun(script);
    await runnerMain(runDir);

    const events = readJournal(runDir);
    expect(events[0]!.t).toBe("run_start");
    const start = events[0] as RunStartEvent;
    expect(start.runId).toBe(runId);
    expect(start.meta).toEqual({ name: "e2e", description: "end to end demo" });
    expect(start.scriptSha).toMatch(/^[0-9a-f]{64}$/);
    expect(start.argsRef).toBeNull();
    expect(start.budgetTotal).toBeNull();
    expect(start.concurrency).toBe(2);

    const types = events.map((e) => e.t);
    expect(types).toContain("phase");
    expect(types).toContain("log");

    const agentEnd = events.find((e) => e.t === "agent_end") as AgentEndEvent;
    expect(agentEnd.status).toBe("ok");
    expect(agentEnd.usage.outputTokens).toBe(10); // fake default 100 in / 10 out

    const end = lastEvent(runDir);
    expect(end.status).toBe("ok");
    expect(end.resultRef).toBe("result.json");
    expect(end.error).toBeNull();
    expect(end.totals.agents).toBe(1);
    expect(end.totals.ok).toBe(1);
    expect(end.totals.usage["codex"]!.outputTokens).toBe(10);

    expect(JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"))).toEqual({
      greeting: "hi",
    });
    expect(fs.existsSync(path.join(runDir, "pid"))).toBe(false);
  });

  it("passes args through to the script", async () => {
    const script = `export const meta = { name: 'argsy', description: 'args demo' }
return { doubled: args.n * 2 }
`;
    const { runDir } = setupRun(script, { argsJson: { n: 21 } });
    await runnerMain(runDir);
    const end = lastEvent(runDir);
    expect(end.status).toBe("ok");
    expect((readJournal(runDir)[0] as RunStartEvent).argsRef).toBe("args.json");
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"))).toEqual({
      doubled: 42,
    });
  });

  it("journals executor degradation warnings after run_start", async () => {
    const script = `export const meta = { name: 'warnings', description: 'warning demo' }
return 1
`;
    const { runDir } = setupRun(script);
    await runnerMain(runDir);
    const events = readJournal(runDir);
    expect(events[0]!.t).toBe("run_start");
    const warnings = events.filter((e) => e.t === "warn") as Array<{ text: string }>;
    expect(warnings.map((w) => w.text)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/backend "claude" cannot honor profile "Explore" sandbox="read-only"/),
        expect.stringMatching(/backend "claude" cannot honor profile "Plan" sandbox="read-only"/),
      ]),
    );
  });
});

describe("runnerMain control", () => {
  it("pre-written stop command → run_end stopped quickly, no result.json", async () => {
    const script = `export const meta = { name: 'slowpoke', description: 'slow agent' }
const r = await agent('sleep [[slow:3000]]', { label: 'sleeper' })
return r
`;
    const { runDir } = setupRun(script, { control: [{ cmd: "stop" }] });
    const t0 = Date.now();
    await runnerMain(runDir);
    expect(Date.now() - t0).toBeLessThan(2500);

    const end = lastEvent(runDir);
    expect(end.status).toBe("stopped");
    expect(end.resultRef).toBeNull();
    expect(fs.existsSync(path.join(runDir, "result.json"))).toBe(false);
    expect(fs.existsSync(path.join(runDir, "pid"))).toBe(false);
  });
});

describe("runnerMain schema flow", () => {
  it("schema agent returns a validated object that lands in result.json", async () => {
    const script = `export const meta = { name: 'schema-run', description: 'schema demo' }
const obj = await agent('emit json [[reply:{"a":4}]]', {
  label: 'extractor',
  schema: { type: 'object', properties: { a: { type: 'number' } } },
})
return { got: obj }
`;
    const { runDir } = setupRun(script);
    await runnerMain(runDir);

    const events = readJournal(runDir);
    expect((events.find((e) => e.t === "agent_start") as AgentStartEvent).hasSchema).toBe(true);
    const agentEnd = events.find((e) => e.t === "agent_end") as AgentEndEvent;
    expect(agentEnd.status).toBe("ok");
    expect(agentEnd.resultRef).toMatch(/output\.json$/);

    const end = lastEvent(runDir);
    expect(end.status).toBe("ok");
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"))).toEqual({
      got: { a: 4 },
    });
  });
});

describe("runnerMain budget", () => {
  it("tiny budget + usage ticks → second agent() throws → run_end failed", async () => {
    const script = `export const meta = { name: 'budgety', description: 'budget demo' }
const first = await agent('one [[reply:first]] [[usage:100,50]]', { label: 'a1' })
const second = await agent('two [[reply:second]]', { label: 'a2' })
return [first, second]
`;
    const { runDir } = setupRun(script, { budgetTotal: 5 });
    await runnerMain(runDir);

    const events = readJournal(runDir);
    expect((events[0] as RunStartEvent).budgetTotal).toBe(5);
    expect(events.filter((e) => e.t === "agent_start")).toHaveLength(1); // a2 never dispatched

    const end = lastEvent(runDir);
    expect(end.status).toBe("failed");
    expect(end.error).toMatch(/budget/i);
    expect(end.resultRef).toBeNull();
    expect(fs.existsSync(path.join(runDir, "result.json"))).toBe(false);
  });
});

describe("runnerMain failure paths", () => {
  it("script body throw → run_end failed with the error message", async () => {
    const script = `export const meta = { name: 'thrower', description: 'throws' }
throw new Error('kaboom from the body')
`;
    const { runDir } = setupRun(script);
    await runnerMain(runDir);
    const end = lastEvent(runDir);
    expect(end.status).toBe("failed");
    expect(end.error).toBe("kaboom from the body");
    expect(fs.existsSync(path.join(runDir, "pid"))).toBe(false);
  });

  it("unloadable script → journals run_end failed instead of dying silently", async () => {
    const { runDir } = setupRun("this is not { valid javascript");
    await runnerMain(runDir);
    const end = lastEvent(runDir);
    expect(end.status).toBe("failed");
    expect(end.error).toBeTruthy();
  });

  it("bad config.toml → run_start + run_end failed, not a dead run with an empty journal", async () => {
    const script = `export const meta = { name: 'cfg-fail', description: 'config failure' }
return 'unreachable'
`;
    const { runDir, projectDir, runId } = setupRun(script);
    fs.writeFileSync(
      path.join(projectDir, ".ultracodex", "config.toml"),
      "[route\nthis is broken toml",
    );

    await runnerMain(runDir);

    const events = readJournal(runDir);
    expect(events.length).toBeGreaterThan(0); // journal must not be empty
    const start = events[0] as RunStartEvent;
    expect(start.t).toBe("run_start");
    expect(start.runId).toBe(runId);
    const end = lastEvent(runDir);
    expect(end.status).toBe("failed");
    expect(end.error).toMatch(/toml/i);
  });

  it("body returning with an agent still in flight → agent aborted + agent_end before run_end", async () => {
    const script = `export const meta = { name: 'stray', description: 'fire-and-forget agent' }
agent('background [[slow:10000]]', { label: 'stray' }) // intentionally not awaited
return await agent('quick [[reply:done]]', { label: 'quick' })
`;
    const { runDir } = setupRun(script);
    const t0 = Date.now();
    await runnerMain(runDir);
    expect(Date.now() - t0).toBeLessThan(8000); // stray was interrupted, not run out

    const events = readJournal(runDir);
    expect(events.at(-1)!.t).toBe("run_end"); // nothing journaled after run_end
    const end = lastEvent(runDir);
    expect(end.status).toBe("ok");
    expect(JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"))).toBe("done");

    // every agent_start got its agent_end; the stray one was skipped
    const agentStarts = events.filter((e) => e.t === "agent_start") as AgentStartEvent[];
    const agentEnds = events.filter((e) => e.t === "agent_end") as AgentEndEvent[];
    expect(agentStarts).toHaveLength(2);
    expect(agentEnds).toHaveLength(2);
    const strayStart = agentStarts.find((e) => e.label === "stray")!;
    const strayEnd = agentEnds.find((e) => e.n === strayStart.n)!;
    expect(strayEnd.status).toBe("skipped");
    expect(end.totals.agents).toBe(2);
  }, 15000);
});

describe("packaged loop workflows", () => {
  it("goal rejects once, approves on round 2, and journals round labels", async () => {
    const replies = [
      "builder round 1",
      {
        verdict: "rejected",
        issues: ["criterion B is not demonstrably satisfied"],
        criteria: [
          { criterion: "criterion A", pass: true, note: "verified" },
          { criterion: "criterion B", pass: false, note: "missing evidence" },
        ],
      },
      "builder round 2",
      {
        verdict: "approved",
        issues: [],
        criteria: [
          { criterion: "criterion A", pass: true, note: "verified" },
          { criterion: "criterion B", pass: true, note: "verified" },
        ],
      },
    ];
    const { runDir } = setupRun(builtinScript("goal"), {
      argsJson: {
        task: "Build the sample feature.",
        criteria: "criterion A\ncriterion B",
        budgetFloor: 0,
      },
      strict: true,
    });

    await withScriptedReplies(replies, () => runnerMain(runDir));

    const end = lastEvent(runDir);
    expect(end.status).toBe("ok");
    const result = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"));
    expect(result).toMatchObject({
      done: true,
      rounds: 2,
      verdict: "approved",
      issues: [],
    });
    expect(result.history).toEqual([
      { round: 1, verdict: "rejected", issues: ["criterion B is not demonstrably satisfied"] },
      { round: 2, verdict: "approved", issues: [] },
    ]);

    const labels = (readJournal(runDir).filter((e) => e.t === "agent_start") as AgentStartEvent[]).map(
      (e) => e.label,
    );
    expect(labels).toEqual([
      "goal:build-r1",
      "goal:verify-r1",
      "goal:build-r2",
      "goal:verify-r2",
    ]);
  });

  it("loop dedups seen findings and converges after dry rounds", async () => {
    const replies = [
      {
        findings: [
          { title: "Alpha", detail: "first sighting" },
          { title: "Alpha", detail: "duplicate sighting" },
          { title: "Beta", detail: "second sighting", location: "src/beta.ts" },
        ],
      },
      { findings: [] },
      { findings: [] },
    ];
    const { runDir } = setupRun(builtinScript("loop"), {
      argsJson: {
        find: "Find fresh issues.",
        dryRounds: 2,
        maxRounds: 5,
        budgetFloor: 0,
      },
      strict: true,
    });

    await withScriptedReplies(replies, () => runnerMain(runDir));

    const end = lastEvent(runDir);
    expect(end.status).toBe("ok");
    const result = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"));
    expect(result.done).toBe(true);
    expect(result.dry).toBe(true);
    expect(result.rounds).toBe(3);
    expect(result.seenCount).toBe(2);
    expect(result.findings).toEqual([
      { title: "Alpha", detail: "first sighting" },
      { title: "Beta", detail: "second sighting", location: "src/beta.ts" },
    ]);

    const labels = (readJournal(runDir).filter((e) => e.t === "agent_start") as AgentStartEvent[]).map(
      (e) => e.label,
    );
    expect(labels).toEqual(["loop:find-r1", "loop:find-r2", "loop:find-r3"]);
  });

  it("goal missing required args fails the run with a usage error", async () => {
    const { runDir } = setupRun(builtinScript("goal"), { strict: true });
    await runnerMain(runDir);

    const end = lastEvent(runDir);
    expect(end.status).toBe("failed");
    expect(end.error).toMatch(/usage: run goal/);
    expect(end.error).toMatch(/task, criteria/);
    expect(readJournal(runDir).filter((e) => e.t === "agent_start")).toHaveLength(0);
  });
});

describe("runnerMain workflow() child loading", () => {
  it("loads saved children by name and enforces meta.name matches the filename", async () => {
    const child = `export const meta = { name: 'kid', description: 'child wf' }
const r = await agent('child says [[reply:child-done]]', { label: 'kid-agent' })
return { r }
`;
    const parent = `export const meta = { name: 'parent', description: 'parent wf' }
const out = await workflow('kid', { x: 1 })
let mismatchError = null
try { await workflow('liar') } catch (e) { mismatchError = e.message }
let missingError = null
try { await workflow('ghost') } catch (e) { missingError = e.message }
return { out, mismatchError, missingError }
`;
    const { runDir, projectDir } = setupRun(parent);
    const wfDir = path.join(projectDir, ".ultracodex", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "kid.js"), child);
    fs.writeFileSync(path.join(wfDir, "liar.js"), child); // meta.name "kid" ≠ "liar"

    await runnerMain(runDir);

    const end = lastEvent(runDir);
    expect(end.status).toBe("ok");
    const result = JSON.parse(fs.readFileSync(path.join(runDir, "result.json"), "utf8"));
    expect(result.out).toEqual({ r: "child-done" });
    expect(result.mismatchError).toMatch(/liar/);
    expect(result.missingError).toMatch(/unknown workflow "ghost"/);
  });
});
