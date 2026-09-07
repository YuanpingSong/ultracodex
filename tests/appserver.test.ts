import { describe, it, expect, afterEach, vi } from "vitest";
import { Ajv } from "ajv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerClient, RpcError } from "../src/appserver/client.js";
import { runTurn, type RunTurnOptions } from "../src/appserver/turn.js";
import { INFER_COMPLETION_MS, TURN_START_REQUEST_TIMEOUT_MS, TURN_INACTIVITY_TIMEOUT_MS } from "../src/constants.js";
import { fakeCodexPath } from "./helpers.js";
import type { ActivityEvent, Usage } from "../src/types.js";

const clients: AppServerClient[] = [];
const dirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-appserver-"));
  dirs.push(d);
  return d;
}

async function startClient(env?: Record<string, string>): Promise<AppServerClient> {
  const client = await AppServerClient.start({
    binary: fakeCodexPath(),
    cwd: tmpDir(),
    env: { ...process.env, ...env },
  });
  clients.push(client);
  return client;
}

async function startThread(client: AppServerClient): Promise<string> {
  const res = await client.request<{ thread: { id: string } }>("thread/start", {
    cwd: os.tmpdir(),
    approvalPolicy: "never",
    sandbox: "workspace-write",
    ephemeral: false,
  });
  return res.thread.id;
}

function turnOn(client: AppServerClient, threadId: string, prompt: string, extra?: Partial<RunTurnOptions>) {
  const activities: ActivityEvent[] = [];
  const usages: Usage[] = [];
  const ac = new AbortController();
  const promise = runTurn({
    client,
    threadId,
    prompt,
    model: null,
    effort: null,
    signal: ac.signal,
    onActivity: (ev) => activities.push(ev),
    onUsage: (u) => usages.push(u),
    ...extra,
  });
  return { promise, activities, usages, ac };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) {
    try {
      await c.close();
    } catch {}
  }
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true });
    } catch {}
  }
});

