import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProgram } from "../src/cli.js";
import {
  renderCrontabLine,
  scheduleTag,
} from "../src/schedule/crontab.js";
import {
  checkMissedSchedules,
  newScheduleSpec,
  readScheduleSpec,
  scheduleLockPath,
  scheduleLogPath,
  scheduleSpecPath,
  writeScheduleSpec,
} from "../src/schedule/spec.js";

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
    await runCliInProc(["schedule", "add", "minutely", "--every", "17m", "--", "node"], projectDir);
    await runCliInProc(["schedule", "add", "hourly", "--every", "6h", "--", "node"], projectDir);
    await runCliInProc(["schedule", "add", "daily", "--daily", "18:30", "--", "node"], projectDir);
    expect(readScheduleSpec(projectDir, "minutely").cronExpr).toBe("*/17 * * * *");
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
