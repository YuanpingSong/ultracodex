import fs from "node:fs";
import path from "node:path";
import {
  ACTIVITY_TEXT_MAX,
  ACTIVITY_THROTTLE_MS,
  FANOUT_ITEM_CAP,
  INTERRUPT_GRACE_MS,
  LIFETIME_AGENT_CAP,
} from "./constants.js";
import { resolveClaudeModel, resolveCodexEffort, resolveCodexModel, routeBackend } from "./config.js";
import { sha256Hex } from "./ids.js";
import { agentDir } from "./rundir.js";
import type { JournalWriter } from "./journal.js";
import type {
  AgentOpts,
  AgentStatus,
  BudgetView,
  Executor,
  ExecutorContext,
  ExecutorRequest,
  ExecutorResult,
  PipelineStage,
  RunOptions,
  RunTotals,
  UltracodexConfig,
  Usage,
  WorkflowGlobals,
  WorkflowMeta,
} from "./types.js";
import { ZERO_USAGE, addUsage } from "./types.js";

export interface RuntimeDeps {
  journal: JournalWriter;
  executors: Record<string, Executor>;
  config: UltracodexConfig;
  options: RunOptions;
  meta: WorkflowMeta;
  /** Resolve + load a saved workflow or scriptPath for the workflow() global. */
  loadChildWorkflow(nameOrRef: string | { scriptPath: string }): {
    meta: WorkflowMeta;
    body: (g: WorkflowGlobals) => Promise<unknown>;
  };
}

export interface Runtime {
  globals: WorkflowGlobals;
  controller: RunController;
}

export interface RunController {
  pause(): void;
  resume(): void;
  stop(): void;
  skip(n: number): void;
  readonly stopped: boolean;
  totals(): RunTotals;
}

const ABORTED = Symbol("aborted");

/** Counting FIFO semaphore with a pause gate and a permanent close (stop). */
class Semaphore {
  private available: number;
  private paused = false;
  private closed = false;
  private queue: Array<{
    resolve: (acquired: boolean) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(slots: number) {
    this.available = Math.max(1, slots);
  }

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.closed) return Promise.resolve(false);
    if (!this.paused && this.available > 0) {
      this.available -= 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const entry = { resolve, signal, onAbort: () => {} };
      entry.onAbort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        resolve(false);
      };
      signal.addEventListener("abort", entry.onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  release(): void {
    this.available += 1;
    this.flush();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.flush();
  }

  close(): void {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.signal.removeEventListener("abort", entry.onAbort);
      entry.resolve(false);
    }
  }

  private flush(): void {
    while (!this.paused && !this.closed && this.available > 0) {
      const entry = this.queue.shift();
      if (!entry) return;
      entry.signal.removeEventListener("abort", entry.onAbort);
      this.available -= 1;
      entry.resolve(true);
    }
  }
}