describe("AppServerClient", () => {
  it("performs the initialize handshake and serves account/read + model/list", async () => {
    const client = await startClient();
    expect(client.pid).toBeGreaterThan(0);

    const account = await client.request<{ account: { type: string } | null; requiresOpenaiAuth: boolean }>(
      "account/read",
      { refreshToken: false },
    );
    expect(account.account?.type).toBe("chatgpt");
    expect(account.requiresOpenaiAuth).toBe(true);

    const models = await client.request<{ data: Array<{ id: string }> }>("model/list", {});
    expect(models.data.map((m) => m.id)).toContain("gpt-5.5");
  });

  it("FAKE_CODEX_LOGGED_OUT=1 makes account/read report no account", async () => {
    const client = await startClient({ FAKE_CODEX_LOGGED_OUT: "1" });
    const account = await client.request<{ account: unknown; requiresOpenaiAuth: boolean }>("account/read", {
      refreshToken: false,
    });
    expect(account.account).toBeNull();
    expect(account.requiresOpenaiAuth).toBe(true);
  });

  it("rejects unknown methods with an RpcError carrying the code", async () => {
    const client = await startClient();
    const err = await client.request("bogus/method", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32601);
  });

  it("close() ends stdin and the process exits (no zombie)", async () => {
    const client = await startClient();
    const pid = client.pid!;
    await client.close();
    expect(await client.exited).toBe(0);
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(client.request("account/read", {})).rejects.toBeInstanceOf(RpcError);
  });

  it("kill() SIGKILLs the process immediately", async () => {
    const client = await startClient();
    const pid = client.pid!;
    client.kill();
    expect(await client.exited).toBeNull(); // signaled, no exit code
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("kill() reaps surviving process-group members after the leader already exited", async () => {
    const pidFile = path.join(tmpDir(), "child.pid");
    const client = await startClient({ FAKE_CODEX_ORPHAN_CHILD: "1", FAKE_CODEX_CHILD_PID_FILE: pidFile });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const childPid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(childPid).toBeGreaterThan(0);
    expect(alive(childPid)).toBe(true);

    // Kill ONLY the leader; the group member survives it.
    process.kill(client.pid!, "SIGKILL");
    await client.exited;
    expect(alive(childPid)).toBe(true);

    client.kill(); // must kill the process GROUP even though the leader is gone
    const killDeadline = Date.now() + 3_000;
    while (alive(childPid) && Date.now() < killDeadline) await new Promise((r) => setTimeout(r, 20));
    expect(alive(childPid)).toBe(false);
  });

  it.each([
    ["item/commandExecution/requestApproval", "CommandExecutionRequestApprovalResponse", { decision: "decline" }],
    ["item/fileChange/requestApproval", "FileChangeRequestApprovalResponse", { decision: "decline" }],
    ["applyPatchApproval", "ApplyPatchApprovalResponse", { decision: "denied" }],
    ["execCommandApproval", "ExecCommandApprovalResponse", { decision: "denied" }],
    ["item/tool/requestUserInput", "ToolRequestUserInputResponse", { answers: {} }],
    ["item/permissions/requestApproval", "PermissionsRequestApprovalResponse", { permissions: {}, scope: "turn" }],
  ])("refuses %s with a schema-valid response and surfaces the request", async (method, schemaName, expected) => {
    const client = await startClient();
    const seen: string[] = [];
    client.onNotification((method) => seen.push(method));
    const threadId = await startThread(client);
    const { promise } = turnOn(client, threadId, `please [[approval:${method}]]`);
    const result = await promise;
    expect(result.status).toBe("completed");
    // The fake echoes the complete response, including the original string id.
    const response = JSON.parse(result.finalText!);
    expect(response).toEqual({ jsonrpc: "2.0", id: "approval-9001", result: expected });
    const schema = JSON.parse(fs.readFileSync(new URL(`../fixtures/appserver/schema/${schemaName}.json`, import.meta.url), "utf8"));
    const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
    expect(validate(response.result), JSON.stringify(validate.errors)).toBe(true);
    expect(seen).toContain(method);
  });

  it("returns method-not-supported for unknown server requests", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const result = await turnOn(client, threadId, "[[approval:unknown/approval]]").promise;
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.finalText!)).toEqual({
      jsonrpc: "2.0", id: "approval-9001",
      error: { code: -32601, message: "Unsupported server request: unknown/approval" },
    });
  });

  it("warns on malformed JSON, non-objects and handler exceptions, then continues routing", async () => {
    const client = await startClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("broken consumer");
    client.onNotification(() => { throw failure; });
    const seen = vi.fn();
    client.onNotification(seen);
    await client.request("fake/emit", {
      lines: ["{broken", "null", "42", "true", '"text"', "[]"],
      notifications: [{ method: "test/activity", params: { value: 1 } }],
    });
    expect(warn).toHaveBeenCalledWith("app-server: malformed JSON on stdout", expect.any(SyntaxError));
    expect(warn.mock.calls.filter(([message]) => message === "app-server: ignoring non-object message on stdout")).toHaveLength(5);
    expect(warn).toHaveBeenCalledWith("app-server: notification handler failed (test/activity)", failure);
    expect(seen).toHaveBeenCalledWith("test/activity", { value: 1 });
    const threadId = await startThread(client);
    expect((await turnOn(client, threadId, "[[reply:still healthy]]").promise).finalText).toBe("still healthy");
  });
});

