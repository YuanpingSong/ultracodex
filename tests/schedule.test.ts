import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProgram } from "../src/cli.js";
import { CliError } from "../src/cli-error.js";
import { addSchedule, NO_SCHEDULE_BUDGET_WARNING } from "../src/schedule/add.js";
import {
  renderCrontabLine,
  scheduleTag,
} from "../src/schedule/crontab.js";
import { isExecRunning } from "../src/schedule/exec.js";
import { parseScheduleLogTail } from "../src/schedule/log.js";
import {
  checkMissedSchedules,
  nextFireMs,
  newScheduleSpec,
  parseEvery,
  readScheduleSpec,
  scheduleLockPath,
  scheduleLogPath,
  scheduleSpecPath,
  writeScheduleSpec,
  type ScheduleSpec,
} from "../src/schedule/spec.js";
import {
  buildScheduleHistoryStrip,
  execOutcomeGlyph,
  formatScheduleBudgetSuffix,
  formatScheduleCountdown,
  formatScheduleLastRunCell,
  formatScheduleRow,
  scheduleStatusGlyph,
  sortScheduleSpecsForDisplay,
  validateScheduleFormDraft,
} from "../src/tui/schedules.js";

const dirs: string[] = [];
const children: ChildProcess[] = [];
let prevCrontabFile: string | undefined;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCli = path.join(repoRoot, "dist", "cli.js");
const distBuilt = fs.existsSync(distCli);

beforeEach(() => {
  prevCrontabFile = process.env.ULTRACODEX_CRONTAB_FILE;
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-crontab-")));
  dirs.push(d);
  process.env.ULTRACODEX_CRONTAB_FILE = path.join(d, "crontab");
});

