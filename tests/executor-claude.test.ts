import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeExecutor } from "../src/executor/claude.js";
import type {
  ActivityEvent,
  ClaudeBackendConfig,
  ExecutorContext,
  Usage,
} from "../src/types.js";

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const dir = path.dirname(process.argv[1]);
  fs.appendFileSync(
    path.join(dir, "invocations.jsonl"),
    JSON.stringify({ args, stdin: input }) + "\\n",
  );

  const m = (re) => {
    const r = input.match(re);
    return r ? r[1] : null;
  };
  const reply = (obj) => {
    process.stdout.write(JSON.stringify(obj) + "\\n");
    process.exit(0);
  };
  const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5 };

  const finish = () => {
    const fail = m(/\\[\\[fail:([^\\]]*)\\]\\]/);
    if (fail !== null) {
      reply({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-fail",
        usage,
      });
      return;
    }
    const sessionId = input.includes("[[nosession]]") ? undefined : "sess-abc123";
    const isRepairCall = args.includes("--resume") || input.includes("not valid JSON");
    let result;
    if (input.includes("[[always-invalid]]")) {
      result = "still not json, sorry";
    } else if (isRepairCall) {
      result = '{"answer":"42"}';
    } else if (input.includes("[[invalid-first]]")) {
      result = "Sure! Here is some prose without any braces or JSON in it.";
    } else {
      const r = m(/\\[\\[reply:([^\\]]*)\\]\\]/);
      result = r !== null ? r : "ok";
    }
    const envelope = { type: "result", subtype: "success", result, usage };
    if (sessionId) envelope.session_id = sessionId;
    reply(envelope);
  };

  const slow = m(/\\[\\[slow:(\\d+)\\]\\]/);
  if (slow !== null) setTimeout(finish, Number(slow));
  else finish();
});
`;

interface Invocation {
  args: string[];
  stdin: string;
}

function writeFakeClaude(): { bin: string; dir: string; invocations: () => Invocation[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-fake-claude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
  const logPath = path.join(dir, "invocations.jsonl");
  return {
    bin,
    dir,
    invocations: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l) as Invocation)
        : [],
  };
}

function makeCfg(bin: string, overrides?: Partial<ClaudeBackendConfig>): ClaudeBackendConfig {
  return { binary: bin, defaultModel: "sonnet", modelMap: {}, schemaRetries: 3, ...overrides };
}

function makeCtx(signal?: AbortSignal) {
  const activities: ActivityEvent[] = [];
  const usages: Usage[] = [];
  const threads: string[] = [];
  const ctx: ExecutorContext = {
    signal: signal ?? new AbortController().signal,
    onActivity: (e) => activities.push(e),
    onUsage: (u) => usages.push(u),
    onThread: (t) => threads.push(t),
  };
  return { ctx, activities, usages, threads };
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
};

describe("ClaudeExecutor text calls", () => {
  test("returns final text, mapped usage, threadId; passes model + prompt via stdin", async () => {
    const fake = writeFakeClaude();
    const ex = new ClaudeExecutor(makeCfg(fake.bin), {});
    const { ctx, activities, usages, threads } = makeCtx();

    const res = await ex.run(
      { prompt: "say hi [[reply:hi there]]", cwd: fake.dir, label: "greeter" },
      ctx,
    );

    expect(res).toEqual({
      ok: true,
      text: "hi there",
      usage: {
        totalTokens: 110,
        inputTokens: 100,
        cachedInputTokens: 5,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      },
      threadId: "sess-abc123",
    });
    expect(threads).toEqual(["sess-abc123"]);
    expect(activities).toEqual([{ kind: "status", text: "claude -p running" }]);
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual(res.ok ? res.usage : undefined);

    const inv = fake.invocations();
    expect(inv).toHaveLength(1);
    expect(inv[0]!.args).toEqual(["-p", "--output-format", "json", "--model", "sonnet"]);
    expect(inv[0]!.stdin).toContain("say hi [[reply:hi there]]");
  });

  test("maps model tiers via modelMap and passes unknown tiers through", async () => {
    const fake = writeFakeClaude();
    const ex = new ClaudeExecutor(
      makeCfg(fake.bin, { modelMap: { opus: "claude-opus-4-6" } }),
      {},
    );
    await ex.run({ prompt: "a", cwd: fake.dir, label: "l", model: "opus" }, makeCtx().ctx);
    await ex.run({ prompt: "b", cwd: fake.dir, label: "l", model: "my-custom" }, makeCtx().ctx);

    const inv = fake.invocations();
    expect(inv[0]!.args).toContain("claude-opus-4-6");
    expect(inv[1]!.args).toContain("my-custom");
  });

  test("failure subtype without result → ok:false with subtype in error", async () => {
    const fake = writeFakeClaude();
    const ex = new ClaudeExecutor(makeCfg(fake.bin), {});
    const { ctx, usages } = makeCtx();

    const res = await ex.run({ prompt: "[[fail:boom]]", cwd: fake.dir, label: "l" }, ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/error_during_execution/);
      expect(res.usage?.outputTokens).toBe(10);
      expect(res.threadId).toBe("sess-fail");
    }
    expect(usages).toHaveLength(1);
  });

  test("abort → SIGTERM child, ok:false 'interrupted', resolves fast", async () => {
    const fake = writeFakeClaude();
    const ex = new ClaudeExecutor(makeCfg(fake.bin), {});
    const ac = new AbortController();
    const { ctx } = makeCtx(ac.signal);
    setTimeout(() => ac.abort(), 100);

    const start = Date.now();
    const res = await ex.run({ prompt: "[[slow:20000]]", cwd: fake.dir, label: "l" }, ctx);

    expect(res).toMatchObject({ ok: false, error: "interrupted" });
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test("missing binary → ok:false with spawn error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-nobin-"));
    const ex = new ClaudeExecutor(makeCfg(path.join(dir, "nope")), {});
    const res = await ex.run({ prompt: "x", cwd: dir, label: "l" }, makeCtx().ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/spawn/i);
  });
});

describe("ClaudeExecutor schema calls", () => {
  test("valid first reply → validated object", async () => {
    const fake = writeFakeClaude();
    const ex = new ClaudeExecutor(makeCfg(fake.bin), {});
    const res = await ex.run(
      {
        prompt: '[[reply:{"answer":"direct"}]]',
        schema: ANSWER_SCHEMA,
        cwd: fake.dir,
        label: "l",
      },
      makeCtx().ctx,
    );
    expect(res).toMatchObject({ ok: true, object: { answer: "direct" } });
    expect(fake.invocations()).toHaveLength(1);
  });

  test("invalid reply → repair via --resume with the session id, accumulating usage", async () => {
    const fake = writeFakeClaude();
    const ex = new ClaudeExecutor(makeCfg(fake.bin), {});
    const { ctx, usages } = makeCtx();

    const res = await ex.run(
      { prompt: "compute [[invalid-first]]", schema: ANSWER_SCHEMA, cwd: fake.dir, label: "l" },
      ctx,
    );

    expect(res).toMatchObject({ ok: true, object: { answer: "42" }, threadId: "sess-abc123" });
    if (res.ok) {
      expect(res.usage).toEqual({
        totalTokens: 220,
        inputTokens: 200,
        cachedInputTokens: 10,
        outputTokens: 20,
        reasoningOutputTokens: 0,
      });
    }
    expect(usages).toHaveLength(2);

    const inv = fake.invocations();
    expect(inv).toHaveLength(2);
    expect(inv[0]!.args).not.toContain("--resume");
    const resumeIdx = inv[1]!.args.indexOf("--resume");
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(inv[1]!.args[resumeIdx + 1]).toBe("sess-abc123");
    expect(inv[1]!.stdin).toContain("not valid JSON");
    expect(inv[1]!.stdin).toContain("Respond with ONLY the corrected JSON object");
  });

  test("no session id → fresh repair call embedding the errors", async () => {
    const fake = writeFakeClaude();
    const ex = new ClaudeExecutor(makeCfg(fake.bin), {});
    const res = await ex.run(
      {
        prompt: "compute [[nosession]] [[invalid-first]]",
        schema: ANSWER_SCHEMA,
        cwd: fake.dir,
        label: "l",
      },
      makeCtx().ctx,
    );

    expect(res).toMatchObject({ ok: true, object: { answer: "42" } });
    if (res.ok) expect(res.threadId).toBeUndefined();

    const inv = fake.invocations();
    expect(inv).toHaveLength(2);
    expect(inv[1]!.args).not.toContain("--resume");
    // fresh call re-embeds the original prompt plus the validation errors
    expect(inv[1]!.stdin).toContain("compute [[nosession]] [[invalid-first]]");
    expect(inv[1]!.stdin).toContain("not valid JSON");
  });

  test("stays invalid → gives up after cfg.schemaRetries repairs with ok:false", async () => {
    const fake = writeFakeClaude();
    const ex = new ClaudeExecutor(makeCfg(fake.bin, { schemaRetries: 2 }), {});
    const res = await ex.run(
      {
        prompt: "compute [[nosession]] [[always-invalid]]",
        schema: ANSWER_SCHEMA,
        cwd: fake.dir,
        label: "l",
      },
      makeCtx().ctx,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/schema validation failed after 2/);
    expect(fake.invocations()).toHaveLength(3); // initial + 2 repairs
  });
});
