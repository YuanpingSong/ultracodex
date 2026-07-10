import { describe, it, expect, afterEach, vi } from "vitest";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProgram,
  fmtEvent,
  lsElapsed,
  opencodeDoctorReport,
  parseBudget,
  reportInteractiveDivergence,
  resolveScript,
  sanitizeText,
  tailRun,
} from "../src/cli.js";
import { DEFAULT_CODEX_CONFIG, TESTED_CODEX_VERSION, TESTED_OPENCODE_VERSION } from "../src/constants.js";
import { JournalWriter } from "../src/journal.js";
import { createRunDir, listRuns, pidAlive, writePidFile } from "../src/rundir.js";
import { scheduleSpecPath } from "../src/schedule/spec.js";
import { fmtDuration } from "../src/tui/format.js";
import type { JournalEvent } from "../src/types.js";
import { fakeCodexPath } from "./helpers.js";

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function tmpProject(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-cli-"));
  dirs.push(d);
  return d;
}

describe("parseBudget", () => {
  it("parses k/m suffixes and plain numbers", () => {
    expect(parseBudget("500k")).toBe(500_000);
    expect(parseBudget("1.5m")).toBe(1_500_000);
    expect(parseBudget("12345")).toBe(12_345);
    expect(parseBudget("2K")).toBe(2_000); // case-insensitive
    expect(parseBudget("0.25M")).toBe(250_000);
    expect(parseBudget(" 10k ")).toBe(10_000); // tolerant of whitespace
  });

  it("throws on garbage", () => {
    for (const bad of ["", "abc", "10x", "-5", "0", "k", "1..5m", "1e6"]) {
      expect(() => parseBudget(bad), `parseBudget(${JSON.stringify(bad)})`).toThrow(
        /invalid budget/,
      );
    }
  });
});

describe("resolveScript", () => {
  it("resolves a relative path against the project dir", () => {
    const projectDir = tmpProject();
    const file = path.join(projectDir, "my-script.js");
    fs.writeFileSync(file, "// script");
    expect(resolveScript(projectDir, "my-script.js")).toBe(file);
  });

  it("resolves an absolute path", () => {
    const projectDir = tmpProject();
    const other = tmpProject();
    const file = path.join(other, "elsewhere.js");
    fs.writeFileSync(file, "// script");
    expect(resolveScript(projectDir, file)).toBe(file);
  });

  it("resolves a saved workflow name to stateDir/workflows/<name>.js", () => {
    const projectDir = tmpProject();
    const wfDir = path.join(projectDir, ".ultracodex", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    const file = path.join(wfDir, "digest.js");
    fs.writeFileSync(file, "// wf");
    expect(resolveScript(projectDir, "digest")).toBe(file);
  });

  it("resolves a packaged builtin workflow name when no local copy exists", () => {
    const projectDir = tmpProject();
    expect(resolveScript(projectDir, "goal")).toBe(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "goal.js"),
    );
  });

  it("prefers a saved workflow over a same-named packaged builtin", () => {
    const projectDir = tmpProject();
    const wfDir = path.join(projectDir, ".ultracodex", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    const file = path.join(wfDir, "goal.js");
    fs.writeFileSync(file, "// shadow");
    expect(resolveScript(projectDir, "goal")).toBe(file);
  });

  it("prefers a real file over a same-named saved workflow", () => {
    const projectDir = tmpProject();
    const wfDir = path.join(projectDir, ".ultracodex", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "dup.js"), "// wf");
    const local = path.join(projectDir, "dup");
    fs.writeFileSync(local, "// local file");
    expect(resolveScript(projectDir, "dup")).toBe(local);
  });

  it("throws with all tried locations when nothing matches", () => {
    const projectDir = tmpProject();
    expect(() => resolveScript(projectDir, "ghost")).toThrow(/cannot resolve script "ghost"/);
    expect(() => resolveScript(projectDir, "ghost")).toThrow(/workflows/);
    expect(() => resolveScript(projectDir, "ghost")).toThrow(/packaged workflow/);
  });
});

