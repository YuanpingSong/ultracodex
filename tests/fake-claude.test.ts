import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude", "claude");
const FORCE_ENV = [
  "FAKE_CLAUDE_GARBAGE_STDOUT",
  "FAKE_CLAUDE_EMPTY_STDERR_EXIT",
  "FAKE_CLAUDE_CRASH_MID_CALL",
  "FAKE_CLAUDE_HANG",
  "FAKE_CLAUDE_ORPHAN_CHILD",
  "FAKE_CLAUDE_CHILD_PID_FILE",
];

const dirs: string[] = [];

interface Invocation {
  args: string[];
  stdin: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  logPath: string;
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-fake-claude-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {}
  }
});

function startFake(
  prompt: string,
  args = ["-p", "--output-format", "json"],
  env: Record<string, string> = {},
): {
  child: ChildProcessWithoutNullStreams;
  done: Promise<RunResult>;
  isClosed: () => boolean;
  logPath: string;
} {
  const dir = tmpDir();
  const logPath = path.join(dir, "invocations.jsonl");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, FAKE_CLAUDE_INVOCATIONS: logPath, ...env };
  for (const key of FORCE_ENV) {
    if (!(key in env)) delete childEnv[key];
  }

  const child = spawn(FAKE_CLAUDE, args, { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let closed = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => (stderr += d));
  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      closed = true;
      resolve({ stdout, stderr, code, signal, logPath });
    });
  });
  child.stdin.end(prompt);
  return { child, done, isClosed: () => closed, logPath };
}

async function runFake(
  prompt: string,
  args = ["-p", "--output-format", "json"],
  env: Record<string, string> = {},
): Promise<RunResult> {
  return startFake(prompt, args, env).done;
}

function readInvocations(logPath: string): Invocation[] {
  return fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Invocation)
    : [];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForInvocations(logPath: string, count: number): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    if (readInvocations(logPath).length >= count) return;
    await delay(20);
  }
  expect(readInvocations(logPath)).toHaveLength(count);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

describe("fake claude fixture", () => {
  test("emits success envelopes, usage overrides, and invocation logs", async () => {
    const prompt = "hello [[reply:hi there]] [[usage:7,3,2]]";
    const args = ["-p", "--output-format", "json", "--model", "sonnet"];
    const res = await runFake(prompt, args);

    expect(res.code).toBe(0);
    expect(res.stderr).toBe("");
    expect(JSON.parse(res.stdout)).toEqual({
      type: "result",
      subtype: "success",
      result: "hi there",
      session_id: "sess-abc123",
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 },
    });
    expect(readInvocations(res.logPath)).toEqual([{ args, stdin: prompt }]);
  });

  test("handles missing sessions and resume-aware repair replies", async () => {
    const first = JSON.parse((await runFake("compute [[invalid-first]]")).stdout);
    expect(first.session_id).toBe("sess-abc123");
    expect(first.result).toContain("prose without any braces");

    const repair = JSON.parse(
      (
        await runFake("repair this", ["-p", "--output-format", "json", "--resume", "sess-abc123"])
      ).stdout,
    );
    expect(repair.result).toBe('{"answer":"42"}');

    const noSession = JSON.parse((await runFake("[[nosession]] [[reply:ok]]")).stdout);
    expect(noSession).not.toHaveProperty("session_id");
  });

  test("keeps always-invalid prompts invalid even on repair calls", async () => {
    const res = await runFake("[[always-invalid]] not valid JSON", [
      "-p",
      "--output-format",
      "json",
      "--resume",
      "sess-abc123",
    ]);
    expect(JSON.parse(res.stdout).result).toBe("still not json, sorry");
  });

  test("stages error, bad-subtype, and missing-result envelopes", async () => {
    const failed = JSON.parse((await runFake("[[fail:boom]]")).stdout);
    expect(failed).toMatchObject({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "sess-fail",
      error: "boom",
    });
    expect(failed).not.toHaveProperty("result");

    const badSubtype = JSON.parse((await runFake("[[bad-subtype:rate_limited]]")).stdout);
    expect(badSubtype).toMatchObject({
      type: "result",
      subtype: "rate_limited",
      is_error: false,
      result: "bad subtype result",
    });

    const missing = JSON.parse((await runFake("[[missing-result]]")).stdout);
    expect(missing).toMatchObject({ type: "result", subtype: "success" });
    expect(missing).not.toHaveProperty("result");
  });

  test("checks expected prompt text outside fake directives", async () => {
    const ok = JSON.parse((await runFake("prefix marker [[expect-prompt:marker]] [[reply:ok]]")).stdout);
    expect(ok).toMatchObject({ subtype: "success", result: "ok" });

    const failed = JSON.parse((await runFake("[[expect-prompt:missing]] [[reply:ok]]")).stdout);
    expect(failed).toMatchObject({
      subtype: "error_during_execution",
      is_error: true,
      error: 'expected prompt to contain "missing"',
    });
  });

  test("stages garbage stdout", async () => {
    const res = await runFake("[[garbage]]");
    expect(res).toMatchObject({ code: 0, stdout: "this is not json\n", stderr: "" });
  });

  test("stages empty stdout with nonzero exit and stderr", async () => {
    const res = await runFake("[[empty-error:stderr boom]]");
    expect(res).toMatchObject({ code: 1, stdout: "", stderr: "stderr boom\n" });
  });

  test("stages mid-call crashes with partial stdout", async () => {
    const res = await runFake("[[crash-mid-call]]");
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('{"type":"result","subtype":"success"');
    expect(res.stderr).toContain("crashed mid-call");
  });

  test("honors env-var process switches", async () => {
    const res = await runFake("no directive", undefined, {
      FAKE_CLAUDE_EMPTY_STDERR_EXIT: "env stderr",
    });
    expect(res).toMatchObject({ code: 1, stdout: "", stderr: "env stderr\n" });
  });

  test("delays slow responses", async () => {
    const start = Date.now();
    const res = await runFake("[[slow:25]] [[reply:slow ok]]");
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    expect(JSON.parse(res.stdout).result).toBe("slow ok");
  });

  test("hangs indefinitely until SIGTERM, then exits promptly", async () => {
    const proc = startFake("[[hang]]");
    await waitForInvocations(proc.logPath, 1);
    expect(proc.isClosed()).toBe(false);

    const started = Date.now();
    proc.child.kill("SIGTERM");
    const res = await withTimeout(proc.done, 1500);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("");
    expect(readInvocations(res.logPath)).toHaveLength(1);
  });
});
