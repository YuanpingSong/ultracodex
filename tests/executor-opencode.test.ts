import { afterEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPENCODE_CONFIG, INTERRUPT_GRACE_MS } from "../src/constants.js";
import { OpencodeExecutor } from "../src/executor/opencode.js";
import type {
  ActivityEvent,
  ExecutorContext,
  OpencodeBackendConfig,
  Usage,
} from "../src/types.js";

const FAKE_OPENCODE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode", "opencode");
const ENV_KEYS = [
  "FAKE_OPENCODE_INVOCATIONS",
  "FAKE_OPENCODE_SESSION_ID",
  "FAKE_OPENCODE_STDIO_HTTP",
  "FAKE_OPENCODE_GARBAGE_BODY",
  "FAKE_OPENCODE_CRASH_MID_TURN",
  "FAKE_OPENCODE_HANG",
  "FAKE_OPENCODE_PID_FILE",
  "ULTRACODEX_OPENCODE_START_TIMEOUT_MS",
];

const dirs: string[] = [];

interface Invocation {
  kind: string;
  args?: string[];
  cwd?: string;
  method?: string;
  path?: string;
  body?: any;
}

function tmpDir(prefix = "ultracodex-opencode-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true });
    } catch {}
  }
});

function cfg(overrides: Partial<OpencodeBackendConfig> = {}): OpencodeBackendConfig {
  return { ...DEFAULT_OPENCODE_CONFIG, binary: FAKE_OPENCODE, ...overrides };
}

