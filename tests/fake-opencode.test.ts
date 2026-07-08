import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const FAKE_OPENCODE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode", "opencode");
const FORCE_ENV = [
  "FAKE_OPENCODE_INVOCATIONS",
  "FAKE_OPENCODE_SESSION_ID",
  "FAKE_OPENCODE_SOCKET_PATH",
  "FAKE_OPENCODE_STDIO_HTTP",
  "FAKE_OPENCODE_GARBAGE_BODY",
  "FAKE_OPENCODE_CRASH_MID_TURN",
  "FAKE_OPENCODE_HANG",
];

const dirs: string[] = [];
const procs: FakeProc[] = [];

interface FakeProc {
  child: ChildProcess;
  baseUrl: string;
  done: Promise<RunResult>;
  cwd: string;
  logPath: string;
  isClosed: () => boolean;
  seq: number;
  pending: Map<number, { resolve: (value: HttpResult) => void; reject: (err: unknown) => void }>;
  streams: Map<number, EventStream>;
  protocolBuf: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Invocation {
  kind: string;
  args?: string[];
  cwd?: string;
  method?: string;
  path?: string;
  body?: unknown;
}

interface HttpResult {
  status: number;
  text: string;
  json: any;
}

interface EventStream {
  id: number;
  events: any[];
  close: () => Promise<void>;
}

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-fake-opencode-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const proc of procs.splice(0)) await stopFake(proc);
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {}
  }
});

async function startFake(env: Record<string, string> = {}): Promise<FakeProc> {
  const cwd = fs.realpathSync(tmpDir());
  const logPath = path.join(cwd, "invocations.jsonl");
  const pending = new Map<number, { resolve: (value: HttpResult) => void; reject: (err: unknown) => void }>();
  const streams = new Map<number, EventStream>();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FAKE_OPENCODE_INVOCATIONS: logPath,
    FAKE_OPENCODE_STDIO_HTTP: "1",
    ...env,
  };
  for (const key of FORCE_ENV) {
    if (!(key in env) && key !== "FAKE_OPENCODE_INVOCATIONS" && key !== "FAKE_OPENCODE_STDIO_HTTP") {
      delete childEnv[key];
    }
  }

  const args = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
  const boot = [
    "const fs = require('node:fs');",
    "process.argv = " + JSON.stringify([process.execPath, FAKE_OPENCODE, ...args]) + ";",
    "let code = fs.readFileSync(" + JSON.stringify(FAKE_OPENCODE) + ", 'utf8');",
    "code = code.replace(/^#!.*\\n/, '');",
    "eval(code);",
  ].join("");
  const child = spawn(process.execPath, ["-e", boot], {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closed = false;

  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => (stdout += d));
  child.stderr!.on("data", (d: string) => (stderr += d));

  const done = new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      closed = true;
      for (const entry of pending.values()) entry.reject(new Error("fake opencode closed"));
      pending.clear();
      resolve({ stdout, stderr, code, signal });
    });
  });

  const baseUrl = await withTimeout(
    new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        child.stdout!.off("data", inspect);
        child.off("close", onClose);
        child.off("error", onError);
      };
      const inspect = () => {
        if (settled) return;
        const match = stdout.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (!match) return;
        settled = true;
        cleanup();
        resolve(match[1]!);
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`fake exited before announce: ${stderr}`));
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      child.stdout!.on("data", inspect);
      child.once("close", onClose);
      child.once("error", onError);
      inspect();
    }),
    1500,
  );

  const proc = {
    child,
    baseUrl,
    done,
    cwd,
    logPath,
    isClosed: () => closed,
    seq: 0,
    pending,
    streams,
    protocolBuf: "",
  };
  child.stdout!.on("data", (d: string) => parseProtocol(proc, d));
  procs.push(proc);
  return proc;
}

async function stopFake(proc: FakeProc): Promise<void> {
  if (proc.isClosed()) return;
  proc.child.kill("SIGTERM");
  await withTimeout(proc.done, 1500).catch(() => {
    proc.child.kill("SIGKILL");
  });
}

