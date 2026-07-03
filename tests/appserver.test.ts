import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AppServerClient, RpcError } from "../src/appserver/client.js";
import { runTurn, type RunTurnOptions } from "../src/appserver/turn.js";
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

  it("auto-denies server->client requests and surfaces them via onNotification", async () => {
    const client = await startClient();
    const seen: string[] = [];
    client.onNotification((method) => seen.push(method));
    const threadId = await startThread(client);
    const { promise } = turnOn(client, threadId, "please [[approval]]");
    const result = await promise;
    expect(result.status).toBe("completed");
    // The fake embeds the decision it received in its final answer.
    expect(result.finalText).toBe("decision:denied");
    expect(seen).toContain("item/commandExecution/requestApproval");
  });
});

describe("runTurn", () => {
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

  it("server crash mid-turn resolves failed without hanging", async () => {
    const client = await startClient({ FAKE_CODEX_CRASH_MID_TURN: "1" });
    const threadId = await startThread(client);
    const result = await turnOn(client, threadId, "[[reply:unreachable]]").promise;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/exited/);
    expect(await client.exited).toBe(1);
  });
});