afterEach(() => {
  vi.useRealTimers();
  for (const c of children.splice(0)) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
  if (prevCrontabFile === undefined) delete process.env.ULTRACODEX_CRONTAB_FILE;
  else process.env.ULTRACODEX_CRONTAB_FILE = prevCrontabFile;
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function tmpProject(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-schedule-")));
  dirs.push(d);
  return d;
}

function crontabFile(): string {
  return process.env.ULTRACODEX_CRONTAB_FILE!;
}

function readCrontabFile(): string {
  try {
    return fs.readFileSync(crontabFile(), "utf8");
  } catch {
    return "";
  }
}

function localMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  ms = 0,
): number {
  return new Date(year, month - 1, day, hour, minute, second, ms).getTime();
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

async function addEvery(
  projectDir: string,
  name: string,
  command = [process.execPath, "-e", "process.exit(0)"],
): Promise<void> {
  const res = await runCliInProc(["schedule", "add", name, "--every", "5m", "--", ...command], projectDir);
  expect(res.code).toBe(0);
}

function waitForChild(child: ChildProcess): Promise<{ code: number | null; stderr: string; stdout: string }> {
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onMessage = (msg: unknown) => {
      if (msg !== "ready") return;
      cleanup();
      resolve();
    };
    const onClose = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited before ready (${code ?? "signal"})`));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    child.once("message", onMessage);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

describe("schedule time helpers", () => {
  it("computes next every-minute fires using cron minute multiples", () => {
    expect(
      nextFireMs({ kind: "every", value: "15m" }, localMs(2026, 1, 1, 12, 31, 5)),
    ).toBe(localMs(2026, 1, 1, 12, 45));
    expect(
      nextFireMs({ kind: "every", value: "20m" }, localMs(2026, 1, 1, 12, 59, 30)),
    ).toBe(localMs(2026, 1, 1, 13, 0));
    expect(
      nextFireMs({ kind: "every", value: "30m" }, localMs(2026, 1, 1, 12, 30)),
    ).toBe(localMs(2026, 1, 1, 12, 30));
  });

  it("computes next every-hour fires across day rollover", () => {
    expect(
      nextFireMs({ kind: "every", value: "6h" }, localMs(2026, 1, 1, 22, 10)),
    ).toBe(localMs(2026, 1, 2, 0, 0));
    expect(
      nextFireMs({ kind: "every", value: "6h" }, localMs(2026, 1, 1, 18, 0)),
    ).toBe(localMs(2026, 1, 1, 18, 0));
  });

  it("computes daily fires today or tomorrow and leaves raw cron unknown", () => {
    expect(
      nextFireMs({ kind: "daily", value: "18:30" }, localMs(2026, 1, 1, 18, 29, 59)),
    ).toBe(localMs(2026, 1, 1, 18, 30));
    expect(
      nextFireMs({ kind: "daily", value: "18:30" }, localMs(2026, 1, 1, 18, 30, 1)),
    ).toBe(localMs(2026, 1, 2, 18, 30));
    expect(nextFireMs({ kind: "cron", value: "7 8 * * 1" }, localMs(2026, 1, 1, 18, 30))).toBeNull();
  });
});

describe("parseEvery", () => {
  it("rejects non-uniform minute and hour steps with valid values and --cron guidance", () => {
    for (const value of ["59m", "7m", "5h"]) {
      let thrown: unknown;
      try {
        parseEvery(value);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CliError);
      expect((thrown as Error).message).toContain("valid values:");
      expect((thrown as Error).message).toContain("--cron for irregular cadences");
    }
  });

  it("accepts uniform divisor cadences", () => {
    expect(parseEvery("15m").cronExpr).toBe("*/15 * * * *");
    expect(parseEvery("30m").cronExpr).toBe("*/30 * * * *");
    expect(parseEvery("6h").cronExpr).toBe("0 */6 * * *");
  });
});

describe("schedule log tail parser", () => {
  it("returns the last exec outcomes and ignores annotations or truncated first lines", () => {
    const outcomes = parseScheduleLogTail(
      [
        "26-01-01T00:00:00.000Z · exit 0 · status ok",
        "2026-01-01T00:01:00.000Z · skipped: paused",
        "2026-01-01T00:02:00.000Z · exit 0 · status ok",
        "2026-01-01T00:02:00.000Z · stdout:",
        "hello",
        "2026-01-01T00:03:00.000Z · exit 7 · runId uc_bad · status failed",
        "2026-01-01T00:04:00.000Z · retired: done",
        "2026-01-01T00:05:00.000Z · exit 0 · status ok",
      ].join("\n"),
      2,
    );

    expect(outcomes).toEqual([
      { ts: "2026-01-01T00:03:00.000Z", ok: false },
      { ts: "2026-01-01T00:05:00.000Z", ok: true },
    ]);
  });
});

describe("addSchedule", () => {
  it("writes the same spec and crontab line as the CLI add action", async () => {
    const projectDir = tmpProject();
    const wf = path.join(projectDir, "wf.js");
    fs.writeFileSync(wf, "return { done: true };\n", "utf8");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));

    const direct = addSchedule({
      projectDir,
      name: "shared",
      every: "15m",
      untilDone: true,
      maxRuns: "3",
      budget: "200k",
      command: ["run", "wf.js", "--args", "{\"x\":1}"],
    }).spec;
    const directCrontab = readCrontabFile();
    fs.rmSync(scheduleSpecPath(projectDir, "shared"), { force: true });
    fs.writeFileSync(crontabFile(), "", "utf8");

    const cli = await runCliInProc(
      [
        "schedule",
        "add",
        "shared",
        "--every",
        "15m",
        "--until-done",
        "--max-runs",
        "3",
        "--budget",
        "200k",
        "--",
        "run",
        "wf.js",
        "--args",
        "{\"x\":1}",
      ],
      projectDir,
    );

    expect(cli).toMatchObject({ code: 0, stderr: "" });
    const cliSpec = readScheduleSpec(projectDir, "shared");
    expect(cliSpec).toEqual(direct);
    expect(readCrontabFile()).toBe(directCrontab);
    expect(readCrontabFile()).toBe(renderCrontabLine(cliSpec) + "\n");
  });
});

describe("schedule budget guardrail", () => {
  function writeWorkflow(projectDir: string): string {
    const workflow = path.join(projectDir, "wf.js");
    fs.writeFileSync(workflow, "export const meta = { name: 'wf' };\nreturn { done: false };\n", "utf8");
    return workflow;
  }

  function captureRunArgv(projectDir: string, name: string): string {
    const argvFile = path.join(projectDir, `${name}-argv.json`);
    const stub = path.join(projectDir, `${name}-stub.cjs`);
    fs.writeFileSync(
      stub,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
        "process.stdout.write('{}\\n')",
      ].join(";\n"),
      "utf8",
    );
    const spec = readScheduleSpec(projectDir, name);
    spec.cliPath = stub;
    writeScheduleSpec(spec);
    return argvFile;
  }

  it("stores a schedule budget, exposes it in JSON, and injects it into run argv", async () => {
    const projectDir = tmpProject();
    const workflow = writeWorkflow(projectDir);
    const add = await runCliInProc(
      ["schedule", "add", "bounded", "--every", "5m", "--budget", "200k", "--", "run", "wf.js"],
      projectDir,
    );

    expect(add).toMatchObject({ code: 0, stderr: "" });
    expect(readScheduleSpec(projectDir, "bounded").budget).toBe("200k");
    const json = await runCliInProc(["schedule", "ls", "--json"], projectDir);
    expect(JSON.parse(json.stdout)[0]).toMatchObject({ name: "bounded", budget: "200k" });

    const argvFile = captureRunArgv(projectDir, "bounded");
    expect(await runCliInProc(["schedule", "exec", "bounded"], projectDir)).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    });
    expect(JSON.parse(fs.readFileSync(argvFile, "utf8"))).toEqual([
      "run",
      workflow,
      "--json",
      "--budget",
      "200k",
    ]);
  });

  it("lets an explicit in-command budget win without warning or duplicate injection", async () => {
    const projectDir = tmpProject();
    const workflow = writeWorkflow(projectDir);
    const add = await runCliInProc(
      ["schedule", "add", "explicit", "--every", "5m", "--", "run", "wf.js", "--budget", "300k"],
      projectDir,
    );

    expect(add).toMatchObject({ code: 0, stderr: "" });
    expect(readScheduleSpec(projectDir, "explicit").budget).toBeNull();
    const argvFile = captureRunArgv(projectDir, "explicit");
    await runCliInProc(["schedule", "exec", "explicit"], projectDir);
    const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
    expect(argv).toEqual(["run", workflow, "--budget", "300k", "--json"]);
    expect(argv.filter((arg) => arg === "--budget")).toHaveLength(1);
  });

  it("rejects schedule budgets for non-run commands and rejects invalid specs with the run parser error", async () => {
    const projectDir = tmpProject();
    const nonRun = await runCliInProc(
      ["schedule", "add", "not-run", "--every", "5m", "--budget", "200k", "--", "node"],
      projectDir,
    );
    expect(nonRun).toEqual({
      stdout: "",
      stderr: "error: --budget requires a scheduled `run` command\n",
      code: 1,
    });

    writeWorkflow(projectDir);
    const invalid = await runCliInProc(
      ["schedule", "add", "bad-budget", "--every", "5m", "--budget", "forever", "--", "run", "wf.js"],
      projectDir,
    );
    expect(invalid).toEqual({
      stdout: "",
      stderr: 'error: invalid budget "forever" (use e.g. 500k, 1.5m, or a plain token count)\n',
      code: 1,
    });
    expect(fs.existsSync(scheduleSpecPath(projectDir, "not-run"))).toBe(false);
    expect(fs.existsSync(scheduleSpecPath(projectDir, "bad-budget"))).toBe(false);
  });

  it("warns exactly once for unbudgeted runs through CLI and shared addSchedule, but not non-run commands", async () => {
    const projectDir = tmpProject();
    writeWorkflow(projectDir);
    const warning = NO_SCHEDULE_BUDGET_WARNING("unbounded") + "\n";
    const cli = await runCliInProc(
      ["schedule", "add", "unbounded", "--every", "5m", "--", "run", "wf.js"],
      projectDir,
    );
    expect(cli).toMatchObject({ code: 0, stderr: warning });
    expect(cli.stderr.split(warning)).toHaveLength(2);

    const nonRun = await runCliInProc(
      ["schedule", "add", "utility", "--every", "5m", "--", process.execPath, "-e", "process.exit(0)"],
      projectDir,
    );
    expect(nonRun.stderr).toBe("");

    const directProject = tmpProject();
    writeWorkflow(directProject);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      addSchedule({
        projectDir: directProject,
        name: "form-path",
        every: "5m",
        command: ["run", "wf.js"],
      });
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr).toHaveBeenCalledWith(NO_SCHEDULE_BUDGET_WARNING("form-path") + "\n");
    } finally {
      stderr.mockRestore();
    }
  });

  it("reads a missing v1 budget field as null", () => {
    const projectDir = tmpProject();
    const spec = newScheduleSpec({
      name: "legacy",
      schedule: { kind: "every", value: "5m" },
      cronExpr: "*/5 * * * *",
      command: ["node"],
      projectDir,
      untilDone: false,
      maxRuns: null,
      nodeBin: process.execPath,
      cliPath: "/tmp/cli.js",
      pathEnv: "",
    });
    const legacy = { ...spec } as Partial<ScheduleSpec>;
    delete legacy.budget;
    fs.mkdirSync(path.dirname(scheduleSpecPath(projectDir, "legacy")), { recursive: true });
    fs.writeFileSync(scheduleSpecPath(projectDir, "legacy"), JSON.stringify(legacy), "utf8");

    expect(readScheduleSpec(projectDir, "legacy").budget).toBeNull();
  });
});

describe("isExecRunning", () => {
  it("distinguishes absent, stale, and live lock pids", () => {
    const projectDir = tmpProject();
    expect(isExecRunning(projectDir, "probe")).toBe(false);

    fs.mkdirSync(path.dirname(scheduleLockPath(projectDir, "probe")), { recursive: true });
    fs.writeFileSync(scheduleLockPath(projectDir, "probe"), "999999999\n", "utf8");
    expect(isExecRunning(projectDir, "probe")).toBe(false);

    fs.writeFileSync(scheduleLockPath(projectDir, "probe"), `${process.pid}\n`, "utf8");
    expect(isExecRunning(projectDir, "probe")).toBe(true);
  });
});

function scheduleFixture(overrides: Partial<ScheduleSpec> = {}): ScheduleSpec {
  return {
    ...newScheduleSpec({
      name: "report-tick",
      schedule: { kind: "daily", value: "18:30" },
      cronExpr: "30 18 * * *",
      command: ["run", "/tmp/wf.js"],
      projectDir: "/tmp/project",
      untilDone: false,
      maxRuns: null,
      nodeBin: process.execPath,
      cliPath: "/tmp/cli.js",
      pathEnv: "",
      now: new Date("2026-01-01T00:00:00.000Z"),
    }),
    ...overrides,
  };
}

describe("schedule TUI pure helpers", () => {
  it("maps status and outcome glyphs", () => {
    expect(scheduleStatusGlyph("active")).toEqual({ glyph: "●", color: "cyan", dim: false });
    expect(scheduleStatusGlyph("paused")).toEqual({ glyph: "⊘", color: "yellow", dim: false });
    expect(scheduleStatusGlyph("retired")).toEqual({ glyph: "○", color: "dim", dim: true });
    expect(execOutcomeGlyph(true)).toEqual({ glyph: "✔", color: "green", dim: false });
    expect(execOutcomeGlyph(false)).toEqual({ glyph: "✖", color: "red", dim: false });
  });

  it("builds history strips with a trailing running spinner", () => {
    expect(
      buildScheduleHistoryStrip(
        [
          { ts: "1", ok: false },
          { ts: "2", ok: true },
          { ts: "3", ok: true },
          { ts: "4", ok: false },
          { ts: "5", ok: true },
        ],
        true,
        "⠋",
      ),
    ).toBe("✔ ✔ ✖ ✔ ⠋");
  });

  it("formats countdowns including raw cron and overdue states", () => {
    const nowMs = localMs(2026, 1, 1, 16, 16);
    expect(
      formatScheduleCountdown({
        spec: { schedule: { kind: "daily", value: "18:30" } },
        nowMs,
      }),
    ).toBe("in 2h 14m");
    expect(
      formatScheduleCountdown({
        spec: { schedule: { kind: "every", value: "1m" } },
        nowMs,
        nextMs: nowMs + 45_000,
      }),
    ).toBe("in 45s");
    expect(
      formatScheduleCountdown({
        spec: { schedule: { kind: "cron", value: "7 8 * * 1" } },
        nowMs,
      }),
    ).toBe("—");
    expect(
      formatScheduleCountdown({
        spec: { schedule: { kind: "every", value: "5m" } },
        nowMs,
        overdue: true,
      }),
    ).toBe("OVERDUE");
  });

  it("formats list rows with status, schedule, history, countdown, and run count", () => {
    const spec = scheduleFixture({ runs: 12 });
    expect(
      formatScheduleRow({
        spec,
        selected: true,
        nowMs: localMs(2026, 1, 1, 16, 16),
        history: [
          { ts: "1", ok: true },
          { ts: "2", ok: false },
          { ts: "3", ok: true },
        ],
      }),
    ).toBe("❯ ● report-tick   daily 18:30   ✔ ✖ ✔   in 2h 14m   12 runs");
  });

  it("sorts active schedules by next fire before paused and retired rows", () => {
    const nowMs = localMs(2026, 1, 1, 16, 16);
    const activeSoon = scheduleFixture({
      name: "soon",
      schedule: { kind: "every", value: "15m" },
      cronExpr: "*/15 * * * *",
      status: "active",
    });
    const activeLater = scheduleFixture({
      name: "later",
      schedule: { kind: "daily", value: "18:30" },
      cronExpr: "30 18 * * *",
      status: "active",
    });
    const rawCron = scheduleFixture({
      name: "raw",
      schedule: { kind: "cron", value: "7 8 * * 1" },
      cronExpr: "7 8 * * 1",
      status: "active",
    });
    const paused = scheduleFixture({ name: "paused", status: "paused" });
    const retired = scheduleFixture({ name: "retired", status: "retired" });

    expect(
      sortScheduleSpecsForDisplay([retired, rawCron, paused, activeLater, activeSoon], nowMs).map((s) => s.name),
    ).toEqual(["soon", "later", "raw", "paused", "retired"]);
  });

  it("formats last-run cells with the short local timestamp, exit code, and run id", () => {
    expect(
      formatScheduleLastRunCell({
        ts: "2026-07-07T18:30:02.000Z",
        ok: true,
        exitCode: 0,
        runId: "uc_abc123",
      }),
    ).toMatch(/^last run ✔ \d{2}-\d{2} \d{2}:\d{2} · exit 0 · uc_abc123$/);
    expect(formatScheduleLastRunCell(null)).toBe("last run —");
  });

  it("renders a budget suffix only when a schedule budget is set", () => {
    expect(formatScheduleBudgetSuffix(scheduleFixture({ budget: "200k" }))).toBe(" · budget: 200k");
    expect(formatScheduleBudgetSuffix(scheduleFixture({ budget: null }))).toBe("");
  });

  it("validates schedule form drafts without filesystem access", () => {
    expect(
      validateScheduleFormDraft({
        name: "digest",
        cadence: "every",
        value: "30m",
        untilDone: true,
        maxRuns: "5",
        budget: "200k",
        argsJson: "{\"team\":\"ops\"}",
      }),
    ).toEqual({
      ok: true,
      name: "digest",
      every: "30m",
      untilDone: true,
      maxRuns: "5",
      budget: "200k",
      argsJson: "{\"team\":\"ops\"}",
    });
    expect(
      validateScheduleFormDraft({
        name: "bad",
        cadence: "daily",
        value: "24:00",
        untilDone: false,
        maxRuns: "",
        budget: "",
        argsJson: "",
      }),
    ).toMatchObject({ ok: false, field: "value" });
    expect(
      validateScheduleFormDraft({
        name: "digest",
        cadence: "every",
        value: "30m",
        untilDone: false,
        maxRuns: "",
        budget: "",
        argsJson: "{",
      }),
    ).toEqual({ ok: false, field: "argsJson", error: "args must be valid JSON (or empty)" });
    expect(
      validateScheduleFormDraft({
        name: "digest",
        cadence: "every",
        value: "30m",
        untilDone: false,
        maxRuns: "",
        budget: "forever",
        argsJson: "",
      }),
    ).toEqual({
      ok: false,
      field: "budget",
      error: 'invalid budget "forever" (use e.g. 500k, 1.5m, or a plain token count)',
    });
  });
});

describe("schedule lifecycle", () => {
  it("adds, lists, pauses, resumes, and removes a schedule", async () => {
    const projectDir = tmpProject();
    const add = await runCliInProc(
      ["schedule", "add", "nightly", "--every", "5m", "--", process.execPath, "-e", "process.exit(0)"],
      projectDir,
    );
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("scheduled nightly (*/5 * * * *)");

    const spec = readScheduleSpec(projectDir, "nightly");
    expect(spec).toMatchObject({
      version: 1,
      name: "nightly",
      schedule: { kind: "every", value: "5m" },
      cronExpr: "*/5 * * * *",
      command: [process.execPath, "-e", "process.exit(0)"],
      projectDir,
      untilDone: false,
      maxRuns: null,
      budget: null,
      status: "active",
      retiredReason: null,
      runs: 0,
    });
    expect(spec.nodeBin).toBe(process.execPath);
    expect(path.isAbsolute(spec.cliPath)).toBe(true);
    expect(readCrontabFile()).toBe(renderCrontabLine(spec) + "\n");
    expect(readCrontabFile()).toContain(`cd '${projectDir}' && '${process.execPath}' '${spec.cliPath}' schedule exec nightly >>'${scheduleLogPath(projectDir, "nightly")}' 2>&1 # ${scheduleTag(projectDir, "nightly")}`);

    const ls = await runCliInProc(["schedule", "ls"], projectDir);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain("NAME");
    expect(ls.stdout).toContain("nightly");
    expect(ls.stdout).toContain("every 5m");

    const json = await runCliInProc(["schedule", "ls", "--json"], projectDir);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toHaveLength(1);
    expect(JSON.parse(json.stdout)[0]).toHaveProperty("budget", null);

    const pause = await runCliInProc(["schedule", "pause", "nightly"], projectDir);
    expect(pause.code).toBe(0);
    expect(readCrontabFile()).toBe("");
    expect(readScheduleSpec(projectDir, "nightly").status).toBe("paused");

    const resume = await runCliInProc(["schedule", "resume", "nightly"], projectDir);
    expect(resume.code).toBe(0);
    expect(readCrontabFile()).toContain(scheduleTag(projectDir, "nightly"));
    expect(readScheduleSpec(projectDir, "nightly").status).toBe("active");

    const rm = await runCliInProc(["schedule", "rm", "nightly"], projectDir);
    expect(rm.code).toBe(0);
    expect(readCrontabFile()).toBe("");
    expect(fs.existsSync(scheduleSpecPath(projectDir, "nightly"))).toBe(false);
    expect(fs.readFileSync(scheduleLogPath(projectDir, "nightly"), "utf8")).toContain("removed");
  });

  it("rejects duplicate names, bad slugs, bad --every values, and --until-done without run", async () => {
    const projectDir = tmpProject();
    await addEvery(projectDir, "dup");

    const dup = await runCliInProc(["schedule", "add", "dup", "--every", "5m", "--", "node"], projectDir);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toMatch(/already exists/);

    const slug = await runCliInProc(["schedule", "add", "Bad", "--every", "5m", "--", "node"], projectDir);
    expect(slug.code).toBe(1);
    expect(slug.stderr).toMatch(/invalid schedule name/);

    const every = await runCliInProc(["schedule", "add", "bad-every", "--every", "60m", "--", "node"], projectDir);
    expect(every.code).toBe(1);
    expect(every.stderr).toMatch(/invalid --every/);

    const done = await runCliInProc(
      ["schedule", "add", "done", "--every", "5m", "--until-done", "--", "node", "-e", "0"],
      projectDir,
    );
    expect(done.code).toBe(1);
    expect(done.stderr).toMatch(/--until-done requires/);
  });

  it("maps every and daily specs to cron expressions", async () => {
    const projectDir = tmpProject();
    await runCliInProc(["schedule", "add", "minutely", "--every", "20m", "--", "node"], projectDir);
    await runCliInProc(["schedule", "add", "hourly", "--every", "6h", "--", "node"], projectDir);
    await runCliInProc(["schedule", "add", "daily", "--daily", "18:30", "--", "node"], projectDir);
    expect(readScheduleSpec(projectDir, "minutely").cronExpr).toBe("*/20 * * * *");
    expect(readScheduleSpec(projectDir, "hourly").cronExpr).toBe("0 */6 * * *");
    expect(readScheduleSpec(projectDir, "daily").cronExpr).toBe("30 18 * * *");
  });

  it("rejects newline-bearing cron expressions without writing partial crontab lines", async () => {
    const projectDir = tmpProject();
    const foreign = "SHELL=/bin/zsh\n";
    fs.writeFileSync(crontabFile(), foreign, "utf8");

    const res = await runCliInProc(
      ["schedule", "add", "bad-cron", "--cron", "0 1 * * *\n* * * * *", "--", "node"],
      projectDir,
    );

    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/newlines are not allowed/);
    expect(readCrontabFile()).toBe(foreign);
    expect(fs.existsSync(scheduleSpecPath(projectDir, "bad-cron"))).toBe(false);
  });

  it("rejects newline-bearing project paths without writing a spec or crontab line", async () => {
    const parent = tmpProject();
    const projectDir = path.join(parent, "bad\npath");
    fs.mkdirSync(projectDir);
    const foreign = "SHELL=/bin/zsh\n";
    fs.writeFileSync(crontabFile(), foreign, "utf8");

    const res = await runCliInProc(
      ["schedule", "add", "bad-path", "--every", "5m", "--", process.execPath, "-e", "process.exit(0)"],
      projectDir,
    );

    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/newlines are not allowed/);
    expect(readCrontabFile()).toBe(foreign);
    expect(fs.existsSync(scheduleSpecPath(projectDir, "bad-path"))).toBe(false);
  });

  it("preserves foreign crontab lines byte-for-byte", async () => {
    const projectDir = tmpProject();
    const foreign = "# keep me\nSHELL=/bin/zsh\n0 1 * * * echo hi # ultracodex:other@deadbeef\n";
    fs.writeFileSync(crontabFile(), foreign, "utf8");
    await addEvery(projectDir, "mine");
    expect(readCrontabFile()).toContain(foreign);
    await runCliInProc(["schedule", "pause", "mine"], projectDir);
    expect(readCrontabFile()).toBe(foreign);
  });

  it("preserves a final foreign crontab line without a trailing newline through install and remove", async () => {
    const projectDir = tmpProject();
    const foreign = "# keep me\nSHELL=/bin/zsh\n0 1 * * * echo hi";
    fs.writeFileSync(crontabFile(), foreign, "utf8");

    await addEvery(projectDir, "mine");
    expect(readCrontabFile()).toContain(scheduleTag(projectDir, "mine"));

    await runCliInProc(["schedule", "rm", "mine"], projectDir);
    expect(readCrontabFile()).toBe(foreign);
  });

  it("isolates identical schedule names across project tags", async () => {
    const one = tmpProject();
    const two = tmpProject();
    await addEvery(one, "same");
    await addEvery(two, "same");
    expect(readCrontabFile()).toContain(scheduleTag(one, "same"));
    expect(readCrontabFile()).toContain(scheduleTag(two, "same"));

    await runCliInProc(["schedule", "rm", "same"], one);
    expect(readCrontabFile()).not.toContain(scheduleTag(one, "same"));
    expect(readCrontabFile()).toContain(scheduleTag(two, "same"));
  });
});