function parseProtocol(proc: FakeProc, chunk: string): void {
  proc.protocolBuf += chunk;
  let idx = proc.protocolBuf.indexOf("\n");
  while (idx !== -1) {
    const line = proc.protocolBuf.slice(0, idx);
    proc.protocolBuf = proc.protocolBuf.slice(idx + 1);
    if (line.startsWith("{")) {
      const msg = JSON.parse(line);
      if (msg.kind === "response") {
        const waiter = proc.pending.get(msg.id);
        proc.pending.delete(msg.id);
        if (waiter) {
          let parsed: any = null;
          try {
            parsed = JSON.parse(msg.body);
          } catch {}
          waiter.resolve({ status: msg.status, text: msg.body, json: parsed });
        }
      } else if (msg.kind === "chunk") {
        const stream = proc.streams.get(msg.id);
        if (stream) parseSse(stream, msg.chunk);
      }
    }
    idx = proc.protocolBuf.indexOf("\n");
  }
}

function parseSse(stream: EventStream, chunk: string): void {
  let buf = (stream as any).buf || "";
  buf += chunk;
  let idx = buf.indexOf("\n\n");
  while (idx !== -1) {
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const line = block.split("\n").find((v) => v.startsWith("data: "));
    if (line) stream.events.push(JSON.parse(line.slice("data: ".length)));
    idx = buf.indexOf("\n\n");
  }
  (stream as any).buf = buf;
}

function request(proc: FakeProc, method: string, pathname: string, body?: unknown): Promise<HttpResult> {
  const id = ++proc.seq;
  const msg = { kind: "request", id, method, path: pathname, body };
  return new Promise((resolve, reject) => {
    proc.pending.set(id, { resolve, reject });
    proc.child.stdin!.write(JSON.stringify(msg) + "\n");
  });
}

async function postJson(proc: FakeProc, pathname: string, body: unknown): Promise<HttpResult> {
  return request(proc, "POST", pathname, body);
}

async function getJson(proc: FakeProc, pathname: string): Promise<HttpResult> {
  return request(proc, "GET", pathname);
}

function message(
  proc: FakeProc,
  sessionID: string,
  prompt: string,
  extra: Record<string, unknown> = {},
): Promise<HttpResult> {
  return postJson(proc, `/session/${encodeURIComponent(sessionID)}/message`, {
    model: { providerID: "deepseek", modelID: "deepseek-chat" },
    parts: [{ type: "text", text: prompt }],
    ...extra,
  });
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

async function openEvents(proc: FakeProc): Promise<EventStream> {
  const id = ++proc.seq;
  const stream: EventStream = {
    id,
    events: [],
    close: async () => {
      proc.streams.delete(id);
      proc.child.stdin!.write(JSON.stringify({ kind: "close", id }) + "\n");
      await delay(0);
    },
  };
  proc.streams.set(id, stream);
  proc.child.stdin!.write(JSON.stringify({ kind: "request", id, method: "GET", path: "/event" }) + "\n");
  return stream;
}

async function waitForEvent(stream: EventStream, predicate: (event: any) => boolean): Promise<any> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const found = stream.events.find(predicate);
    if (found) return found;
    await delay(20);
  }
  expect(stream.events.find(predicate)).toBeTruthy();
}

function textPart(turn: HttpResult): any {
  return turn.json.parts.find((part: any) => part.type === "text");
}

