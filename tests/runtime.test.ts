import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRuntime } from "../src/runtime.js";
import type { RuntimeDeps } from "../src/runtime.js";
import { JournalWriter, readJournal } from "../src/journal.js";
import { sha256Hex } from "../src/ids.js";
import { ACTIVITY_TEXT_MAX, DEFAULT_CONFIG } from "../src/constants.js";
import type {
  AgentEndEvent,
  AgentStartEvent,
  Executor,
  ExecutorContext,
  ExecutorRequest,
  ExecutorResult,
  JournalEvent,
  UltracodexConfig,
  Usage,
} from "../src/types.js";

const cleanups: string[] = [];
const journals: JournalWriter[] = [];

afterEach(() => {
  for (const j of journals.splice(0)) {
    try { j.close(); } catch {}
  }
  for (const d of cleanups.splice(0)) {
    try { fs.rmSync(d, { recursive: true }); } catch {}
  }
});

function usage(out: number, inTok = 0): Usage {
  return {
    totalTokens: inTok + out,
    inputTokens: inTok,
    cachedInputTokens: 0,
    outputTokens: out,
    reasoningOutputTokens: 0,
  };
}

function okExecutor(
  text: string,
  opts?: { usage?: Usage; delayMs?: number; backend?: string },
): Executor & { invocations: ExecutorRequest[] } {
  const invocations: ExecutorRequest[] = [];
  return {
    backend: opts?.backend ?? "codex",
    invocations,
    async run(req: ExecutorRequest): Promise<ExecutorResult> {
      invocations.push(req);
      if (opts?.delayMs) await sleep(opts.delayMs);
      return { ok: true, text, usage: opts?.usage ?? usage(0) };
    },
  };
}

interface DeferredCall {
  req: ExecutorRequest;
  ctx: ExecutorContext;
  resolve: (r: ExecutorResult) => void;
}

function deferredExecutor(): { executor: Executor; calls: DeferredCall[] } {
  const calls: DeferredCall[] = [];
  const executor: Executor = {
    backend: "codex",
    run(req, ctx) {
      return new Promise<ExecutorResult>((resolve) => {
        calls.push({ req, ctx, resolve });
      });
    },
  };
  return { executor, calls };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until(): timed out");
    await sleep(5);
  }
}

function makeRuntime(opts?: {
  executor?: Executor;
  executors?: Record<string, Executor>;
  budgetTotal?: number | null;
  concurrency?: number;
  config?: UltracodexConfig;
  loadChildWorkflow?: RuntimeDeps["loadChildWorkflow"];
  argsJson?: unknown;
}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-runtime-"));
  cleanups.push(runDir);
  const journal = new JournalWriter(runDir);
  journals.push(journal);
  let argsPath: string | null = null;
  if (opts?.argsJson !== undefined) {
    fs.writeFileSync(path.join(runDir, "args.json"), JSON.stringify(opts.argsJson), "utf8");
    argsPath = "args.json";
  }
  const deps: RuntimeDeps = {
    journal,
    executors: opts?.executors ?? { codex: opts?.executor ?? okExecutor("ok") },
    config: opts?.config ?? structuredClone(DEFAULT_CONFIG),
    options: {
      runId: "uc_test",
      runDir,
      scriptPath: path.join(runDir, "script.js"),
      argsPath,
      budgetTotal: opts?.budgetTotal ?? null,
      concurrency: opts?.concurrency ?? 4,
      strict: false,
      projectDir: runDir,
    },
    meta: { name: "test-run", description: "runtime tests" },
    loadChildWorkflow:
      opts?.loadChildWorkflow ??
      (() => {
        throw new Error("no child workflows configured");
      }),
  };
  const rt = createRuntime(deps);
  return { g: rt.globals, controller: rt.controller, runDir, journal };
}