describe("buildProgram", () => {
  it("registers the full command surface", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining([
        "run",
        "ls",
        "show",
        "attach",
        "pause",
        "resume",
        "skip",
        "kill",
        "logs",
        "validate",
        "sync-skills",
        "schedule",
        "org",
        "doctor",
      ]),
    );
  });

  it("run command exposes the documented options", () => {
    const run = buildProgram().commands.find((c) => c.name() === "run")!;
    const flags = run.options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--args",
        "--budget",
        "--watch",
        "--detach",
        "--json",
        "--strict",
        "--concurrency",
      ]),
    );
  });

  it("org command exposes the documented subcommands and options", () => {
    const org = buildProgram().commands.find((c) => c.name() === "org")!;
    expect(org.commands.map((c) => c.name())).toEqual(
      expect.arrayContaining(["init", "tick", "wake", "send", "ask", "tickets", "lint", "status", "replay", "audit"]),
    );

    const tick = org.commands.find((c) => c.name() === "tick")!;
    expect(tick.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--root", "--date", "--json", "--repair", "--commit", "--concurrency"]),
    );

    const send = org.commands.find((c) => c.name() === "send")!;
    expect(send.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--root", "--body-file", "--refs", "--deadline"]),
    );

    const replay = org.commands.find((c) => c.name() === "replay")!;
    expect(replay.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--root", "--from", "--to", "--faults", "--pristine", "--json"]),
    );

    const audit = org.commands.find((c) => c.name() === "audit")!;
    expect(audit.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--root", "--sample", "--json"]),
    );
  });
});