describe("schedule exec", () => {
  it("runs an arbitrary command, updates lastRun, and appends a log line", async () => {
    const projectDir = tmpProject();
    await addEvery(projectDir, "mark", [
      process.execPath,
      "-e",
      "require('node:fs').writeFileSync('marker.txt','ok')",
    ]);

    const res = await runCliInProc(["schedule", "exec", "mark"], projectDir);
    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(fs.readFileSync(path.join(projectDir, "marker.txt"), "utf8")).toBe("ok");
    const spec = readScheduleSpec(projectDir, "mark");
    expect(spec.runs).toBe(1);
    expect(spec.lastRun).toMatchObject({ ok: true, exitCode: 0 });
    const log = fs.readFileSync(scheduleLogPath(projectDir, "mark"), "utf8");
    expect(log).toContain("exit 0");
    expect(log).toContain("status ok");
  });

  it("logs captured stdout and stderr from arbitrary commands without surfacing them", async () => {
    const projectDir = tmpProject();
    await addEvery(projectDir, "loud", [
      process.execPath,
      "-e",
      "process.stdout.write('stdout note\\n'); process.stderr.write('stderr note\\n'); process.exit(7)",
    ]);

    const res = await runCliInProc(["schedule", "exec", "loud"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(readScheduleSpec(projectDir, "loud").lastRun).toMatchObject({ ok: false, exitCode: 7 });
    const log = fs.readFileSync(scheduleLogPath(projectDir, "loud"), "utf8");
    expect(log).toContain("exit 7");
    expect(log).toContain("status failed");
    expect(log).toContain("stderr:");
    expect(log).toContain("stderr note");
    expect(log).toContain("stdout:");
    expect(log).toContain("stdout note");
  });

  it.skipIf(!distBuilt)("logs run --json validation stderr without surfacing it", async () => {
    const projectDir = tmpProject();
    fs.writeFileSync(path.join(projectDir, "bad.js"), "return 1;\n", "utf8");
    const add = await runCliInProc(
      ["schedule", "add", "badrun", "--every", "5m", "--", "run", "bad.js"],
      projectDir,
    );
    expect(add.code).toBe(0);
    const spec = readScheduleSpec(projectDir, "badrun");
    spec.cliPath = distCli;
    writeScheduleSpec(spec);

    const res = await runCliInProc(["schedule", "exec", "badrun"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    const log = fs.readFileSync(scheduleLogPath(projectDir, "badrun"), "utf8");
    expect(log).toContain("exit 1");
    expect(log).toContain("status failed");
    expect(log).toContain("stderr:");
    expect(log).toContain("validation failed");
    expect(log).toContain("first statement must be");
  });

  it("skips when the lock is held by a live pid", async () => {
    const projectDir = tmpProject();
    await addEvery(projectDir, "locked");
    fs.writeFileSync(scheduleLockPath(projectDir, "locked"), String(process.pid), "utf8");

    const res = await runCliInProc(["schedule", "exec", "locked"], projectDir);
    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(readScheduleSpec(projectDir, "locked").runs).toBe(0);
    expect(fs.readFileSync(scheduleLogPath(projectDir, "locked"), "utf8")).toContain(
      "skipped: previous run still active",
    );
  });

  it("does not steal an empty lock that becomes a live pid during the settle window", async () => {
    const projectDir = tmpProject();
    const marker = path.join(projectDir, "marker.txt");
    await addEvery(projectDir, "settle", [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
    const lockPath = scheduleLockPath(projectDir, "settle");
    fs.writeFileSync(lockPath, "", "utf8");
    const holder = spawn(
      process.execPath,
      [
        "-e",
        [
          "const fs = require('node:fs')",
          `const lockPath = ${JSON.stringify(lockPath)}`,
          "if (process.send) process.send('ready')",
          "setTimeout(() => fs.writeFileSync(lockPath, `${process.pid}\\n`, 'utf8'), 25)",
          "setInterval(() => {}, 1000)",
        ].join(";"),
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    children.push(holder);
    await waitForReady(holder);

    const res = await runCliInProc(["schedule", "exec", "settle"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(fs.existsSync(marker)).toBe(false);
    expect(readScheduleSpec(projectDir, "settle").runs).toBe(0);
    expect(Number(fs.readFileSync(lockPath, "utf8").trim())).toBe(holder.pid);
    expect(fs.readFileSync(scheduleLogPath(projectDir, "settle"), "utf8")).toContain(
      "skipped: previous run still active",
    );
  });

  it("reaps a pidless stale-lock steal claim and runs after stealing a dead lock", async () => {
    const projectDir = tmpProject();
    const marker = path.join(projectDir, "marker.txt");
    await addEvery(projectDir, "pidless", [
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
    const lockPath = scheduleLockPath(projectDir, "pidless");
    fs.writeFileSync(lockPath, "999999999\n", "utf8");
    fs.mkdirSync(`${lockPath}.steal`);

    const res = await runCliInProc(["schedule", "exec", "pidless"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(fs.readFileSync(marker, "utf8")).toBe("ran");
    expect(readScheduleSpec(projectDir, "pidless").runs).toBe(1);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.steal`)).toBe(false);
    expect(fs.readFileSync(scheduleLogPath(projectDir, "pidless"), "utf8")).toContain("exit 0");
  });

  it("exits 1 silently when the spec cannot be read", async () => {
    const projectDir = tmpProject();

    const res = await runCliInProc(["schedule", "exec", "missing"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 1 });
  });

  it("skips paused schedules without stdout or stderr", async () => {
    const projectDir = tmpProject();
    await addEvery(projectDir, "paused");
    await runCliInProc(["schedule", "pause", "paused"], projectDir);

    const res = await runCliInProc(["schedule", "exec", "paused"], projectDir);
    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(readScheduleSpec(projectDir, "paused").runs).toBe(0);
    expect(fs.readFileSync(scheduleLogPath(projectDir, "paused"), "utf8")).toContain("skipped: paused");
  });

  it.skipIf(!distBuilt)("does not recreate a spec removed by the manager during active exec", async () => {
    const projectDir = tmpProject();
    await addEvery(projectDir, "remove-self", [
      process.execPath,
      distCli,
      "schedule",
      "rm",
      "remove-self",
    ]);

    const res = await runCliInProc(["schedule", "exec", "remove-self"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(fs.existsSync(scheduleSpecPath(projectDir, "remove-self"))).toBe(false);
    expect(readCrontabFile()).not.toContain(scheduleTag(projectDir, "remove-self"));
    expect(fs.readFileSync(scheduleLogPath(projectDir, "remove-self"), "utf8")).toContain("removed");
  });

  it.skipIf(!distBuilt)("preserves pause state written by the manager during active exec", async () => {
    const projectDir = tmpProject();
    await addEvery(projectDir, "pause-self", [
      process.execPath,
      distCli,
      "schedule",
      "pause",
      "pause-self",
    ]);

    const res = await runCliInProc(["schedule", "exec", "pause-self"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    const spec = readScheduleSpec(projectDir, "pause-self");
    expect(spec.status).toBe("paused");
    expect(spec.runs).toBe(1);
    expect(spec.lastRun).toMatchObject({ ok: true, exitCode: 0 });
    expect(readCrontabFile()).not.toContain(scheduleTag(projectDir, "pause-self"));
  });

  it("keeps hidden exec quiet when the run log cannot be appended", async () => {
    const projectDir = tmpProject();
    await addEvery(projectDir, "badlog");
    fs.mkdirSync(scheduleLogPath(projectDir, "badlog"));

    const res = await runCliInProc(["schedule", "exec", "badlog"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    const spec = readScheduleSpec(projectDir, "badlog");
    expect(spec.runs).toBe(1);
    expect(spec.lastRun).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("keeps hidden exec quiet when the spec write fails after a run", async () => {
    const projectDir = tmpProject();
    const specPath = scheduleSpecPath(projectDir, "writefail");
    await addEvery(projectDir, "writefail", [
      process.execPath,
      "-e",
      [
        "const fs=require('node:fs')",
        `fs.rmSync(${JSON.stringify(specPath)}, { force: true })`,
        `fs.mkdirSync(${JSON.stringify(specPath)})`,
      ].join(";"),
    ]);

    const res = await runCliInProc(["schedule", "exec", "writefail"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    expect(fs.readFileSync(scheduleLogPath(projectDir, "writefail"), "utf8")).toContain("error: spec update:");
  });

  it("retires --until-done schedules when run --json returns an object with done true", async () => {
    const projectDir = tmpProject();
    fs.writeFileSync(path.join(projectDir, "wf.js"), "export const meta = { name: 'wf' };\nreturn { done: true };\n");
    const add = await runCliInProc(
      ["schedule", "add", "done", "--every", "5m", "--until-done", "--", "run", "wf.js"],
      projectDir,
    );
    expect(add.code).toBe(0);
    const stub = path.join(projectDir, "stub-cli.cjs");
    fs.writeFileSync(
      stub,
      "process.stdout.write(JSON.stringify({ status: 'ok', result: 123, done: true }) + '\\n');\n",
      "utf8",
    );
    const spec = readScheduleSpec(projectDir, "done");
    spec.cliPath = stub;
    writeScheduleSpec(spec);

    const res = await runCliInProc(["schedule", "exec", "done"], projectDir);
    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    const retired = readScheduleSpec(projectDir, "done");
    expect(retired.status).toBe("retired");
    expect(retired.retiredReason).toBe("done");
    expect(retired.lastRun?.done).toBe(true);
    expect(readCrontabFile()).not.toContain(scheduleTag(projectDir, "done"));
    expect(fs.readFileSync(scheduleLogPath(projectDir, "done"), "utf8")).toContain("retired: done");
  });

  it("keeps hidden exec quiet when retirement cannot update crontab", async () => {
    const projectDir = tmpProject();
    const add = await runCliInProc(
      ["schedule", "add", "badretire", "--every", "5m", "--max-runs", "1", "--", process.execPath, "-e", "process.exit(0)"],
      projectDir,
    );
    expect(add.code).toBe(0);
    const badCrontab = path.join(projectDir, "crontab-dir");
    fs.mkdirSync(badCrontab);
    process.env.ULTRACODEX_CRONTAB_FILE = badCrontab;

    const res = await runCliInProc(["schedule", "exec", "badretire"], projectDir);

    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    const spec = readScheduleSpec(projectDir, "badretire");
    expect(spec.status).toBe("retired");
    expect(spec.retiredReason).toBe("max-runs");
    const log = fs.readFileSync(scheduleLogPath(projectDir, "badretire"), "utf8");
    expect(log).toContain("error: retire max-runs:");
    expect(log).toContain("retired: max-runs");
  });

  it.skipIf(!distBuilt)("serializes concurrent stale-lock stealers so only one command executes", async () => {
    const projectDir = tmpProject();
    const marker = path.join(projectDir, "marker.txt");
    await addEvery(projectDir, "race", [
      process.execPath,
      "-e",
      [
        "const fs=require('node:fs')",
        `fs.appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n')`,
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250)",
      ].join(";"),
    ]);
    fs.writeFileSync(scheduleLockPath(projectDir, "race"), "999999999\n", "utf8");

    const helper = path.join(projectDir, "exec-helper.mjs");
    fs.writeFileSync(
      helper,
      [
        `import { main } from ${JSON.stringify(pathToFileURL(distCli).href)};`,
        "const [, , name] = process.argv;",
        "if (!process.send) throw new Error('IPC unavailable');",
        "const started = new Promise((resolve) => process.once('message', (msg) => { if (msg === 'start') resolve(); }));",
        "process.send('ready');",
        "await started;",
        "await main(['node', 'ultracodex', 'schedule', 'exec', name]);",
      ].join("\n"),
      "utf8",
    );

    const spawned = Array.from({ length: 12 }, () => {
      const child = spawn(process.execPath, [helper, "race"], {
        cwd: projectDir,
        env: { ...process.env, ULTRACODEX_CRONTAB_FILE: crontabFile() },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      children.push(child);
      return child;
    });
    const exits = spawned.map(waitForChild);
    await Promise.all(spawned.map(waitForReady));
    for (const child of spawned) child.send("start");

    const results = await Promise.all(exits);
    expect(results.map((r) => r.code)).toEqual(spawned.map(() => 0));
    expect(results.map((r) => r.stdout).join("")).toBe("");
    expect(results.map((r) => r.stderr).join("")).toBe("");
    expect(fs.readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readScheduleSpec(projectDir, "race").runs).toBe(1);
  });

  it("retires schedules at max-runs", async () => {
    const projectDir = tmpProject();
    const add = await runCliInProc(
      ["schedule", "add", "once", "--every", "5m", "--max-runs", "1", "--", process.execPath, "-e", "process.exit(0)"],
      projectDir,
    );
    expect(add.code).toBe(0);

    const res = await runCliInProc(["schedule", "exec", "once"], projectDir);
    expect(res).toEqual({ stdout: "", stderr: "", code: 0 });
    const spec = readScheduleSpec(projectDir, "once");
    expect(spec.status).toBe("retired");
    expect(spec.retiredReason).toBe("max-runs");
    expect(spec.runs).toBe(1);
    expect(readCrontabFile()).not.toContain(scheduleTag(projectDir, "once"));
  });
});

describe("missed-run nudges", () => {
  it("warns for overdue every/daily schedules, fresh schedules stay quiet, and raw cron is exempt", () => {
    const projectDir = tmpProject();
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    writeScheduleSpec(
      newScheduleSpec({
        name: "overdue-every",
        schedule: { kind: "every", value: "10m" },
        cronExpr: "*/10 * * * *",
        command: ["node"],
        projectDir,
        untilDone: false,
        maxRuns: null,
        nodeBin: process.execPath,
        cliPath: "/tmp/cli.js",
        pathEnv: "",
        now: new Date(now - 16 * 60_000),
      }),
    );
    writeScheduleSpec(
      newScheduleSpec({
        name: "fresh",
        schedule: { kind: "every", value: "10m" },
        cronExpr: "*/10 * * * *",
        command: ["node"],
        projectDir,
        untilDone: false,
        maxRuns: null,
        nodeBin: process.execPath,
        cliPath: "/tmp/cli.js",
        pathEnv: "",
        now: new Date(now - 10 * 60_000),
      }),
    );
    writeScheduleSpec(
      newScheduleSpec({
        name: "overdue-daily",
        schedule: { kind: "daily", value: "12:00" },
        cronExpr: "0 12 * * *",
        command: ["node"],
        projectDir,
        untilDone: false,
        maxRuns: null,
        nodeBin: process.execPath,
        cliPath: "/tmp/cli.js",
        pathEnv: "",
        now: new Date(now - 37 * 60 * 60_000),
      }),
    );
    writeScheduleSpec(
      newScheduleSpec({
        name: "raw",
        schedule: { kind: "cron", value: "7 8 * * 1" },
        cronExpr: "7 8 * * 1",
        command: ["node"],
        projectDir,
        untilDone: false,
        maxRuns: null,
        nodeBin: process.execPath,
        cliPath: "/tmp/cli.js",
        pathEnv: "",
        now: new Date(now - 365 * 24 * 60 * 60_000),
      }),
    );

    const warnings = checkMissedSchedules(projectDir, now);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("overdue-every");
    expect(warnings.join("\n")).toContain("overdue-daily");
    expect(warnings.join("\n")).not.toContain("fresh");
    expect(warnings.join("\n")).not.toContain("raw");
  });
});