/** Min-interval, latest-wins emitter (trailing edge). */
class Throttle {
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => void) | null = null;

  constructor(private readonly ms: number) {}

  push(emit: () => void): void {
    const now = Date.now();
    if (this.timer === null && now - this.last >= this.ms) {
      this.last = now;
      emit();
      return;
    }
    this.pending = emit;
    if (this.timer === null) {
      const wait = Math.max(0, this.ms - (now - this.last));
      this.timer = setTimeout(() => {
        this.timer = null;
        const p = this.pending;
        this.pending = null;
        if (p) {
          this.last = Date.now();
          p();
        }
      }, wait);
      this.timer.unref?.();
    }
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

interface WfContext {
  /** Child workflow name for journal display prefixing; null at root. */
  prefix: string | null;
  /** Raw (unprefixed) current phase set by phase(). */
  currentPhase: string | null;
  depth: number;
}

function defaultLabel(prompt: string): string {
  const first = (prompt.split("\n")[0] ?? "").trim().slice(0, 40);
  return first || "agent";
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  const { journal, executors, config, options } = deps;
  const runDir = options.runDir;
  const runStartTs = Date.now();

  const sem = new Semaphore(options.concurrency);
  const counter = { n: 0 };
  const controllers = new Map<number, AbortController>();
  /** backend → agent ordinal → latest cumulative usage for that agent call. */
  const ledgers = new Map<string, Map<number, Usage>>();
  const statusCounts: Record<AgentStatus, number> = { ok: 0, failed: 0, skipped: 0 };
  let stopped = false;
  let paused = false;

  function ledgerSet(backend: string, n: number, usage: Usage): void {
    let m = ledgers.get(backend);
    if (!m) {
      m = new Map();
      ledgers.set(backend, m);
    }
    m.set(n, usage);
  }

  function ledgerGet(backend: string, n: number): Usage {
    return ledgers.get(backend)?.get(n) ?? ZERO_USAGE;
  }

  function spent(): number {
    let total = 0;
    for (const m of ledgers.values()) {
      for (const u of m.values()) total += u.outputTokens;
    }
    return total;
  }

  const budget: BudgetView = {
    total: options.budgetTotal,
    spent,
    remaining(): number {
      return options.budgetTotal === null
        ? Infinity
        : Math.max(0, options.budgetTotal - spent());
    },
  };

  function resolveDisplay(
    backend: string,
    opts: AgentOpts,
  ): { model: string | null; effort: string | null } {
    if (backend === "codex") {
      return {
        model: resolveCodexModel(config.codex, opts.model),
        effort: resolveCodexEffort(config.codex, opts.effort),
      };
    }
    if (backend === "claude") {
      return {
        model: resolveClaudeModel(config.claude, opts.model),
        effort: opts.effort ?? null,
      };
    }
    return { model: opts.model ?? null, effort: opts.effort ?? null };
  }

  function prefixed(ctx: WfContext, title: string): string {
    return ctx.prefix ? `${ctx.prefix} ▸ ${title}` : title;
  }

  async function runAgent(
    ctx: WfContext,
    prompt: string,
    opts: AgentOpts = {},
  ): Promise<unknown> {
    // Scripts are plain JS: coerce non-string prompts / null opts instead of
    // throwing (agent() never throws except budget/caps).
    prompt = typeof prompt === "string" ? prompt : String(prompt);
    opts = opts ?? {};
    if (stopped) {
      // Yield a macrotask so a null-tolerant `while (true)` loop over agent()
      // can't starve timers/signals by spinning the microtask queue.
      await yieldMacrotask();
      return null;
    }
    counter.n += 1;
    const n = counter.n;
    if (n > LIFETIME_AGENT_CAP) {
      throw new Error(
        `Lifetime agent cap exceeded: at most ${LIFETIME_AGENT_CAP} agent() calls per run`,
      );
    }
    if (budget.total !== null && spent() >= budget.total) {
      throw new Error(
        `Token budget exceeded: spent ${spent()} of ${budget.total} output tokens`,
      );
    }

    const label = opts.label ?? defaultLabel(prompt);
    const rawPhase = opts.phase ?? ctx.currentPhase;
    const backend = routeBackend(config, label, rawPhase);
    const executor: Executor | undefined = executors[backend];
    const display = resolveDisplay(backend, opts);

    const ac = new AbortController();
    controllers.set(n, ac);
    let acquired = false;
    const actThrottle = new Throttle(ACTIVITY_THROTTLE_MS);
    const usageThrottle = new Throttle(ACTIVITY_THROTTLE_MS);

    try {
      acquired = await sem.acquire(ac.signal);

      // Agent-dir/prompt snapshot I/O must never throw out of agent(): degrade
      // to a warn + failed agent instead.
      let dir: string | null = null;
      let promptRef = "";
      let snapshotError: string | null = null;
      try {
        dir = agentDir(runDir, n, label);
        const promptPath = path.join(dir, "prompt.md");
        fs.writeFileSync(promptPath, prompt, "utf8");
        promptRef = path.relative(runDir, promptPath);
      } catch (err) {
        snapshotError = `agent dir/prompt snapshot failed: ${errMsg(err)}`;
        journal.append({ t: "warn", ts: Date.now(), text: `agent ${n}: ${snapshotError}` });
      }
      const startTs = Date.now();
      journal.append({
        t: "agent_start",
        ts: startTs,
        n,
        label,
        phase: rawPhase === null ? null : prefixed(ctx, rawPhase),
        backend,
        model: display.model,
        effort: display.effort,
        promptSha: sha256Hex(prompt),
        promptRef,
        hasSchema: opts.schema !== undefined,
      });

      let ended = false;
      const end = (
        status: AgentStatus,
        usage: Usage,
        resultRef: string | null,
        error: string | null,
        worktreePath?: string,
      ): void => {
        ended = true;
        actThrottle.cancel();
        usageThrottle.cancel();
        statusCounts[status] += 1;
        const ev = {
          t: "agent_end" as const,
          ts: Date.now(),
          n,
          status,
          ms: Date.now() - startTs,
          usage,
          resultRef,
          error,
        };
        journal.append(worktreePath ? { ...ev, worktreePath } : ev);
      };

      if (!acquired || ac.signal.aborted) {
        end("skipped", ledgerGet(backend, n), null, null);
        return null;
      }
      if (snapshotError !== null || dir === null) {
        end("failed", ZERO_USAGE, null, snapshotError ?? "agent dir setup failed");
        return null;
      }
      if (!executor) {
        end("failed", ZERO_USAGE, null, `no executor for backend "${backend}"`);
        return null;
      }

      let cwd = options.projectDir;
      let wtPath: string | null = null;
      if (opts.isolation === "worktree") {
        try {
          const wt = await import("./worktree.js");
          wtPath = await wt.createWorktree(options.projectDir, runDir, n);
          cwd = wtPath;
        } catch (err) {
          end("failed", ZERO_USAGE, null, `worktree setup failed: ${errMsg(err)}`);
          return null;
        }
      }

      const eventsPath = path.join(dir, "events.jsonl");
      let threadSeen = false;
      const execCtx: ExecutorContext = {
        signal: ac.signal,
        onActivity(ev) {
          try {
            fs.appendFileSync(eventsPath, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
          } catch {
            // raw stream is best-effort
          }
          if (ended) return; // never journal activity after agent_end
          actThrottle.push(() =>
            journal.append({
              t: "agent_activity",
              ts: Date.now(),
              n,
              kind: ev.kind,
              text: ev.text.slice(0, ACTIVITY_TEXT_MAX),
              phase: ev.phase,
            }),
          );
        },
        onUsage(usage) {
          ledgerSet(backend, n, usage);
          if (ended) return; // never journal usage after agent_end
          usageThrottle.push(() =>
            journal.append({ t: "agent_usage", ts: Date.now(), n, usage }),
          );
        },
        onThread(threadId) {
          if (threadSeen || ended) return;
          threadSeen = true;
          journal.append({ t: "agent_thread", ts: Date.now(), n, threadId });
        },
      };

      const req: ExecutorRequest = {
        prompt,
        schema: opts.schema,
        model: opts.model,
        effort: opts.effort,
        cwd,
        label,
        agentProfile: opts.agentType,
      };

      const abortP = new Promise<typeof ABORTED>((resolve) => {
        if (ac.signal.aborted) resolve(ABORTED);
        else ac.signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
      });
      const runP: Promise<ExecutorResult> = Promise.resolve()
        .then(() => executor.run(req, execCtx))
        .catch((err) => ({ ok: false as const, error: errMsg(err) }));

      let outcome = await Promise.race([runP, abortP]);
      if (ac.signal.aborted) outcome = ABORTED;
      if (outcome === ABORTED) {
        // The executor handles the AbortSignal (interrupt → kill) and settles.
        // Wait (bounded) for that settlement so we never tear down the
        // worktree or free the concurrency slot under a live process.
        await Promise.race([runP, sleep(INTERRUPT_GRACE_MS)]);
      }

      let worktreePath: string | undefined;
      if (wtPath !== null) {
        try {
          const wt = await import("./worktree.js");
          const { kept } = await wt.cleanupWorktree(options.projectDir, wtPath);
          if (kept) {
            worktreePath = wtPath;
            journal.append({
              t: "warn",
              ts: Date.now(),
              text: `agent ${n} left changes behind in worktree ${wtPath}`,
            });
          }
        } catch (err) {
          worktreePath = wtPath;
          journal.append({
            t: "warn",
            ts: Date.now(),
            text: `worktree cleanup failed for agent ${n}: ${errMsg(err)}`,
          });
        }
      }

      if (outcome === ABORTED) {
        end("skipped", ledgerGet(backend, n), null, null, worktreePath);
        return null;
      }
      if (!outcome.ok) {
        if (outcome.usage) ledgerSet(backend, n, outcome.usage);
        end("failed", ledgerGet(backend, n), null, outcome.error, worktreePath);
        return null;
      }

      ledgerSet(backend, n, outcome.usage);
      let value: unknown;
      let resultRef: string | null = null;
      try {
        let outPath: string;
        if (outcome.object !== undefined) {
          outPath = path.join(dir, "output.json");
          fs.writeFileSync(outPath, JSON.stringify(outcome.object, null, 2), "utf8");
          value = outcome.object;
        } else {
          const text = outcome.text ?? "";
          outPath = path.join(dir, "output.txt");
          fs.writeFileSync(outPath, text, "utf8");
          value = text;
        }
        resultRef = path.relative(runDir, outPath);
      } catch (err) {
        // Output snapshot is best-effort: the value is in memory, keep going.
        value = outcome.object !== undefined ? outcome.object : (outcome.text ?? "");
        journal.append({
          t: "warn",
          ts: Date.now(),
          text: `agent ${n}: output snapshot failed: ${errMsg(err)}`,
        });
      }
      end("ok", outcome.usage, resultRef, null, worktreePath);
      return value;
    } finally {
      actThrottle.cancel();
      usageThrottle.cancel();
      controllers.delete(n);
      if (acquired) sem.release();
    }
  }

  async function runChain(
    item: unknown,
    index: number,
    stages: PipelineStage[],
  ): Promise<unknown> {
    let prev: unknown = item;
    try {
      for (const stage of stages) {
        prev = await stage(prev, item, index);
      }
      return prev;
    } catch {
      return null;
    }
  }

  function loadArgs(): unknown {
    if (!options.argsPath) return undefined;
    const abs = path.isAbsolute(options.argsPath)
      ? options.argsPath
      : path.join(runDir, options.argsPath);
    try {
      return JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
      return undefined;
    }
  }

  function makeGlobals(ctx: WfContext, args: unknown): WorkflowGlobals {
    return {
      agent: (prompt, opts) => runAgent(ctx, prompt, opts),
      parallel: (thunks) => {
        if (thunks.length > FANOUT_ITEM_CAP) {
          throw new Error(
            `parallel() accepts at most ${FANOUT_ITEM_CAP} items (got ${thunks.length})`,
          );
        }
        return Promise.all(
          thunks.map((thunk) => {
            try {
              return Promise.resolve(thunk()).catch(() => null);
            } catch {
              return Promise.resolve(null);
            }
          }),
        );
      },
      pipeline: (items, ...stages) => {
        if (items.length > FANOUT_ITEM_CAP) {
          throw new Error(
            `pipeline() accepts at most ${FANOUT_ITEM_CAP} items (got ${items.length})`,
          );
        }
        return Promise.all(items.map((item, i) => runChain(item, i, stages)));
      },
      phase: (title) => {
        ctx.currentPhase = title;
        journal.append({ t: "phase", ts: Date.now(), title: prefixed(ctx, title) });
      },
      log: (message) => {
        journal.append({ t: "log", ts: Date.now(), text: String(message) });
      },
      args,
      budget,
      workflow: async (nameOrRef, childArgs) => {
        if (ctx.depth >= 1) {
          throw new Error("workflow() nesting is limited to one level");
        }
        const child = deps.loadChildWorkflow(nameOrRef);
        const childCtx: WfContext = {
          prefix: child.meta.name,
          currentPhase: null,
          depth: ctx.depth + 1,
        };
        return child.body(makeGlobals(childCtx, childArgs));
      },
    };
  }

  const controller: RunController = {
    pause(): void {
      if (paused || stopped) return;
      paused = true;
      sem.pause();
      journal.append({ t: "paused", ts: Date.now() });
    },
    resume(): void {
      if (!paused || stopped) return;
      paused = false;
      sem.resume();
      journal.append({ t: "resumed", ts: Date.now() });
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      sem.close();
      for (const ac of controllers.values()) ac.abort();
    },
    skip(n: number): void {
      controllers.get(n)?.abort();
    },
    get stopped(): boolean {
      return stopped;
    },
    totals(): RunTotals {
      const usage: Record<string, Usage> = {};
      for (const [backend, m] of ledgers) {
        let sum = ZERO_USAGE;
        for (const u of m.values()) sum = addUsage(sum, u);
        usage[backend] = sum;
      }
      return {
        agents: counter.n,
        ok: statusCounts.ok,
        failed: statusCounts.failed,
        skipped: statusCounts.skipped,
        usage,
        ms: Date.now() - runStartTs,
      };
    },
  };

  const globals = makeGlobals({ prefix: null, currentPhase: null, depth: 0 }, loadArgs());
  return { globals, controller };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

function yieldMacrotask(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