describe("fake opencode fixture", () => {
  test("serves sessions, text and structured messages, docs, usage, and logs", async () => {
    const proc = await startFake({ FAKE_OPENCODE_SESSION_ID: "ses_direct" });

    expect((await getJson(proc, "/doc")).json).toMatchObject({ ok: true, version: "1.16.2", fake: true });

    const created = await postJson(proc, "/session", {});
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ id: "ses_direct", directory: proc.cwd, version: "1.16.2" });

    const textTurn = await message(proc, "ses_direct", "hello [[reply:hi there]] [[usage:7,3]]");
    expect(textTurn.json.info).toMatchObject({
      role: "assistant",
      finish: "stop",
      sessionID: "ses_direct",
      tokens: { total: 10, input: 7, output: 3, reasoning: 0, cache: { write: 0, read: 0 } },
    });
    expect(textPart(textTurn)).toMatchObject({ type: "text", text: "hi there" });

    const schema = { type: "object", properties: { name: { type: "string" }, score: { type: "number" } } };
    const structured = await message(
      proc,
      "ses_direct",
      'score [[structured:{"name":"Alice","score":9.5}]]',
      { format: { type: "json_schema", schema } },
    );
    expect(structured.json.info).toMatchObject({
      finish: "tool-calls",
      structured: { name: "Alice", score: 9.5 },
    });
    expect(structured.json.parts.some((part: any) => part.type === "tool" && part.tool === "StructuredOutput")).toBe(
      true,
    );

    const logs = readInvocations(proc.logPath);
    expect(logs[0]).toMatchObject({
      kind: "process",
      args: ["serve", "--port", "0", "--hostname", "127.0.0.1"],
      cwd: proc.cwd,
    });
    expect(logs.some((entry) => entry.method === "POST" && entry.path === "/session")).toBe(true);
    expect(logs.filter((entry) => entry.path?.endsWith("/message"))).toHaveLength(2);
  });

  test("wire rejection matches the live APIError subset and prompt-only follow-up succeeds", async () => {
    const proc = await startFake({ FAKE_OPENCODE_SESSION_ID: "ses_wire" });
    await postJson(proc, "/session", {});
    const prompt = '[[wire-reject]] [[structured:{"answer":"42"}]]';
    const schema = { type: "object", properties: { answer: { type: "string" } } };

    const rejected = await message(proc, "ses_wire", prompt, { format: { type: "json_schema", schema } });
    expect(rejected.json.parts).toEqual([]);
    expect(rejected.json.info.error).toMatchObject({
      name: "APIError",
      data: {
        message: "Thinking mode does not support this tool_choice",
        statusCode: 400,
      },
    });

    const fallback = await message(proc, "ses_wire", prompt);
    expect(textPart(fallback).text).toBe('{"answer":"42"}');
    expect(fallback.json.info).toMatchObject({ finish: "stop" });
    expect(fallback.json.info).not.toHaveProperty("error");
  });

  test("stages invalid-first, always-invalid, and reply2 repair control", async () => {
    const proc = await startFake();
    const schema = { type: "object", properties: { answer: { type: "string" } } };

    const invalidSession = (await postJson(proc, "/session", {})).json.id;
    const repairPrompt = '[[invalid-first]] [[structured:{"answer":"first"}]] [[structured2:{"answer":"fixed"}]]';
    const invalid = await message(proc, invalidSession, repairPrompt, { format: { type: "json_schema", schema } });
    expect(invalid.json.info.structured).toEqual({ invalid: true });
    const repaired = await message(proc, invalidSession, repairPrompt, { format: { type: "json_schema", schema } });
    expect(repaired.json.info.structured).toEqual({ answer: "fixed" });

    const alwaysSession = (await postJson(proc, "/session", {})).json.id;
    const always1 = await message(proc, alwaysSession, '[[always-invalid]] [[structured:{"answer":"ok"}]]', {
      format: { type: "json_schema", schema },
    });
    const always2 = await message(proc, alwaysSession, '[[always-invalid]] [[structured:{"answer":"ok"}]]', {
      format: { type: "json_schema", schema },
    });
    expect(always1.json.info.structured).toEqual({ invalid: true });
    expect(always2.json.info.structured).toEqual({ invalid: true });

    const textSession = (await postJson(proc, "/session", {})).json.id;
    expect(textPart(await message(proc, textSession, "[[reply:first]] [[reply2:second]]")).text).toBe("first");
    expect(textPart(await message(proc, textSession, "[[reply:first]] [[reply2:second]]")).text).toBe("second");
  });

  test("stages every typed error class", async () => {
    const proc = await startFake();
    const sessionID = (await postJson(proc, "/session", {})).json.id;
    const cases: Array<[string, string, number | null]> = [
      ["provider-auth-error", "ProviderAuthError", null],
      ["unknown-error", "UnknownError", null],
      ["message-output-length-error", "MessageOutputLengthError", null],
      ["message-aborted-error", "MessageAbortedError", null],
      ["structured-output-error", "StructuredOutputError", null],
      ["context-overflow-error", "ContextOverflowError", null],
      ["api-error", "APIError", 500],
    ];

    for (const [directive, name, statusCode] of cases) {
      const turn = await message(proc, sessionID, `[[${directive}]]`);
      expect(turn.json.parts).toEqual([]);
      expect(turn.json.info.error).toMatchObject({ name, data: { message: expect.any(String) } });
      if (statusCode !== null) expect(turn.json.info.error.data.statusCode).toBe(statusCode);
    }
  });

  test("streams SSE activity, usage ticks, and idle for completed turns", async () => {
    const proc = await startFake();
    const stream = await openEvents(proc);
    await waitForEvent(stream, (event) => event.type === "server.connected");
    const sessionID = (await postJson(proc, "/session", {})).json.id;

    const turn = await message(proc, sessionID, "stream [[reply:streamed text]] [[usage:11,4]]");
    expect(textPart(turn).text).toBe("streamed text");
    await waitForEvent(stream, (event) => event.type === "session.idle" && event.properties.sessionID === sessionID);

    expect(
      stream.events.some(
        (event) => event.type === "message.part.delta" && event.properties.delta === "streamed text",
      ),
    ).toBe(true);
    expect(
      stream.events.some(
        (event) =>
          event.type === "message.updated" &&
          event.properties.sessionID === sessionID &&
          event.properties.info?.tokens?.input === 11 &&
          event.properties.info?.tokens?.output === 4,
      ),
    ).toBe(true);
    await stream.close();
  });

  test("aborts in-flight messages and settles them with MessageAbortedError", async () => {
    const proc = await startFake();
    const sessionID = (await postJson(proc, "/session", {})).json.id;
    const pending = message(proc, sessionID, "[[hang]]");
    await delay(50);

    const abort = await postJson(proc, `/session/${sessionID}/abort`, {});
    expect(abort.json).toBe(true);

    const settled = await withTimeout(pending, 1500);
    expect(settled.json.info.error).toEqual({ name: "MessageAbortedError", data: { message: "Aborted" } });
  });

  test("stages garbage bodies through directive and env switch", async () => {
    const proc = await startFake();
    const sessionID = (await postJson(proc, "/session", {})).json.id;
    const garbage = await message(proc, sessionID, "[[garbage]]");
    expect(garbage).toMatchObject({ status: 200, text: "this is not json\n", json: null });

    const forced = await startFake({ FAKE_OPENCODE_GARBAGE_BODY: "1" });
    const forcedSession = (await postJson(forced, "/session", {})).json.id;
    const forcedGarbage = await message(forced, forcedSession, "no directive");
    expect(forcedGarbage).toMatchObject({ status: 200, text: "this is not json\n", json: null });
  });

  test("crashes mid-turn after the turn starts", async () => {
    const proc = await startFake();
    const sessionID = (await postJson(proc, "/session", {})).json.id;
    const pending = message(proc, sessionID, "[[crash-mid-turn]]").catch((err) => err);

    const result = await withTimeout(proc.done, 1500);
    expect(result.code).toBe(1);
    await pending;
  });

  test("hangs indefinitely until SIGTERM and exits promptly", async () => {
    const proc = await startFake();
    const sessionID = (await postJson(proc, "/session", {})).json.id;
    const pending = message(proc, sessionID, "[[hang]]").catch((err) => err);
    await delay(50);

    const started = Date.now();
    proc.child.kill("SIGTERM");
    const result = await withTimeout(proc.done, 1500);

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ code: 0, signal: null });
    await pending;
  });
});
