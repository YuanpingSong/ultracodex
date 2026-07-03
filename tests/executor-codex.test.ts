import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexExecutor } from "../src/executor/codex.js";
import { DEFAULT_CODEX_CONFIG } from "../src/constants.js";
import { fakeCodexPath } from "./helpers.js";
import type { ActivityEvent, CodexBackendConfig, ExecutorContext, Usage } from "../src/types.js";

const dirs: string[] = [];

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-executor-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true });
    } catch {}
  }
});

function cfg(overrides?: Partial<CodexBackendConfig>): CodexBackendConfig {
  return { ...DEFAULT_CODEX_CONFIG, binary: fakeCodexPath(), ...overrides };
}

function makeCtx() {
  const activities: ActivityEvent[] = [];
  const usages: Usage[] = [];
  const threads: string[] = [];
  const ac = new AbortController();
  const ctx: ExecutorContext = {
    signal: ac.signal,
    onActivity: (ev) => activities.push(ev),
    onUsage: (u) => usages.push(u),
    onThread: (id) => threads.push(id),
  };
  return { ctx, activities, usages, threads, ac };
}

describe("CodexExecutor", () => {
  it("plain text call returns the final answer text", async () => {
    const exec = new CodexExecutor(cfg(), {});
    const { ctx, threads, usages } = makeCtx();
    const res = await exec.run({ prompt: "say hi [[reply:hello]]", cwd: tmpDir(), label: "greet" }, ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toBe("hello");
      expect(res.object).toBeUndefined();
      expect(res.threadId).toBeTruthy();
      expect(res.usage.totalTokens).toBe(110);
    }
    expect(threads).toHaveLength(1);
    expect(usages.length).toBeGreaterThanOrEqual(1);
  });

  it("schema call returns the validated parsed object and does not mutate the input schema", async () => {
    const exec = new CodexExecutor(cfg(), {});
    const { ctx } = makeCtx();
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const snapshot = structuredClone(schema);
    const res = await exec.run(
      { prompt: 'give me a [[reply:{"a":1}]]', schema, cwd: tmpDir(), label: "extract" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.object).toEqual({ a: 1 });
      expect(res.text).toBeUndefined();
    }
    expect(schema).toEqual(snapshot);
  });

  it("repairs invalid JSON on the same thread and accumulates usage across turns", async () => {
    const exec = new CodexExecutor(cfg(), {});
    const { ctx, usages, threads } = makeCtx();
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const res = await exec.run(
      { prompt: '[[reply:not json]] [[reply2:{"a":2}]]', schema, cwd: tmpDir(), label: "repair" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.object).toEqual({ a: 2 });
      // Two turns, each 100 in / 10 out on the fake's defaults.
      expect(res.usage).toEqual({
        totalTokens: 220,
        inputTokens: 200,
        cachedInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 0,
      });
    }
    // One thread only (repair happened on the SAME thread), and monotonic usage ticks.
    expect(threads).toHaveLength(1);
    expect(usages.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < usages.length; i++) {
      expect(usages[i]!.totalTokens).toBeGreaterThanOrEqual(usages[i - 1]!.totalTokens);
      expect(usages[i]!.outputTokens).toBeGreaterThanOrEqual(usages[i - 1]!.outputTokens);
    }
    if (res.ok) expect(usages.at(-1)).toEqual(res.usage);
  });

  it("gives up after cfg.schemaRetries repair attempts", async () => {
    const exec = new CodexExecutor(cfg({ schemaRetries: 2 }), {});
    const { ctx, usages } = makeCtx();
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const res = await exec.run(
      { prompt: "[[reply:still not json]]", schema, cwd: tmpDir(), label: "hopeless" },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/schema validation failed after 2 repair/);
      // 1 initial + 2 repair turns worth of usage.
      expect(res.usage?.totalTokens).toBe(330);
    }
    expect(usages.at(-1)?.totalTokens).toBe(330);
  });

  it("abort maps to {ok:false, error:'interrupted'} promptly", async () => {
    const exec = new CodexExecutor(cfg(), {});
    const { ctx, ac } = makeCtx();
    setTimeout(() => ac.abort(), 100);
    const start = Date.now();
    const res = await exec.run(
      { prompt: "[[slow:5000]] [[reply:never delivered]]", cwd: tmpDir(), label: "slow" },
      ctx,
    );
    expect(Date.now() - start).toBeLessThan(2000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("interrupted");
  });

  it("forwards exec activity with verification phase", async () => {
    const exec = new CodexExecutor(cfg(), {});
    const { ctx, activities } = makeCtx();
    const res = await exec.run(
      { prompt: "[[exec:pnpm test]] [[reply:done]]", cwd: tmpDir(), label: "verify" },
      ctx,
    );
    expect(res.ok).toBe(true);
    const exec_ = activities.find((a) => a.kind === "exec");
    expect(exec_).toBeDefined();
    expect(exec_!.phase).toBe("verifying");
    expect(exec_!.text).toContain("pnpm test");
  });

  it("failed turn maps to {ok:false} with the error message", async () => {
    const exec = new CodexExecutor(cfg(), {});
    const { ctx } = makeCtx();
    const res = await exec.run({ prompt: "[[fail:boom]]", cwd: tmpDir(), label: "boom" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("boom");
  });

  it("client spawn failure maps to {ok:false} without throwing", async () => {
    const exec = new CodexExecutor(cfg({ binary: "/nonexistent/definitely-not-codex" }), {});
    const { ctx } = makeCtx();
    const res = await exec.run({ prompt: "[[reply:unreachable]]", cwd: tmpDir(), label: "spawn" }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/app-server/);
  });

  it("applies the agent profile's preamble and sandbox", async () => {
    const exec = new CodexExecutor(cfg(), {
      Explore: { sandbox: "read-only", preamble: "You are read-only." },
    });
    const { ctx } = makeCtx();
    const res = await exec.run(
      { prompt: "[[reply:explored]]", cwd: tmpDir(), label: "scout", agentProfile: "Explore" },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe("explored");
  });
});