describe("runTurn", () => {
  it("bounds only the start request, even when start notifications were buffered", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    vi.useFakeTimers();
    const { promise } = turnOn(client, threadId, "[[stall-start]]");
    const done = vi.fn();
    void promise.then(done);
    await client.request("fake/emit", {}); // all preceding start notifications received
    await vi.advanceTimersByTimeAsync(TURN_START_REQUEST_TIMEOUT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ status: "failed", error: `turn/start timed out after ${TURN_START_REQUEST_TIMEOUT_MS}ms` });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails an accepted turn only after five minutes of silence and removes its timer", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    vi.useFakeTimers();
    const { promise } = turnOn(client, threadId, "[[silent]]");
    const done = vi.fn();
    void promise.then(done);
    await client.request("fake/emit", {});
    await vi.advanceTimersByTimeAsync(TURN_INACTIVITY_TIMEOUT_MS - 1);
    expect(done).not.toHaveBeenCalled(); // already far beyond the start request bound
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ status: "failed", error: expect.stringContaining("no notifications for 300000ms") });
    expect(vi.getTimerCount()).toBe(0);
    await client.request("fake/emit", { notifications: [{ method: "test/activity", params: { threadId } }] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews on every kind of matching notification through a long healthy turn", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    let turnId = "";
    client.onNotification((method, params: any) => {
      if (method === "turn/started" && params.threadId === threadId) turnId = params.turn.id;
    });
    vi.useFakeTimers();
    const { promise } = turnOn(client, threadId, "[[silent]]");
    const done = vi.fn();
    void promise.then(done);
    await client.request("fake/emit", {});
    const notifications = [
      { method: "item/reasoning/textDelta", params: { threadId, turnId, delta: "thinking" } },
      { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: { totalTokens: 10 } } } },
      { method: "item/started", params: { threadId, turnId, item: { type: "reasoning", summary: [] } } },
      { method: "thread/name/updated", params: { threadId, threadName: "working" } },
      { method: "future/activity", params: { threadId, turnId } },
      { method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } },
      { method: "item/reasoning/textDelta", params: { threadId: "child", turnId: "child-turn", delta: "working" } },
    ];
    // Register the child before advancing: its initial thread announcement isn't
    // yet a matching notification. All subsequent notifications renew the timer.
    await client.request("fake/emit", { notifications: [{ method: "thread/started", params: { thread: { id: "child" } } }] });
    for (const notification of notifications) {
      await vi.advanceTimersByTimeAsync(TURN_INACTIVITY_TIMEOUT_MS - 1);
      expect(done).not.toHaveBeenCalled();
      await client.request("fake/emit", { notifications: [notification] });
    }
    await vi.advanceTimersByTimeAsync(TURN_INACTIVITY_TIMEOUT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await client.request("fake/emit", { notifications: [
      { method: "turn/completed", params: { threadId: "child", turn: { id: "child-turn", status: "completed" } } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } },
    ] });
    expect((await promise).status).toBe("completed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("foreign threads and stale parent turns neither renew silence nor replace the tracked turn", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    vi.useFakeTimers();
    const { promise, activities } = turnOn(client, threadId, "[[silent]]");
    await client.request("fake/emit", {});
    await vi.advanceTimersByTimeAsync(TURN_INACTIVITY_TIMEOUT_MS - 1);
    await client.request("fake/emit", { notifications: [
      { method: "turn/started", params: { threadId: "foreign", turn: { id: "foreign-turn" } } },
      { method: "turn/started", params: { threadId, turn: { id: "stale-turn" } } },
      { method: "item/completed", params: { threadId, turnId: "stale-turn", item: { type: "agentMessage", text: "foreign", phase: "final_answer" } } },
      { method: "turn/completed", params: { threadId, turn: { id: "stale-turn", status: "completed" } } },
    ] });
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ status: "failed", finalText: null, error: expect.stringContaining("inactive") });
    expect(activities).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts silence from the last notification after renewing the watchdog", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    vi.useFakeTimers();
    const { promise } = turnOn(client, threadId, "[[silent]]");
    const done = vi.fn();
    void promise.then(done);
    await client.request("fake/emit", {});
    await vi.advanceTimersByTimeAsync(TURN_INACTIVITY_TIMEOUT_MS - 1);
    await client.request("fake/emit", { notifications: [{ method: "future/activity", params: { threadId } }] });
    await vi.advanceTimersByTimeAsync(TURN_INACTIVITY_TIMEOUT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await promise).toMatchObject({ status: "failed", error: expect.stringContaining("inactive") });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completes a simple turn (turn/started arrives before the turn/start response)", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const { promise, usages } = turnOn(client, threadId, "say hi [[reply:hello world]]");
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("hello world");
    expect(result.turnId).toBeTruthy();
    expect(result.error).toBeNull();
    expect(result.usage).toEqual({
      totalTokens: 110,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
    });
    expect(usages.length).toBeGreaterThanOrEqual(1);
  });

  it("[[reply2:...]] answers the thread's second turn (schema-repair shape)", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const prompt = "[[reply:first answer]] [[reply2:second answer]]";
    const first = await turnOn(client, threadId, prompt).promise;
    expect(first.finalText).toBe("first answer");
    const second = await turnOn(client, threadId, prompt).promise;
    expect(second.finalText).toBe("second answer");
    // Second turn's usage is ITS OWN delta, not the thread-cumulative total.
    expect(second.usage.totalTokens).toBe(110);
    expect(second.usage.inputTokens).toBe(100);
  });

  it("maps commandExecution items to exec activity with running phase", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const { promise, activities } = turnOn(client, threadId, "[[exec:echo hi]] [[reply:done]]");
    await promise;
    const exec = activities.find((a) => a.kind === "exec" && a.text.startsWith("Running command:"));
    expect(exec).toBeDefined();
    expect(exec!.text).toContain("echo hi");
    expect(exec!.phase).toBe("running");
  });

  it("flags verification commands as verifying", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const { promise, activities } = turnOn(client, threadId, "[[exec:pnpm test]] [[reply:done]]");
    await promise;
    const exec = activities.find((a) => a.kind === "exec");
    expect(exec?.phase).toBe("verifying");
  });

  it("captures usage from [[usage:IN,OUT]]", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const { promise, usages } = turnOn(client, threadId, "[[reply:ok]] [[usage:1234,56]]");
    const result = await promise;
    expect(result.usage.inputTokens).toBe(1234);
    expect(result.usage.outputTokens).toBe(56);
    expect(result.usage.totalTokens).toBe(1290);
    expect(usages.at(-1)).toEqual(result.usage);
  });

  it("accumulates usage across multiple tokenUsage updates in one multi-step turn", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const { promise, usages } = turnOn(client, threadId, "[[midusage:50,5]] [[usage:100,10]] [[reply:multi]]");
    const result = await promise;
    expect(result.status).toBe("completed");
    // 50+5 from the mid-turn request PLUS 100+10 from the final request.
    expect(result.usage).toEqual({
      totalTokens: 165,
      inputTokens: 150,
      cachedInputTokens: 0,
      outputTokens: 15,
      reasoningOutputTokens: 0,
    });
    expect(usages.length).toBeGreaterThanOrEqual(2);
    expect(usages.at(-1)).toEqual(result.usage);
  });

  it("ignores error notifications with willRetry:true and still completes", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const { promise, activities } = turnOn(client, threadId, "[[retry-error:rate limited]] [[reply:recovered]]");
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("recovered");
    expect(result.error).toBeNull();
    expect(activities.some((a) => a.kind === "status" && a.text.includes("rate limited"))).toBe(true);
  });

  it("subagent-thread errors do not fail the MAIN turn", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const result = await turnOn(client, threadId, "[[suberror:sub exploded]] [[reply:main ok]]").promise;
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("main ok");
    expect(result.error).toBeNull();
  });

  it("[[fail:msg]] resolves failed with the error message", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const result = await turnOn(client, threadId, "[[fail:boom went the server]]").promise;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom went the server");
    expect(result.finalText).toBeNull();
  });

  it("infers completion when turn/completed never arrives", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const start = Date.now();
    const result = await turnOn(client, threadId, "[[reply:inferred]] [[no-turn-completed]]").promise;
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("inferred");
    expect(Date.now() - start).toBeGreaterThanOrEqual(200); // waited for the inference timer
  });

  it("drains pending collabs + subagent turns before inferring completion", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const start = Date.now();
    const { promise, activities } = turnOn(client, threadId, "[[collab]] [[no-turn-completed]] [[reply:collab-final]]");
    const result = await promise;
    const elapsed = Date.now() - start;
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("collab-final");
    // final answer arrives immediately, but the collab drains 150ms later and
    // only then may the 250ms inference timer run: >= 400ms total.
    expect(elapsed).toBeGreaterThanOrEqual(390);
    expect(activities.some((a) => a.kind === "tool")).toBe(true);
  });

  it("abort signal sends turn/interrupt and resolves interrupted", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const { promise, ac } = turnOn(client, threadId, "[[slow:500]] [[reply:never delivered]]");
    setTimeout(() => ac.abort(), 60);
    const start = Date.now();
    const result = await promise;
    expect(result.status).toBe("interrupted");
    expect(result.finalText).toBeNull();
    expect(Date.now() - start).toBeLessThan(450); // interrupted well before the slow reply
  });

  it("awaits a child's second turn and ignores late completion from its first turn", async () => {
    const client = await startClient();
    const threadId = await startThread(client);
    const completed: string[] = [];
    client.onNotification((method, params: any) => {
      if (method === "turn/completed" && params.threadId !== threadId) completed.push(params.turn.id);
    });
    const start = Date.now();
    const { promise, activities } = turnOn(client, threadId, "[[collab-twice]] [[no-turn-completed]] [[reply:parent final]]");
    const result = await promise;
    expect(result).toMatchObject({ status: "completed", finalText: "parent final" });
    expect(new Set(completed).size).toBe(2);
    expect(activities.some((a) => a.text.includes("child second turn done"))).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150 + 400 + INFER_COMPLETION_MS - 10);
  });

  it("server crash mid-turn resolves failed without hanging", async () => {
    const client = await startClient({ FAKE_CODEX_CRASH_MID_TURN: "1" });
    const threadId = await startThread(client);
    const result = await turnOn(client, threadId, "[[reply:unreachable]]").promise;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited/);
    expect(await client.exited).toBe(1);
  });
});