function makeCtx(signal?: AbortSignal) {
  const activities: ActivityEvent[] = [];
  const usages: Usage[] = [];
  const threads: string[] = [];
  const ctx: ExecutorContext = {
    signal: signal ?? new AbortController().signal,
    onActivity: (ev) => activities.push(ev),
    onUsage: (usage) => usages.push(usage),
    onThread: (id) => threads.push(id),
  };
  return { ctx, activities, usages, threads };
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeEnv(logPath: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    FAKE_OPENCODE_INVOCATIONS: logPath,
    FAKE_OPENCODE_STDIO_HTTP: "1",
    ...extra,
  };
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

function messageRequests(logPath: string): Invocation[] {
  return readInvocations(logPath).filter((entry) => entry.path?.endsWith("/message"));
}

async function waitForInvocation(logPath: string, predicate: (entry: Invocation) => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (readInvocations(logPath).some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(readInvocations(logPath).some(predicate)).toBe(true);
}

function expectMonotonic(usages: Usage[]): void {
  for (let i = 1; i < usages.length; i++) {
    expect(usages[i]!.totalTokens).toBeGreaterThanOrEqual(usages[i - 1]!.totalTokens);
    expect(usages[i]!.inputTokens).toBeGreaterThanOrEqual(usages[i - 1]!.inputTokens);
    expect(usages[i]!.cachedInputTokens).toBeGreaterThanOrEqual(usages[i - 1]!.cachedInputTokens);
    expect(usages[i]!.outputTokens).toBeGreaterThanOrEqual(usages[i - 1]!.outputTokens);
    expect(usages[i]!.reasoningOutputTokens).toBeGreaterThanOrEqual(usages[i - 1]!.reasoningOutputTokens);
  }
}

function writePidWrapper(pidFile: string): string {
  const wrapper = path.join(tmpDir("ultracodex-opencode-wrapper-"), "opencode");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nprintf "%s" "$$" > "$FAKE_OPENCODE_PID_FILE"\nexec ${JSON.stringify(FAKE_OPENCODE)} "$@"\n`,
  );
  fs.chmodSync(wrapper, 0o755);
  process.env.FAKE_OPENCODE_PID_FILE = pidFile;
  return wrapper;
}

function writeStalledServe(): string {
  const bin = path.join(tmpDir("ultracodex-opencode-stall-"), "opencode");
  fs.writeFileSync(bin, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(bin, 0o755);
  return bin;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(alive(pid)).toBe(false);
}

const NUMBER_SCHEMA = {
  type: "object",
  properties: { a: { type: "number" } },
  required: ["a"],
};

describe("OpencodeExecutor", () => {
  test("plain text call returns final text, activity, usage, and one thread id", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(fakeEnv(logPath, { FAKE_OPENCODE_SESSION_ID: "ses_text" }), async () => {
      const exec = new OpencodeExecutor(cfg(), {});
      const { ctx, activities, usages, threads } = makeCtx();
      const res = await exec.run(
        { prompt: "say hi [[reply:hello]] [[usage:7,3]]", cwd, label: "greet" },
        ctx,
      );

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.text).toBe("hello");
        expect(res.object).toBeUndefined();
        expect(res.threadId).toBe("ses_text");
        expect(res.usage).toEqual({
          totalTokens: 10,
          inputTokens: 7,
          cachedInputTokens: 0,
          outputTokens: 3,
          reasoningOutputTokens: 0,
        });
      }
      expect(activities.some((ev) => ev.text === "hello")).toBe(true);
      expect(threads).toEqual(["ses_text"]);
      expect(usages.length).toBeGreaterThanOrEqual(2);
      expectMonotonic(usages);
      expect(usages.at(-1)).toEqual(res.ok ? res.usage : undefined);
    });
  });

  test("schema calls send the raw authored schema and validate optionals plus map-style objects", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");
    const optionalSchema = {
      type: "object",
      properties: {
        done: { type: "boolean" },
        optionalNote: { type: "string" },
      },
      required: ["done"],
    };
    const optionalSnapshot = structuredClone(optionalSchema);
    const mapSchema = {
      type: "object",
      properties: {
        counts: { type: "object", additionalProperties: { type: "number" } },
      },
      required: ["counts"],
    };

    await withEnv(fakeEnv(logPath), async () => {
      const exec = new OpencodeExecutor(cfg(), {});
      const optional = await exec.run(
        {
          prompt: 'report [[structured:{"done":true}]]',
          schema: optionalSchema,
          cwd,
          label: "optional",
        },
        makeCtx().ctx,
      );
      expect(optional.ok).toBe(true);
      if (optional.ok) expect(optional.object).toEqual({ done: true });
      expect(optionalSchema).toEqual(optionalSnapshot);

      const mapped = await exec.run(
        {
          prompt: 'tally [[structured:{"counts":{"x":1,"y":2}}]]',
          schema: mapSchema,
          cwd,
          label: "map",
        },
        makeCtx().ctx,
      );
      expect(mapped.ok).toBe(true);
      if (mapped.ok) expect(mapped.object).toEqual({ counts: { x: 1, y: 2 } });

      const bodies = messageRequests(logPath).map((entry) => entry.body);
      expect(bodies[0].format.schema).toEqual(optionalSchema);
      expect(bodies[0].format.schema.required).toEqual(["done"]);
      expect(bodies[1].format.schema).toEqual(mapSchema);
      expect(bodies[1].format.schema.properties.counts.additionalProperties).toEqual({ type: "number" });
    });
  });

  test("wire APIError falls back to the same turn without format", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(fakeEnv(logPath, { FAKE_OPENCODE_SESSION_ID: "ses_wire" }), async () => {
      const exec = new OpencodeExecutor(cfg({ schemaRetries: 0 }), {});
      const res = await exec.run(
        {
          prompt: '[[wire-reject]] [[structured:{"a":4}]]',
          schema: NUMBER_SCHEMA,
          cwd,
          label: "wire",
        },
        makeCtx().ctx,
      );

      expect(res.ok).toBe(true);
      if (res.ok) expect(res.object).toEqual({ a: 4 });
      const bodies = messageRequests(logPath).map((entry) => entry.body);
      expect(bodies).toHaveLength(2);
      expect(bodies[0].format).toMatchObject({ type: "json_schema" });
      expect(bodies[1]).not.toHaveProperty("format");
      expect(bodies[0].parts[0].text).toBe(bodies[1].parts[0].text);
    });
  });

  test("repairs invalid structured output on the same session and accumulates usage", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(fakeEnv(logPath, { FAKE_OPENCODE_SESSION_ID: "ses_repair" }), async () => {
      const exec = new OpencodeExecutor(cfg(), {});
      const { ctx, threads, usages } = makeCtx();
      const res = await exec.run(
        {
          prompt: '[[invalid-first]] [[structured:{"a":1}]] [[structured2:{"a":2}]]',
          schema: NUMBER_SCHEMA,
          cwd,
          label: "repair",
        },
        ctx,
      );

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.object).toEqual({ a: 2 });
        expect(res.usage).toEqual({
          totalTokens: 220,
          inputTokens: 200,
          cachedInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 0,
        });
      }
      expect(threads).toEqual(["ses_repair"]);
      expectMonotonic(usages);
      expect(usages.at(-1)).toEqual(res.ok ? res.usage : undefined);
      expect(messageRequests(logPath).map((entry) => entry.path)).toEqual([
        "/session/ses_repair/message",
        "/session/ses_repair/message",
      ]);
    });
  });

  test("gives up after cfg.schemaRetries repair attempts", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(fakeEnv(logPath), async () => {
      const exec = new OpencodeExecutor(cfg({ schemaRetries: 2 }), {});
      const res = await exec.run(
        {
          prompt: '[[always-invalid]] [[structured:{"a":1}]]',
          schema: NUMBER_SCHEMA,
          cwd,
          label: "invalid",
        },
        makeCtx().ctx,
      );

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/schema validation failed after 2 repair attempt\(s\).*required property 'a'/s);
      expect(messageRequests(logPath)).toHaveLength(3);
    });
  });

  test("idle watchdog fires despite keepalive events (only progress resets it)", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(
      { ...fakeEnv(logPath), ULTRACODEX_OPENCODE_IDLE_TIMEOUT_MS: "500" },
      async () => {
        const exec = new OpencodeExecutor(cfg(), {});
        const { ctx } = makeCtx(new AbortController().signal);

        const started = Date.now();
        // fake emits a session.updated keepalive every 100ms but never settles.
        const res = await exec.run({ prompt: "[[hang-keepalive]]", cwd, label: "idle-keepalive" }, ctx);
        const elapsed = Date.now() - started;

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/idle for \d+s \(provider stall\)/);
        expect(elapsed).toBeLessThan(30_000);
        expect(readInvocations(logPath).some((entry) => entry.path?.endsWith("/abort"))).toBe(true);
      },
    );
  });

  test("idle watchdog aborts a stalled turn (provider hang) without external signal", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(
      { ...fakeEnv(logPath), ULTRACODEX_OPENCODE_IDLE_TIMEOUT_MS: "400" },
      async () => {
        const exec = new OpencodeExecutor(cfg(), {});
        const { ctx } = makeCtx(new AbortController().signal);

        const started = Date.now();
        const res = await exec.run({ prompt: "[[hang]]", cwd, label: "idle" }, ctx);
        const elapsed = Date.now() - started;

        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/idle for \d+s \(provider stall\)/);
        // 400ms idle + 400ms poll tick + overhead — must resolve well under a minute
        expect(elapsed).toBeLessThan(30_000);
        expect(readInvocations(logPath).some((entry) => entry.path?.endsWith("/abort"))).toBe(true);
      },
    );
  });

  test("abort posts /abort, settles inside the grace window, and kills the serve process", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");
    const pidFile = path.join(cwd, "opencode.pid");
    const wrapper = writePidWrapper(pidFile);

    await withEnv(fakeEnv(logPath, { FAKE_OPENCODE_PID_FILE: pidFile }), async () => {
      const exec = new OpencodeExecutor(cfg({ binary: wrapper }), {});
      const ac = new AbortController();
      const { ctx } = makeCtx(ac.signal);

      const pending = exec.run({ prompt: "[[hang]]", cwd, label: "abort" }, ctx);
      await waitForInvocation(logPath, (entry) => entry.path?.endsWith("/message") === true);
      const abortAt = Date.now();
      ac.abort();
      const res = await pending;
      const elapsed = Date.now() - abortAt;

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe("interrupted");
      expect(elapsed).toBeLessThanOrEqual(INTERRUPT_GRACE_MS);
      expect(readInvocations(logPath).some((entry) => entry.path?.endsWith("/abort"))).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      await waitDead(pid);
    });
  });

  test("usage ticks are cumulative monotonic and final usage matches the last tick", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(fakeEnv(logPath), async () => {
      const exec = new OpencodeExecutor(cfg(), {});
      const { ctx, usages } = makeCtx();
      const res = await exec.run(
        { prompt: "[[reply:metered]] [[usage:150,15]]", cwd, label: "usage" },
        ctx,
      );

      expect(res.ok).toBe(true);
      expect(usages.length).toBeGreaterThanOrEqual(2);
      expectMonotonic(usages);
      if (res.ok) {
        expect(res.text).toBe("metered");
        expect(res.usage).toEqual({
          totalTokens: 165,
          inputTokens: 150,
          cachedInputTokens: 0,
          outputTokens: 15,
          reasoningOutputTokens: 0,
        });
        expect(usages.at(-1)).toEqual(res.usage);
      }
    });
  });

  test("profile, variant, model split, tools disable map, and extra args are sent", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(fakeEnv(logPath), async () => {
      const exec = new OpencodeExecutor(
        cfg({
          model: "deepseek/deepseek-chat",
          variantMap: { high: "thinking" },
          extraArgs: ["--trace"],
        }),
        { Explore: { sandbox: "read-only", preamble: "READ ONLY PROFILE" } },
      );
      const res = await exec.run(
        {
          prompt: "[[reply:profiled]]",
          cwd,
          label: "profile",
          effort: "high",
          agentProfile: "Explore",
        },
        makeCtx().ctx,
      );

      expect(res.ok).toBe(true);
      if (res.ok) expect(res.text).toBe("profiled");
      const logs = readInvocations(logPath);
      expect(logs[0]).toMatchObject({
        kind: "process",
        args: ["serve", "--port", "0", "--hostname", "127.0.0.1", "--trace"],
        cwd: fs.realpathSync(cwd),
      });
      const body = messageRequests(logPath)[0]!.body;
      expect(body.model).toEqual({ providerID: "deepseek", modelID: "deepseek-chat" });
      expect(body.variant).toBe("thinking");
      expect(body.system).toBe("READ ONLY PROFILE");
      expect(body.tools).toMatchObject({ bash: false, edit: false, write: false, patch: false });
    });
  });

  test("announce timeout resolves ok:false instead of hanging", async () => {
    const cwd = tmpDir();
    const stalled = writeStalledServe();

    await withEnv({ ULTRACODEX_OPENCODE_START_TIMEOUT_MS: "100" }, async () => {
      const exec = new OpencodeExecutor(cfg({ binary: stalled }), {});
      const start = Date.now();
      const res = await exec.run({ prompt: "[[reply:unreachable]]", cwd, label: "timeout" }, makeCtx().ctx);

      expect(Date.now() - start).toBeLessThan(2_000);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/OpencodeStartupTimeout/);
    });
  });

  test("mid-turn crash resolves ok:false with a diagnostic", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(fakeEnv(logPath), async () => {
      const exec = new OpencodeExecutor(cfg(), {});
      const res = await exec.run({ prompt: "[[crash-mid-turn]]", cwd, label: "crash" }, makeCtx().ctx);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/OpencodeProcessError: opencode serve exited/);
    });
  });

  test("garbage response body resolves ok:false", async () => {
    const cwd = tmpDir();
    const logPath = path.join(cwd, "invocations.jsonl");

    await withEnv(fakeEnv(logPath), async () => {
      const exec = new OpencodeExecutor(cfg(), {});
      const res = await exec.run({ prompt: "[[garbage]]", cwd, label: "garbage" }, makeCtx().ctx);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/OpencodeProtocolError: invalid JSON response body/);
    });
  });

  test("every typed OpenCode error class maps to ok:false", async () => {
    const cases: Array<[string, RegExp]> = [
      ["provider-auth-error", /ProviderAuthError: Fake provider authentication failed/],
      ["unknown-error", /UnknownError: Fake unknown error/],
      ["message-output-length-error", /MessageOutputLengthError: Fake output length exceeded/],
      ["message-aborted-error", /^interrupted$/],
      ["structured-output-error", /StructuredOutputError: Fake structured output failure/],
      ["context-overflow-error", /ContextOverflowError: Fake context window exceeded/],
      ["api-error", /APIError: Fake API error/],
    ];

    for (const [directive, pattern] of cases) {
      const cwd = tmpDir();
      const logPath = path.join(cwd, "invocations.jsonl");
      await withEnv(fakeEnv(logPath), async () => {
        const exec = new OpencodeExecutor(cfg(), {});
        const res = await exec.run({ prompt: `[[${directive}]]`, cwd, label: directive }, makeCtx().ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(pattern);
      });
    }
  });

  test("missing binary resolves ok:false without throwing", async () => {
    const exec = new OpencodeExecutor(cfg({ binary: "/nonexistent/definitely-not-opencode" }), {});
    const res = await exec.run({ prompt: "x", cwd: tmpDir(), label: "spawn" }, makeCtx().ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Error: spawn .*ENOENT|ENOENT/);
  });
});