function writeCodexWrapper(projectDir: string, versionLine: string): string {
  const bin = path.join(projectDir, "codex-wrapper.cjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fake = ${JSON.stringify(fakeCodexPath())};
if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(`${versionLine}\n`)});
  process.exit(0);
}
const child = spawn(process.execPath, [fake, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

// ---------------------------------------------------------------------------
// Journal-text sanitization (--watch / ls rendering)
// ---------------------------------------------------------------------------

describe("sanitizeText", () => {
  it("strips CSI color/clear sequences", () => {
    expect(sanitizeText("\u001b[31mred\u001b[0m")).toBe("red");
    expect(sanitizeText("\u001b[2Jcleared")).toBe("cleared");
  });

  it("strips OSC sequences (BEL- and ST-terminated, and unterminated)", () => {
    expect(sanitizeText("\u001b]0;evil title\u0007ok")).toBe("ok");
    expect(sanitizeText("\u001b]8;;http://x\u001b\\link")).toBe("link");
    expect(sanitizeText("before\u001b]0;never terminated")).toBe("before");
  });

  it("maps raw newlines/CR/tabs and other control chars to spaces", () => {
    expect(sanitizeText("a\r\nb\tc")).toBe("a  b c");
    expect(sanitizeText("x\u0000y\u009bz")).toBe("x y z");
  });

  it("removes lone/other ESC sequences", () => {
    expect(sanitizeText("esc\u001bc")).toBe("esc");
    expect(sanitizeText("tail\u001b")).toBe("tail");
  });

  it("leaves plain unicode text untouched", () => {
    expect(sanitizeText("\u65e5\u672c\u8a9e \u2714 ok")).toBe("\u65e5\u672c\u8a9e \u2714 ok");
  });
});

describe("fmtEvent", () => {
  it("sanitizes agent-controlled text (no ANSI escapes or line forgery)", () => {
    const evil = "safe\u001b[31mred\u001b]0;t\u0007\nagent 9 ok (forged)";
    const line = fmtEvent({ t: "log", ts: 1, text: evil })!;
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("\n");
    expect(line).toContain("safe");
    const act = fmtEvent({ t: "agent_activity", ts: 1, n: 2, kind: "exec", text: evil })!;
    expect(act).not.toContain("\u001b");
    expect(act).not.toContain("\n");
  });

  it("sanitizes labels and errors", () => {
    const start = fmtEvent({
      t: "agent_start",
      ts: 1,
      n: 1,
      label: "bad\u001b[31mlabel",
      phase: null,
      backend: "codex",
      model: "m\u001b[0m",
      effort: null,
      promptSha: "x",
      promptRef: "agents/1-x/prompt.md",
      hasSchema: false,
    })!;
    expect(start).not.toContain("\u001b");
    const end = fmtEvent({
      t: "agent_end",
      ts: 1,
      n: 1,
      status: "failed",
      ms: 10,
      usage: {
        totalTokens: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      resultRef: null,
      error: "boom\u001b[2J\r\nfake line",
    })!;
    expect(end).not.toContain("\u001b");
    expect(end).not.toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// Dead-run handling: show / show --wait / kill / ls (in-process)
// ---------------------------------------------------------------------------

function runStartEvent(runId: string, ts = 1000): JournalEvent {
  return {
    t: "run_start",
    ts,
    runId,
    meta: { name: "wf", description: "d" },
    scriptSha: "sha",
    argsRef: null,
    budgetTotal: null,
    concurrency: 1,
  };
}

function makeRun(projectDir: string, runId: string, events: JournalEvent[], pid?: number): string {
  const runDir = createRunDir(projectDir, runId);
  const w = new JournalWriter(runDir);
  for (const ev of events) w.append(ev);
  w.close();
  if (pid !== undefined) writePidFile(runDir, pid);
  return runDir;
}

function writeCorruptScheduleSpec(projectDir: string): void {
  const specPath = scheduleSpecPath(projectDir, "bad");
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, "{ not json", "utf8");
  fs.writeFileSync(scheduleSpecPath(projectDir, "malformed"), '{"status":"active"}\n', "utf8");
}

async function runCliInProc(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const prevCwd = process.cwd();
  const prevExit = process.exitCode;
  let out = "";
  let err = "";
  const so = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as never);
  const se = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as never);
  process.chdir(cwd);
  process.exitCode = undefined;
  try {
    await buildProgram().parseAsync(["node", "ultracodex", ...args]);
    const code = typeof process.exitCode === "number" ? process.exitCode : 0;
    return { stdout: out, stderr: err, code };
  } finally {
    so.mockRestore();
    se.mockRestore();
    process.exitCode = prevExit;
    process.chdir(prevCwd);
  }
}

describe("packaged builtin workflows", () => {
  it("validate --strict passes for packaged builtins by name", async () => {
    for (const name of ["goal", "loop", "org-lint-repair", "org-audit"]) {
      const res = await runCliInProc(["validate", name, "--strict"], tmpProject());
      expect(res.code).toBe(0);
      expect(res.stderr).toBe("");
      expect(res.stdout).toBe("ok: no issues\n");
    }
  });
});

describe("org CLI", () => {
  it("initializes, lints JSON, wakes through a stub engine, and lists tickets", async () => {
    const projectDir = tmpProject();
    fs.writeFileSync(
      path.join(projectDir, "coverage.toml"),
      [
        "[groups.alpha]",
        "title = \"Alpha\"",
        "entities = [\"widgets\", \"wproc\"]",
        "",
      ].join("\n"),
      "utf8",
    );

    const init = await runCliInProc(["org", "init", "--root", projectDir], projectDir);
    expect(init.code).toBe(0);
    expect(fs.existsSync(path.join(projectDir, "alpha", "widgets", "BRIEF.md"))).toBe(true);

    const lint = await runCliInProc(["org", "lint", "--root", projectDir, "--json"], projectDir);
    expect(lint.code).toBe(0);
    expect(JSON.parse(lint.stdout)).toEqual([]);

    const stub = path.join(projectDir, "stub-engine.cjs");
    fs.writeFileSync(
      stub,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ result: { changed: false, severity: "routine", logLine: "stub", outbox: [] }, threadId: "stub-thread" }) + "\\n");
`,
      "utf8",
    );
    fs.chmodSync(stub, 0o755);
    const prevBin = process.env.ULTRACODEX_BIN;
    process.env.ULTRACODEX_BIN = stub;
    try {
      const wake = await runCliInProc(["org", "wake", "alpha/widgets", "--root", projectDir, "--json"], projectDir);
      expect(wake.code).toBe(0);
      expect(JSON.parse(wake.stdout)).toMatchObject({ severity: "routine", logLine: "stub" });
    } finally {
      if (prevBin === undefined) delete process.env.ULTRACODEX_BIN;
      else process.env.ULTRACODEX_BIN = prevBin;
    }

    const sent = await runCliInProc(["org", "send", ".", "REQUEST", "alpha/widgets", "Check item", "--root", projectDir], projectDir);
    expect(sent.code).toBe(0);
    const sentJson = JSON.parse(sent.stdout);
    expect(sentJson).toMatchObject({ action: "ticket" });
    expect(sentJson.relPath).toMatch(/^alpha\/widgets\/tickets\/ticket-\d{4}-\d{2}-\d{2}-check-item\.md$/u);

    const reply = await runCliInProc(["org", "send", "alpha/widgets", "REPLY", sentJson.ticket.id, "Answer from subject", "--root", projectDir], projectDir);
    expect(reply.code).toBe(0);
    expect(JSON.parse(reply.stdout)).toMatchObject({ action: "reply", relPath: sentJson.relPath });

    const tickets = await runCliInProc(["org", "tickets", "--root", projectDir, "--agent", "alpha/widgets", "--json"], projectDir);
    expect(tickets.code).toBe(0);
    expect(JSON.parse(tickets.stdout)).toEqual([
      expect.objectContaining({ to: "alpha/widgets", state: "done", subject: "Check item", replies: expect.stringContaining("Answer from subject") }),
    ]);
  });
});

describe("show on dead runs", () => {
  it("show --json reports status dead and exits non-zero for a crashed run", async () => {
    const proj = tmpProject();
    makeRun(proj, "uc_deadshow1", [runStartEvent("uc_deadshow1")]); // no pid file
    const res = await runCliInProc(["show", "uc_deadshow1", "--json"], proj);
    expect(res.code).toBe(1);
    const parsed = JSON.parse(res.stdout) as { status: string; error: string };
    expect(parsed.status).toBe("dead");
    expect(parsed.error).toMatch(/runner exited/);
  });

  it("show (static) flags a dead run on stderr and exits non-zero", async () => {
    const proj = tmpProject();
    makeRun(proj, "uc_deadshow2", [runStartEvent("uc_deadshow2")], 9999999);
    const res = await runCliInProc(["show", "uc_deadshow2"], proj);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/dead/);
  });

  it("show --wait returns immediately (dead, non-zero) when the pid was recycled", async () => {
    const proj = tmpProject();
    // process.pid is alive but is NOT this run's runner → dead, don't wait.
    makeRun(proj, "uc_waitdead1", [runStartEvent("uc_waitdead1")], process.pid);
    const t0 = Date.now();
    const res = await runCliInProc(["show", "uc_waitdead1", "--wait", "--json"], proj);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(res.code).toBe(1);
    expect((JSON.parse(res.stdout) as { status: string }).status).toBe("dead");
  }, 10_000);

  it("show --json still exits 0 for a completed run", async () => {
    const proj = tmpProject();
    makeRun(proj, "uc_okshow1", [
      runStartEvent("uc_okshow1"),
      {
        t: "run_end",
        ts: 2000,
        status: "ok",
        resultRef: null,
        error: null,
        totals: { agents: 0, ok: 0, failed: 0, skipped: 0, usage: {}, ms: 1000 },
      },
    ]);
    const res = await runCliInProc(["show", "uc_okshow1", "--json"], proj);
    expect(res.code).toBe(0);
    expect((JSON.parse(res.stdout) as { status: string }).status).toBe("ok");
  });

  it("waits for a final run_end flush after pid death instead of returning dead", async () => {
    vi.useFakeTimers();
    const proj = tmpProject();
    const runDir = makeRun(proj, "uc_flushrace1", [runStartEvent("uc_flushrace1")]);
    const seen: JournalEvent[] = [];
    const pending = tailRun(runDir, { onEvent: (event) => seen.push(event) });

    await vi.advanceTimersByTimeAsync(3000);
    const writer = new JournalWriter(runDir);
    writer.append({
      t: "run_end",
      ts: 2000,
      status: "ok",
      resultRef: "result.json",
      error: null,
      totals: { agents: 0, ok: 0, failed: 0, skipped: 0, usage: {}, ms: 1000 },
    });
    writer.close();
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toMatchObject({ t: "run_end", status: "ok" });
    expect(seen.some((event) => event.t === "run_end")).toBe(true);
  });

  it("lists run_end as ok even when the pid is dead", () => {
    const proj = tmpProject();
    makeRun(
      proj,
      "uc_lsend1",
      [
        runStartEvent("uc_lsend1"),
        {
          t: "run_end",
          ts: 2000,
          status: "ok",
          resultRef: null,
          error: null,
          totals: { agents: 0, ok: 0, failed: 0, skipped: 0, usage: {}, ms: 1000 },
        },
      ],
      9999999,
    );

    expect(listRuns(proj)[0]?.status).toBe("ok");
  });
});

describe("doctor", () => {
  it("pins codex protocol drift wording", async () => {
    const projectDir = tmpProject();
    const codexHome = path.join(projectDir, "codex-home");
    const binary = writeCodexWrapper(projectDir, "codex-cli 9.9.9 (fake)");
    fs.mkdirSync(path.join(projectDir, ".ultracodex"), { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".ultracodex", "config.toml"),
      `[route]\n"*" = "codex"\n\n[backends.codex]\nbinary = ${JSON.stringify(binary)}\n`,
    );

    const prevCodexHome = process.env.CODEX_HOME;
    const prevCrontab = process.env.ULTRACODEX_CRONTAB_FILE;
    process.env.CODEX_HOME = codexHome;
    process.env.ULTRACODEX_CRONTAB_FILE = path.join(projectDir, "crontab");
    try {
      const res = await runCliInProc(["doctor"], projectDir);
      expect(res.code).toBe(0);
      expect(res.stdout).toContain(`not the tested pin (${TESTED_CODEX_VERSION})`);
      expect(res.stdout).toContain("the app-server protocol is experimental");
    } finally {
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      if (prevCrontab === undefined) delete process.env.ULTRACODEX_CRONTAB_FILE;
      else process.env.ULTRACODEX_CRONTAB_FILE = prevCrontab;
    }
  });
});

describe("show --wait --timeout-ms validation", () => {
  it("rejects non-numeric values instead of arming a NaN timer", async () => {
    const proj = tmpProject();
    const res = await runCliInProc(["show", "nope", "--wait", "--timeout-ms", "abc"], proj);
    expect(res.code).toBe(1); // clear error, not the bogus instant "timed out" exit 2
    expect(res.stderr).toMatch(/--timeout-ms must be a positive integer/);
  });

  it("rejects zero/negative values", async () => {
    const proj = tmpProject();
    const res = await runCliInProc(["show", "nope", "--wait", "--timeout-ms", "0"], proj);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/--timeout-ms must be a positive integer/);
  });
});

describe("kill pid-reuse guard", () => {
  it("refuses to signal a recycled pid that belongs to another process", async () => {
    const proj = tmpProject();
    const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(decoy);
    await new Promise((r) => setTimeout(r, 80));
    makeRun(proj, "uc_killrec1", [runStartEvent("uc_killrec1")], decoy.pid!);
    const res = await runCliInProc(["kill", "uc_killrec1"], proj);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/runner exited|another process/);
    expect(pidAlive(decoy.pid!)).toBe(true); // decoy untouched — no stray SIGTERM/SIGKILL
  }, 15_000);
});

describe("lsElapsed", () => {
  it("freezes dead runs at the last journal event instead of ticking", () => {
    const proj = tmpProject();
    const runDir = makeRun(proj, "uc_el1", [
      runStartEvent("uc_el1", 1000),
      { t: "log", ts: 6000, text: "last sign of life" },
    ]);
    expect(lsElapsed({ runDir, status: "dead", startedAt: 1000, endedAt: null })).toBe(
      fmtDuration(5000),
    );
  });

  it("shows a dash for a dead run with no activity after run_start", () => {
    const proj = tmpProject();
    const runDir = makeRun(proj, "uc_el2", [runStartEvent("uc_el2", 1000)]);
    expect(lsElapsed({ runDir, status: "dead", startedAt: 1000, endedAt: null })).toBe("-");
  });

  it("uses endedAt for finished runs", () => {
    expect(lsElapsed({ runDir: "/nope", status: "ok", startedAt: 1000, endedAt: 11000 })).toBe(
      fmtDuration(10000),
    );
  });

  it("ls output for a dead run does not grow from Date.now()", async () => {
    const proj = tmpProject();
    const start = Date.now() - 3_600_000; // an hour ago
    makeRun(proj, "uc_lsdead1", [
      runStartEvent("uc_lsdead1", start),
      { t: "log", ts: start + 5000, text: "bye" },
    ]);
    const res = await runCliInProc(["ls"], proj);
    const row = res.stdout.split("\n").find((l) => l.includes("uc_lsdead1"))!;
    expect(row).toContain("dead");
    expect(row).toContain(fmtDuration(5000));
    expect(row).not.toContain("1h00m");
  });
});

describe("missed-run nudges", () => {
  it("does not let a corrupt schedule spec break top-level ls", async () => {
    const proj = tmpProject();
    writeCorruptScheduleSpec(proj);

    const res = await runCliInProc(["ls"], proj);

    expect(res.code).toBe(0);
    expect(res.stdout).toBe("no runs\n");
    expect(res.stderr).not.toContain("cannot read schedule");
  });

  it("does not let a corrupt schedule spec break run before the real command executes", async () => {
    const proj = tmpProject();
    writeCorruptScheduleSpec(proj);
    fs.writeFileSync(path.join(proj, "bad.js"), "return 1;\n", "utf8");

    const res = await runCliInProc(["run", "bad.js"], proj);

    expect(res.code).toBe(1);
    expect(res.stderr).toContain("validation failed");
    expect(res.stderr).not.toContain("cannot read schedule");
  });
});

// ---------------------------------------------------------------------------
// Full-binary integration (only after `pnpm build`)
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCli = path.join(repoRoot, "dist", "cli.js");
const distRunner = path.join(repoRoot, "dist", "runner.js");
const distBuilt = fs.existsSync(distCli) && fs.existsSync(distRunner);

function execCli(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [distCli, ...args],
      { cwd, timeout: 25_000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

describe.skipIf(!distBuilt)("dist/cli.js (post-build integration)", () => {
  it("run --json spawns a detached runner and prints the result JSON", async () => {
    const projectDir = tmpProject();
    fs.mkdirSync(path.join(projectDir, ".ultracodex"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".ultracodex", "config.toml"),
      `[route]\n"*" = "codex"\n\n[backends.codex]\nbinary = ${JSON.stringify(fakeCodexPath())}\n`,
    );
    fs.writeFileSync(
      path.join(projectDir, "wf.js"),
      `export const meta = { name: 'cli-e2e', description: 'cli demo' }
const hi = await agent('greet [[reply:hi]]', { label: 'greeter' })
return { greeting: hi }
`,
    );
    const { stdout, stderr, code } = await execCli(["run", "wf.js", "--json"], projectDir);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ greeting: "hi" });
  }, 30_000);
});

describe("reportInteractiveDivergence (doctor)", () => {
  function withCodexHome(tomlBody: string | null, fn: (info: string[]) => void): void {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    dirs.push(home);
    if (tomlBody !== null) fs.writeFileSync(path.join(home, "config.toml"), tomlBody);
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const lines: string[] = [];
    try {
      reportInteractiveDivergence(DEFAULT_CODEX_CONFIG, (label, detail) => lines.push(`${label}: ${detail}`));
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
    fn(lines);
  }

  it("surfaces service_tier + approvals divergence and inherited MCP servers", () => {
    withCodexHome(
      'service_tier = "fast"\napprovals_reviewer = "user"\n[mcp_servers.playwright]\ncommand = "npx"\n[mcp_servers.xcode]\ncommand = "x"',
      (info) => {
        const div = info.find((l) => l.startsWith("diverges"));
        expect(div).toMatch(/service tier: fast .* → standard/);
        expect(div).toMatch(/approvals: "user" .* → auto-denied/);
        const mcp = info.find((l) => l.startsWith("inherited"));
        expect(mcp).toMatch(/2 MCP servers/);
      },
    );
  });

  it("says nothing when interactive config matches agent behavior", () => {
    withCodexHome('service_tier = "standard"', (info) => {
      expect(info.find((l) => l.startsWith("diverges"))).toBeUndefined();
    });
  });

  it("silent when ~/.codex/config.toml is absent or unparseable", () => {
    withCodexHome(null, (info) => expect(info).toHaveLength(0));
    withCodexHome("[broken\ntoml", (info) => expect(info).toHaveLength(0));
  });
});

// ---------------------------------------------------------------------------
// opencodeDoctorReport
// ---------------------------------------------------------------------------

describe("opencodeDoctorReport", () => {
  const cfgNoRoute: UltracodexConfig = {
    route: [{ pattern: "*", backend: "codex" }],
    concurrency: null,
    codex: DEFAULT_CODEX_CONFIG,
    claude: { binary: "claude", defaultModel: "sonnet", modelMap: {}, extraArgs: [] },
    opencode: { binary: "opencode", model: "deepseek/deepseek-chat", modelMap: {}, variantMap: {}, schemaRetries: 3, extraArgs: [] },
    profiles: {},
  };
  const cfgRouted: UltracodexConfig = {
    ...cfgNoRoute,
    route: [{ pattern: "*", backend: "opencode" }],
  };
  const testVersion = `opencode/${TESTED_OPENCODE_VERSION}`;

  const probeResolve =
    (v: string) =>
    async (_bin: string): Promise<string> =>
      v;

  const probeReject =
    (msg: string) =>
    async (_bin: string): Promise<string> => {
      throw new Error(msg);
    };

  it("not routed: single info, no probe call", async () => {
    const spy = vi.fn(async (_bin: string) => "opencode/x.y.z");
    const r = await opencodeDoctorReport(cfgNoRoute, spy);
    expect(spy).not.toHaveBeenCalled();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ kind: "info", label: "opencode", detail: "not routed; skipping checks" });
    expect(r.hardFail).toBe(false);
  });

  it("routed + probe rejects: fail line + hardFail true", async () => {
    const r = await opencodeDoctorReport(cfgRouted, probeReject("ENOENT"));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ kind: "fail", label: "opencode binary" });
    expect(r.lines[0].detail).toContain("ENOENT");
    expect(r.lines[0].hint).toMatch(/install opencode|opencode\.binary/);
    expect(r.hardFail).toBe(true);
  });

  it("routed + version matches pin: ok line with 'matches tested pin', three posture lines, no drift info", async () => {
    const r = await opencodeDoctorReport(cfgRouted, probeResolve(testVersion));
    const okLines = r.lines.filter((l) => l.kind === "ok");
    const infoLines = r.lines.filter((l) => l.kind === "info");
    expect(okLines).toHaveLength(1);
    expect(okLines[0].label).toBe("opencode binary");
    expect(okLines[0].detail).toContain(`matches tested pin ${TESTED_OPENCODE_VERSION}`);
    const driftLines = infoLines.filter((l) => l.label === "opencode version");
    expect(driftLines).toHaveLength(0);
    const posture = infoLines.filter((l) => l.label.startsWith("opencode "));
    expect(posture).toHaveLength(3);
    expect(posture[0].label).toBe("opencode sandbox");
    expect(posture[0].detail).toContain("WITHOUT OS sandboxing");
    expect(posture[0].detail).toContain("per-call tools map can suppress builtin tools");
    expect(posture[0].detail).toContain("MCP tools are not blocked");
    expect(posture[1].label).toBe("opencode permissions");
    expect(posture[1].detail).toContain("tools including shell");
    expect(posture[1].detail).toContain("no approval gate");
    expect(posture[2].label).toBe("opencode mcp");
    expect(posture[2].detail).toContain("MCP servers");
    expect(posture[2].detail).toContain("inherited into every agent session");
    expect(r.hardFail).toBe(false);
  });

  it("routed + version differs: 'tested against' + drift info line", async () => {
    const r = await opencodeDoctorReport(cfgRouted, probeResolve("opencode/1.17.0"));
    const okLines = r.lines.filter((l) => l.kind === "ok");
    const driftLines = r.lines.filter((l) => l.kind === "info" && l.label === "opencode version");
    expect(okLines).toHaveLength(1);
    expect(okLines[0].label).toBe("opencode binary");
    expect(okLines[0].detail).toContain(`tested against ${TESTED_OPENCODE_VERSION}`);
    expect(driftLines).toHaveLength(1);
    expect(driftLines[0].detail).toContain(TESTED_OPENCODE_VERSION);
    expect(driftLines[0].detail).toContain("the server protocol is experimental");
    // Version drift must not suppress the posture facts (review finding).
    const posture = r.lines.filter(
      (l) => l.kind === "info" && l.label.startsWith("opencode ") && l.label !== "opencode version",
    );
    expect(posture).toHaveLength(3);
    expect(r.hardFail).toBe(false);
  });
});