function starts(runDir: string): AgentStartEvent[] {
  return readJournal(runDir).filter((e) => e.t === "agent_start") as AgentStartEvent[];
}
function ends(runDir: string): AgentEndEvent[] {
  return readJournal(runDir).filter((e) => e.t === "agent_end") as AgentEndEvent[];
}

describe("agent()", () => {
  it("returns final text and snapshots prompt/output", async () => {
    const { g, runDir } = makeRuntime({
      executor: okExecutor("the answer", { usage: usage(7, 3) }),
    });
    const result = await g.agent("do the thing", { label: "worker" });
    expect(result).toBe("the answer");

    const [start] = starts(runDir);
    expect(start).toBeDefined();
    expect(start!.n).toBe(1);
    expect(start!.label).toBe("worker");
    expect(start!.backend).toBe("codex");
    expect(start!.hasSchema).toBe(false);
    expect(start!.promptSha).toBe(sha256Hex("do the thing"));
    expect(fs.readFileSync(path.join(runDir, start!.promptRef), "utf8")).toBe("do the thing");

    const [end] = ends(runDir);
    expect(end!.status).toBe("ok");
    expect(end!.usage.outputTokens).toBe(7);
    expect(end!.resultRef).not.toBeNull();
    expect(fs.readFileSync(path.join(runDir, end!.resultRef!), "utf8")).toBe("the answer");
  });

  it("returns validated object for schema calls and writes output.json", async () => {
    const obj = { x: 1, items: ["a", "b"] };
    const executor: Executor = {
      backend: "codex",
      run: async () => ({ ok: true, object: obj, usage: usage(3) }),
    };
    const { g, runDir } = makeRuntime({ executor });
    const result = await g.agent("structured", { schema: { type: "object" } });
    expect(result).toEqual(obj);

    expect(starts(runDir)[0]!.hasSchema).toBe(true);
    const end = ends(runDir)[0]!;
    expect(end.status).toBe("ok");
    expect(end.resultRef).toMatch(/output\.json$/);
    expect(JSON.parse(fs.readFileSync(path.join(runDir, end.resultRef!), "utf8"))).toEqual(obj);
  });

  it("returns null on executor failure and journals failed", async () => {
    const executor: Executor = {
      backend: "codex",
      run: async () => ({ ok: false, error: "boom", usage: usage(2) }),
    };
    const { g, runDir } = makeRuntime({ executor });
    const result = await g.agent("fails");
    expect(result).toBeNull();
    const end = ends(runDir)[0]!;
    expect(end.status).toBe("failed");
    expect(end.error).toBe("boom");
    expect(end.usage.outputTokens).toBe(2);
    expect(end.resultRef).toBeNull();
  });

  it("never rejects: executor throwing sync or rejecting maps to null", async () => {
    const throwing: Executor = {
      backend: "codex",
      run: () => {
        throw new Error("sync explosion");
      },
    };
    const { g } = makeRuntime({ executor: throwing });
    await expect(g.agent("a")).resolves.toBeNull();

    const rejecting: Executor = {
      backend: "codex",
      run: () => Promise.reject(new Error("async explosion")),
    };
    const rt2 = makeRuntime({ executor: rejecting });
    await expect(rt2.g.agent("b")).resolves.toBeNull();
    expect(ends(rt2.runDir)[0]!.error).toBe("async explosion");
  });

  it("routes by label via config and resolves display model/effort", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.route = [
      { pattern: "critique:*", backend: "claude" },
      { pattern: "*", backend: "codex" },
    ];
    const codex = okExecutor("from-codex");
    const claude = okExecutor("from-claude", { backend: "claude" });
    const { g, runDir } = makeRuntime({ config, executors: { codex, claude } });

    expect(await g.agent("judge it", { label: "critique:review" })).toBe("from-claude");
    expect(await g.agent("build it", { label: "impl", model: "opus", effort: "max" })).toBe(
      "from-codex",
    );
    expect(await g.agent("odd tier", { label: "impl2", model: "my-model" })).toBe("from-codex");

    const s = starts(runDir);
    expect(s[0]!.backend).toBe("claude");
    expect(s[1]!.backend).toBe("codex");
    expect(s[1]!.model).toBe("gpt-5.5"); // opus mapped via codex modelMap
    expect(s[1]!.effort).toBe("xhigh"); // max mapped via effortMap
    expect(s[2]!.model).toBe("my-model"); // unknown tier passes through
    // no opts.model → journal records the backend default that will actually run
    expect(s[0]!.model).toBe(DEFAULT_CONFIG.claude.defaultModel);
    expect(s[0]!.effort).toBeNull(); // claude backend has no effort concept
  });

  it("throttles agent_activity (latest-wins) and appends raw events.jsonl", async () => {
    const long = "x".repeat(600);
    const executor: Executor = {
      backend: "codex",
      async run(_req, ctx) {
        ctx.onActivity({ kind: "exec", text: "a1" });
        ctx.onActivity({ kind: "exec", text: "a2" });
        ctx.onActivity({ kind: "exec", text: "a3" });
        ctx.onActivity({ kind: "exec", text: "a4" });
        ctx.onActivity({ kind: "exec", text: long });
        await sleep(400);
        return { ok: true, text: "done", usage: usage(1) };
      },
    };
    const { g, runDir } = makeRuntime({ executor });
    await g.agent("busy", { label: "busy" });

    const acts = readJournal(runDir).filter((e) => e.t === "agent_activity");
    expect(acts).toHaveLength(2); // first immediate + one trailing latest
    expect((acts[0] as { text: string }).text).toBe("a1");
    expect((acts[1] as { text: string }).text).toBe(long.slice(0, ACTIVITY_TEXT_MAX));

    const start = starts(runDir)[0]!;
    const agentDirPath = path.join(runDir, path.dirname(start.promptRef));
    const raw = fs
      .readFileSync(path.join(agentDirPath, "events.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(raw).toHaveLength(5);
    expect((JSON.parse(raw[4]!) as { text: string }).text).toBe(long); // raw untruncated
  });

  it("reads args from argsPath", () => {
    const { g } = makeRuntime({ argsJson: { question: "why", n: 3 } });
    expect(g.args).toEqual({ question: "why", n: 3 });
    const bare = makeRuntime({});
    expect(bare.g.args).toBeUndefined();
  });

  it("coerces non-string prompts and null opts instead of throwing", async () => {
    const executor = okExecutor("coerced-ok");
    const { g, runDir } = makeRuntime({ executor });
    await expect(
      g.agent(12345 as unknown as string, null as unknown as undefined),
    ).resolves.toBe("coerced-ok");
    expect(executor.invocations[0]!.prompt).toBe("12345");
    expect(starts(runDir)[0]!.promptSha).toBe(sha256Hex("12345"));
  });

  it("degrades agent-dir/prompt snapshot fs failures to warn + failed agent, never a throw", async () => {
    const { g, runDir } = makeRuntime();
    // Make agents/ a FILE so agentDir's mkdir fails.
    fs.rmSync(path.join(runDir, "agents"), { recursive: true, force: true });
    fs.writeFileSync(path.join(runDir, "agents"), "not a dir", "utf8");

    await expect(g.agent("doomed", { label: "doomed" })).resolves.toBeNull();

    const events = readJournal(runDir);
    const warn = events.find((e) => e.t === "warn") as { text: string } | undefined;
    expect(warn?.text).toMatch(/snapshot failed/);
    const end = ends(runDir)[0]!;
    expect(end.status).toBe("failed");
    expect(end.error).toMatch(/snapshot failed/);
  });
});

describe("journal sequence", () => {
  it("orders agent_start → agent_thread → agent_activity → agent_usage → agent_end", async () => {
    const executor: Executor = {
      backend: "codex",
      async run(_req, ctx) {
        ctx.onThread?.("th_abc");
        ctx.onActivity({ kind: "exec", text: "$ ls", phase: "running" });
        ctx.onUsage(usage(5));
        return { ok: true, text: "answer", usage: usage(7) };
      },
    };
    const { g, runDir } = makeRuntime({ executor });
    await g.agent("sequence check");

    const types = readJournal(runDir).map((e) => e.t);
    const idx = (t: JournalEvent["t"]) => types.indexOf(t);
    expect(idx("agent_start")).toBeGreaterThanOrEqual(0);
    expect(idx("agent_thread")).toBeGreaterThan(idx("agent_start"));
    expect(idx("agent_activity")).toBeGreaterThan(idx("agent_thread"));
    expect(idx("agent_usage")).toBeGreaterThan(idx("agent_activity"));
    expect(idx("agent_end")).toBeGreaterThan(idx("agent_usage"));

    const thread = readJournal(runDir).find((e) => e.t === "agent_thread");
    expect((thread as { threadId: string }).threadId).toBe("th_abc");
    const end = ends(runDir)[0]!;
    expect(end.status).toBe("ok");
    expect(end.usage).toEqual(usage(7));
    expect(fs.existsSync(path.join(runDir, end.resultRef!))).toBe(true);
  });
});

describe("parallel()", () => {
  it("is a barrier, calls thunks immediately, maps throws to null, keeps order", async () => {
    const { g } = makeRuntime();
    const started: string[] = [];
    const done: string[] = [];
    const p = g.parallel([
      async () => {
        started.push("slow");
        await sleep(60);
        done.push("slow");
        return "slow-result";
      },
      async () => {
        started.push("thrower");
        throw new Error("nope");
      },
      () => {
        started.push("rejecter");
        return Promise.reject(new Error("nope2"));
      },
      async () => {
        started.push("fast");
        done.push("fast");
        return "fast-result";
      },
    ]);
    expect(started).toEqual(["slow", "thrower", "rejecter", "fast"]); // invoked synchronously
    const results = await p;
    expect(done.sort()).toEqual(["fast", "slow"]); // barrier waited for slow
    expect(results).toEqual(["slow-result", null, null, "fast-result"]);
  });

  it("never rejects even when every thunk fails", async () => {
    const { g } = makeRuntime();
    await expect(
      g.parallel([
        () => {
          throw new Error("sync");
        },
        async () => {
          throw new Error("async");
        },
      ]),
    ).resolves.toEqual([null, null]);
  });

  it("throws synchronously past the 4096-item cap", () => {
    const { g } = makeRuntime();
    const thunks = Array.from({ length: 4097 }, () => async () => 1);
    expect(() => g.parallel(thunks)).toThrow(/4096/);
  });
});

describe("pipeline()", () => {
  it("overlaps stages across items (no barrier)", async () => {
    const { g } = makeRuntime();
    const t0 = Date.now();
    const marks: Record<string, number> = {};
    const results = await g.pipeline(
      ["slow", "fast"],
      async (prev) => {
        await sleep(prev === "slow" ? 120 : 10);
        marks[`stage1-end-${prev}`] = Date.now() - t0;
        return prev;
      },
      async (prev, orig) => {
        marks[`stage2-start-${orig}`] = Date.now() - t0;
        await sleep(5);
        return `${prev}!`;
      },
    );
    expect(results).toEqual(["slow!", "fast!"]); // original order
    expect(marks["stage2-start-fast"]!).toBeLessThan(marks["stage1-end-slow"]!);
  });

  it("passes (prev, originalItem, index) to every stage", async () => {
    const { g } = makeRuntime();
    const calls: Array<[unknown, unknown, number]> = [];
    const results = await g.pipeline(
      ["a", "b"],
      (prev, orig, i) => {
        calls.push([prev, orig, i]);
        return `${prev}1`;
      },
      (prev, orig, i) => {
        calls.push([prev, orig, i]);
        return `${prev}2`;
      },
    );
    expect(results).toEqual(["a12", "b12"]);
    expect(calls).toContainEqual(["a", "a", 0]); // stage1 prev = item
    expect(calls).toContainEqual(["a1", "a", 0]);
    expect(calls).toContainEqual(["b", "b", 1]);
    expect(calls).toContainEqual(["b1", "b", 1]);
  });

  it("stage throw → item null, remaining stages skipped", async () => {
    const { g } = makeRuntime();
    const stage2Seen: number[] = [];
    const results = await g.pipeline(
      [0, 1],
      async (prev, _orig, i) => {
        if (i === 0) throw new Error("stage1 died");
        return prev;
      },
      async (prev, _orig, i) => {
        stage2Seen.push(i);
        return prev;
      },
    );
    expect(results).toEqual([null, 1]);
    expect(stage2Seen).toEqual([1]);
  });

  it("throws synchronously past the 4096-item cap", () => {
    const { g } = makeRuntime();
    const items = Array.from({ length: 4097 }, (_, i) => i);
    expect(() => g.pipeline(items, (x) => x)).toThrow(/4096/);
  });
});

describe("budget", () => {
  it("usage ticks push spent() over total → next agent() throws; dedupes cumulative ticks", async () => {
    const executor: Executor = {
      backend: "codex",
      async run(_req, ctx) {
        ctx.onUsage(usage(60));
        ctx.onUsage(usage(120)); // cumulative, replaces the 60
        return { ok: true, text: "done", usage: usage(120) };
      },
    };
    const { g } = makeRuntime({ executor, budgetTotal: 100 });
    expect(g.budget.total).toBe(100);
    await expect(g.agent("first")).resolves.toBe("done");
    expect(g.budget.spent()).toBe(120); // latest cumulative, not 60+120+120
    expect(g.budget.remaining()).toBe(0);
    await expect(g.agent("second")).rejects.toThrow(/budget/i);
  });

  it("remaining() is Infinity when total is null", () => {
    const { g } = makeRuntime({ budgetTotal: null });
    expect(g.budget.total).toBeNull();
    expect(g.budget.remaining()).toBe(Infinity);
    expect(g.budget.spent()).toBe(0);
  });
});

describe("control: pause / resume / skip / stop", () => {
  it("pause blocks new dispatch even with free slots; resume releases FIFO", async () => {
    const { executor, calls } = deferredExecutor();
    const { g, controller, runDir } = makeRuntime({ executor, concurrency: 2 });

    const p1 = g.agent("one");
    await until(() => calls.length === 1);
    controller.pause();

    const p2 = g.agent("two");
    await sleep(80);
    expect(calls.length).toBe(1); // gated despite a free slot

    controller.resume();
    await until(() => calls.length === 2);
    expect(calls[1]!.req.prompt).toBe("two");

    calls[0]!.resolve({ ok: true, text: "r1", usage: usage(1) });
    calls[1]!.resolve({ ok: true, text: "r2", usage: usage(1) });
    expect(await p1).toBe("r1");
    expect(await p2).toBe("r2");

    const types = readJournal(runDir).map((e) => e.t);
    expect(types).toContain("paused");
    expect(types).toContain("resumed");
    expect(types.indexOf("paused")).toBeLessThan(types.indexOf("resumed"));
  });

  it("queues excess agents FIFO under the concurrency cap", async () => {
    const { executor, calls } = deferredExecutor();
    const { g } = makeRuntime({ executor, concurrency: 1 });
    const pa = g.agent("A");
    const pb = g.agent("B");
    const pc = g.agent("C");
    await until(() => calls.length === 1);
    expect(calls[0]!.req.prompt).toBe("A");
    calls[0]!.resolve({ ok: true, text: "a", usage: usage(0) });
    await until(() => calls.length === 2);
    expect(calls[1]!.req.prompt).toBe("B");
    calls[1]!.resolve({ ok: true, text: "b", usage: usage(0) });
    await until(() => calls.length === 3);
    expect(calls[2]!.req.prompt).toBe("C");
    calls[2]!.resolve({ ok: true, text: "c", usage: usage(0) });
    expect(await Promise.all([pa, pb, pc])).toEqual(["a", "b", "c"]);
  });

  it("skip mid-flight → null + skipped status, even if the executor later returns ok", async () => {
    const { executor, calls } = deferredExecutor();
    const { g, controller, runDir } = makeRuntime({ executor });
    const p = g.agent("victim");
    await until(() => calls.length === 1);
    controller.skip(1);
    // Abort waits for the executor to settle; it settling ok AFTER the abort
    // must not change the outcome.
    calls[0]!.resolve({ ok: true, text: "too late", usage: usage(9) });
    expect(await p).toBeNull();

    await sleep(30);
    const end = ends(runDir);
    expect(end).toHaveLength(1);
    expect(end[0]!.status).toBe("skipped");
    expect(end[0]!.error).toBeNull();
  });

  it("skip on a queued agent resolves it null without dispatching", async () => {
    const { executor, calls } = deferredExecutor();
    const { g, controller, runDir } = makeRuntime({ executor, concurrency: 1 });
    const p1 = g.agent("running");
    const p2 = g.agent("queued");
    await until(() => calls.length === 1);
    controller.skip(2);
    expect(await p2).toBeNull();
    expect(calls.length).toBe(1); // never dispatched
    const skippedEnd = ends(runDir).find((e) => e.n === 2);
    expect(skippedEnd!.status).toBe("skipped");

    calls[0]!.resolve({ ok: true, text: "fine", usage: usage(0) });
    expect(await p1).toBe("fine");
  });

  it("stop aborts in-flight + queued; subsequent agent() resolves null", async () => {
    const { executor, calls } = deferredExecutor();
    const { g, controller, runDir } = makeRuntime({ executor, concurrency: 1 });
    const p1 = g.agent("in-flight");
    const p2 = g.agent("queued");
    await until(() => calls.length === 1);

    expect(controller.stopped).toBe(false);
    controller.stop();
    expect(controller.stopped).toBe(true);
    // in-flight executor settles in response to the abort; late ok is ignored
    calls[0]!.resolve({ ok: true, text: "late", usage: usage(0) });
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();

    const e = ends(runDir);
    expect(e.map((x) => x.status)).toEqual(["skipped", "skipped"]);

    // after stop: resolves null with no new journal entries
    expect(await g.agent("post-stop")).toBeNull();
    expect(starts(runDir)).toHaveLength(2);

    const totals = controller.totals();
    expect(totals.skipped).toBe(2);
    expect(totals.ok).toBe(0);
  });

  it("post-stop agent() yields a macrotask so tight null-tolerant loops can't starve timers", async () => {
    const { g, controller } = makeRuntime();
    controller.stop();

    let timerFired = false;
    setTimeout(() => {
      timerFired = true;
    }, 20);

    // A null-tolerant unbounded loop: without a macrotask yield in the
    // post-stop path this spins the microtask queue and the timer never runs.
    let iterations = 0;
    while (!timerFired) {
      iterations += 1;
      if (iterations > 100_000) break; // safety valve: fail instead of hanging
      await g.agent("spin");
    }
    expect(timerFired).toBe(true);
    expect(iterations).toBeLessThanOrEqual(100_000);
  });

  it("abort waits for executor settlement before agent_end and before freeing the slot", async () => {
    // Executor that honors the abort signal but takes 60ms to wind down.
    const calls: DeferredCall[] = [];
    const executor: Executor = {
      backend: "codex",
      run(req, ctx) {
        return new Promise<ExecutorResult>((resolve) => {
          calls.push({ req, ctx, resolve });
          ctx.signal.addEventListener(
            "abort",
            () => setTimeout(() => resolve({ ok: false, error: "interrupted" }), 60),
            { once: true },
          );
        });
      },
    };
    const { g, controller, runDir } = makeRuntime({ executor, concurrency: 1 });
    const p1 = g.agent("victim");
    await until(() => calls.length === 1);
    const p2 = g.agent("next-in-line");

    controller.skip(1);
    await sleep(20); // abort delivered, executor still winding down
    expect(ends(runDir)).toHaveLength(0); // no agent_end while process is live
    expect(calls.length).toBe(1); // slot not freed → agent 2 not dispatched

    expect(await p1).toBeNull();
    expect(ends(runDir)[0]!.status).toBe("skipped");

    await until(() => calls.length === 2); // slot freed only after settlement
    calls[1]!.resolve({ ok: true, text: "second", usage: usage(1) });
    expect(await p2).toBe("second");
  });

  it("drops activity/usage arriving after agent_end (no journal events past the end)", async () => {
    let captured: ExecutorContext | null = null;
    const executor: Executor = {
      backend: "codex",
      async run(_req, ctx) {
        captured = ctx;
        return { ok: true, text: "done", usage: usage(1) };
      },
    };
    const { g, runDir } = makeRuntime({ executor });
    await g.agent("quick");
    expect(ends(runDir)).toHaveLength(1);

    captured!.onActivity({ kind: "exec", text: "late activity" });
    captured!.onUsage(usage(999));
    await sleep(300); // let any throttle timer flush

    const events = readJournal(runDir);
    const endIdx = events.findIndex((e) => e.t === "agent_end");
    expect(events.slice(endIdx + 1).filter((e) => e.t === "agent_activity")).toHaveLength(0);
    expect(events.slice(endIdx + 1).filter((e) => e.t === "agent_usage")).toHaveLength(0);
  });

  it("totals() folds statuses and per-backend usage ledgers", async () => {
    const executor: Executor = {
      backend: "codex",
      async run(req) {
        if (req.prompt === "bad") return { ok: false, error: "x", usage: usage(5) };
        return { ok: true, text: "y", usage: usage(10, 4) };
      },
    };
    const { g, controller } = makeRuntime({ executor });
    await g.agent("good");
    await g.agent("bad");
    const t = controller.totals();
    expect(t.agents).toBe(2);
    expect(t.ok).toBe(1);
    expect(t.failed).toBe(1);
    expect(t.skipped).toBe(0);
    expect(t.usage["codex"]!.outputTokens).toBe(15);
    expect(t.usage["codex"]!.inputTokens).toBe(4);
    expect(t.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("caps", () => {
  it("throws after the 1000-agent lifetime cap (nested calls share the counter)", async () => {
    const executor: Executor = {
      backend: "codex",
      run: async () => ({ ok: true, text: "k", usage: usage(0) }),
    };
    const { g } = makeRuntime({ executor, concurrency: 16 });
    for (let i = 0; i < 1000; i += 50) {
      const batch = Array.from({ length: 50 }, () => g.agent("cheap"));
      const results = await Promise.all(batch);
      expect(results.every((r) => r === "k")).toBe(true);
    }
    await expect(g.agent("one too many")).rejects.toThrow(/cap/i);
  });
});

describe("phase() and log()", () => {
  it("journals phase events and defaults agent phase; opts.phase overrides", async () => {
    const { g, runDir } = makeRuntime();
    g.phase("Draft");
    await g.agent("write", { label: "writer" });
    await g.agent("check", { label: "checker", phase: "Verify" });
    g.log("all done");
    g.log(42 as unknown as string); // String() coercion

    const events = readJournal(runDir);
    const phase = events.find((e) => e.t === "phase");
    expect((phase as { title: string }).title).toBe("Draft");
    const s = starts(runDir);
    expect(s[0]!.phase).toBe("Draft");
    expect(s[1]!.phase).toBe("Verify");
    const logs = events.filter((e) => e.t === "log") as Array<{ text: string }>;
    expect(logs.map((l) => l.text)).toEqual(["all done", "42"]);
  });
});

describe("workflow()", () => {
  function childDeps(executor: Executor) {
    const loadChildWorkflow: RuntimeDeps["loadChildWorkflow"] = (ref) => {
      if (ref === "child") {
        return {
          meta: { name: "child", description: "child wf" },
          body: async (g) => {
            g.phase("Work");
            const r = await g.agent("child task", { label: "child-agent" });
            return { childResult: r };
          },
        };
      }
      if (ref === "nester") {
        return {
          meta: { name: "nester", description: "tries to nest" },
          body: async (g) => {
            await g.workflow("child");
          },
        };
      }
      throw new Error(`unknown workflow ${JSON.stringify(ref)}`);
    };
    return makeRuntime({ executor, loadChildWorkflow });
  }

  it("shares ordinals + budget with the child; prefixes child phases", async () => {
    const executor: Executor = {
      backend: "codex",
      run: async () => ({ ok: true, text: "ok", usage: usage(10) }),
    };
    const { g, runDir } = childDeps(executor);

    await g.agent("parent first", { label: "p1" });
    const childValue = await g.workflow("child", { seed: 5 });
    await g.agent("parent last", { label: "p2" });

    expect(childValue).toEqual({ childResult: "ok" });

    const s = starts(runDir);
    expect(s.map((e) => e.n)).toEqual([1, 2, 3]); // global ordinals across the child
    expect(s[1]!.label).toBe("child-agent");
    expect(s[1]!.phase).toBe("child ▸ Work");

    const phases = readJournal(runDir).filter((e) => e.t === "phase") as Array<{ title: string }>;
    expect(phases.map((p) => p.title)).toEqual(["child ▸ Work"]);

    expect(g.budget.spent()).toBe(30); // 3 agents × 10 output tokens, shared ledger
  });

  it("child receives its own args; parent phase state is untouched", async () => {
    let childArgs: unknown;
    const loadChildWorkflow: RuntimeDeps["loadChildWorkflow"] = () => ({
      meta: { name: "argsy", description: "" },
      body: async (g) => {
        childArgs = g.args;
        return "done";
      },
    });
    const { g, runDir } = makeRuntime({ loadChildWorkflow });
    g.phase("Parent Phase");
    await g.workflow("argsy", ["a", "b"]);
    expect(childArgs).toEqual(["a", "b"]);
    await g.agent("after child");
    expect(starts(runDir)[0]!.phase).toBe("Parent Phase"); // no child prefix leaked
  });

  it("child calling workflow() throws (one level of nesting only)", async () => {
    const { g } = childDeps(okExecutor("ok"));
    await expect(g.workflow("nester")).rejects.toThrow(/one level/i);
  });

  it("propagates loadChildWorkflow errors as throws the script can catch", async () => {
    const { g } = childDeps(okExecutor("ok"));
    await expect(g.workflow("missing")).rejects.toThrow(/unknown workflow/);
  });
});

describe("agent_start model/effort resolution (journal = what actually runs)", () => {
  it("journals the config default model+effort when opts omit them", async () => {
    const { g, journal, runDir } = makeRuntime();
    await g.agent("hello");
    journal.close();
    const start = starts(runDir)[0]!;
    expect(start.model).toBe(DEFAULT_CONFIG.codex.defaultModel);
    expect(start.effort).toBe(DEFAULT_CONFIG.codex.defaultEffort);
  });

  it("journals the mapped tier when opts.model/effort are tier names", async () => {
    const { g, journal, runDir } = makeRuntime();
    await g.agent("hello", { model: "haiku", effort: "max" });
    journal.close();
    const start = starts(runDir)[0]!;
    expect(start.model).toBe(DEFAULT_CONFIG.codex.modelMap["haiku"]);
    expect(start.effort).toBe("xhigh");
  });
});
