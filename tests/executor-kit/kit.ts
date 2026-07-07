import { afterEach, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTERRUPT_GRACE_MS } from "../../src/constants.js";
import { createValidator } from "../../src/executor/schema.js";
import { ZERO_USAGE } from "../../src/types.js";
import type { Usage } from "../../src/types.js";
import type { Executor, ExecutorRequest, ExecutorResult } from "../../src/executor/contract.js";

const USAGE_FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

const SETTLE_TIMEOUT_MS = INTERRUPT_GRACE_MS + 5_000;

export interface ExecutorKitHarness {
  tmpDir(prefix?: string): string;
}

export interface ExecutorKitStage {
  request: ExecutorRequest;
  executor?: Executor;
  expectedText?: string;
  expectedObject?: unknown;
  expectedUsage?: Usage;
  errorPattern?: RegExp;
  abortAfterMs?: number;
  orphanPidFile?: string;
  warnings?: () => string[];
  expectedWarnings?: RegExp[];
  cleanup?: () => void | Promise<void>;
}

export type ExecutorKitStager = (h: ExecutorKitHarness) => ExecutorKitStage | Promise<ExecutorKitStage>;

export interface ExecutorKitFailureStager {
  name: string;
  stage: ExecutorKitStager;
}

export interface ExecutorKitAdapter {
  name: string;
  makeExecutor(): Executor;
  stagers: {
    textSuccess: ExecutorKitStager;
    schemaOptional: ExecutorKitStager;
    schemaMapFallback: ExecutorKitStager;
    repairInvalidThenValid: ExecutorKitStager;
    repairAlwaysInvalid: ExecutorKitStager;
    harnessFailure: ExecutorKitStager;
    abortHang: ExecutorKitStager;
    midTurnCrash: ExecutorKitStager;
    usageTicks: ExecutorKitStager;
    sessionId: ExecutorKitStager;
    profileApplication: ExecutorKitStager;
    wireSchemaRejection?: ExecutorKitStager;
    failures: ExecutorKitFailureStager[];
  };
}

type RunOutcome =
  | { kind: "resolved"; result: ExecutorResult }
  | { kind: "rejected"; error: unknown }
  | { kind: "timed-out" };

interface RunRecord {
  outcome: RunOutcome;
  usages: Usage[];
  threads: string[];
  abortAt: number | null;
  settledAt: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) await sleep(20);
  expect(fs.existsSync(filePath)).toBe(true);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (alive(pid) && Date.now() < deadline) await sleep(20);
  expect(alive(pid)).toBe(false);
}

function readPid(filePath: string): number {
  const pid = Number(fs.readFileSync(filePath, "utf8"));
  expect(pid).toBeGreaterThan(0);
  return pid;
}

async function settle<T>(promise: Promise<T>, timeoutMs: number): Promise<T | { timedOut: true }> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function expectResolved(record: RunRecord, label: string): ExecutorResult {
  if (record.outcome.kind === "timed-out") throw new Error(`${label} timed out`);
  if (record.outcome.kind === "rejected") throw new Error(`${label} rejected: ${asError(record.outcome.error)}`);
  return record.outcome.result;
}

function expectOkText(result: ExecutorResult, expected?: string): void {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  if (expected !== undefined) expect(result.text).toBe(expected);
  expect(result.text).toEqual(expect.any(String));
  expect(result.object).toBeUndefined();
}

function expectOkObject(result: ExecutorResult, stage: ExecutorKitStage): void {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.object).toEqual(stage.expectedObject);
  expect(result.text).toBeUndefined();
  expect(stage.request.schema).toBeDefined();
  const verdict = createValidator(stage.request.schema!)(JSON.stringify(result.object));
  expect(verdict.ok).toBe(true);
}

function expectFailed(result: ExecutorResult, pattern?: RegExp): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected ok:false");
  if (pattern) expect(result.error).toMatch(pattern);
  else expect(result.error).toEqual(expect.any(String));
}

function expectMonotonic(usages: Usage[]): void {
  for (let i = 1; i < usages.length; i++) {
    for (const field of USAGE_FIELDS) {
      expect(usages[i]![field]).toBeGreaterThanOrEqual(usages[i - 1]![field]);
    }
  }
}

function finalUsage(result: ExecutorResult): Usage | undefined {
  return result.ok ? result.usage : result.usage;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "executor";
}

export function registerExecutorKit(adapter: ExecutorKitAdapter): void {
  const capabilities = adapter.makeExecutor().capabilities;
  const dirs: string[] = [];
  const harness: ExecutorKitHarness = {
    tmpDir(prefix = `ultracodex-${slug(adapter.name)}-`) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
  };

  const run = async (stage: ExecutorKitStage): Promise<RunRecord> => {
    const usages: Usage[] = [];
    const threads: string[] = [];
    const ac = new AbortController();
    const executor = stage.executor ?? adapter.makeExecutor();
    const promise = executor.run(stage.request, {
      signal: ac.signal,
      onActivity: () => {},
      onUsage: (u) => usages.push(u),
      onThread: (id) => threads.push(id),
    }).then(
      (result): RunOutcome => ({ kind: "resolved", result }),
      (error): RunOutcome => ({ kind: "rejected", error }),
    );

    let abortAt: number | null = null;
    try {
      if (stage.orphanPidFile) await waitForFile(stage.orphanPidFile, 2_000);
      if (stage.abortAfterMs !== undefined) {
        await sleep(stage.abortAfterMs);
        abortAt = Date.now();
        ac.abort();
      }
    } catch (err) {
      if (!ac.signal.aborted) {
        abortAt = Date.now();
        ac.abort();
      }
      await settle(promise, 1_000);
      throw err;
    }

    const outcome = await settle(promise, SETTLE_TIMEOUT_MS);
    return {
      outcome: "timedOut" in outcome ? { kind: "timed-out" } : outcome,
      usages,
      threads,
      abortAt,
      settledAt: Date.now(),
    };
  };

  const withRun = async <T>(
    stager: ExecutorKitStager,
    fn: (stage: ExecutorKitStage, record: RunRecord) => T | Promise<T>,
  ): Promise<T> => {
    const stage = await stager(harness);
    try {
      return await fn(stage, await run(stage));
    } finally {
      await stage.cleanup?.();
    }
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true });
      } catch {}
    }
  });

  describe(`${adapter.name} executor contract`, () => {
    test("[#1] text call resolves ok:true with text and no object", async () => {
      await withRun(adapter.stagers.textSuccess, (stage, record) => {
        expectOkText(expectResolved(record, "text success"), stage.expectedText);
      });
    });

    test("[#2] schema call validates authored optional properties and map-style fallback", async () => {
      await withRun(adapter.stagers.schemaOptional, (stage, record) => {
        expectOkObject(expectResolved(record, "schema optional"), stage);
      });

      await withRun(adapter.stagers.schemaMapFallback, (stage, record) => {
        expectOkObject(expectResolved(record, "schema map fallback"), stage);
      });
    });

    test("[#3] repair loop succeeds once repaired and exhausts retries as ok:false", async () => {
      await withRun(adapter.stagers.repairInvalidThenValid, (stage, record) => {
        expectOkObject(expectResolved(record, "schema repair"), stage);
        if (capabilities.resume) expect(record.threads).toHaveLength(1);
      });

      await withRun(adapter.stagers.repairAlwaysInvalid, (stage, record) => {
        expectFailed(expectResolved(record, "schema retry exhaustion"), stage.errorPattern);
      });
    });

    if (capabilities.schema === "wire") {
      test("[#4] wire-schema rejection class degrades to prompt-only instead of failing", async () => {
        if (!adapter.stagers.wireSchemaRejection) throw new Error('wireSchemaRejection stager required for schema:"wire"');
        await withRun(adapter.stagers.wireSchemaRejection, (stage, record) => {
          expectOkObject(expectResolved(record, "wire schema rejection"), stage);
        });
      });
    } else {
      test.skip(
        `[#4] skipped: executor.capabilities.schema="${capabilities.schema}" has no wire-schema rejection path`,
        () => {},
      );
    }

    test("[#5] abort settles within interrupt grace and leaves no orphan processes", async () => {
      await withRun(adapter.stagers.abortHang, async (stage, record) => {
        const result = expectResolved(record, "abort hang");
        expectFailed(result, stage.errorPattern);
        expect(record.abortAt).not.toBeNull();
        expect(record.settledAt - record.abortAt!).toBeLessThanOrEqual(INTERRUPT_GRACE_MS);
        if (stage.orphanPidFile) await expectDead(readPid(stage.orphanPidFile));
      });
    });

    test("[#6] usage ticks are cumulative monotonic and final usage matches the last tick", async () => {
      await withRun(adapter.stagers.usageTicks, (stage, record) => {
        const result = expectResolved(record, "usage ticks");
        expectOkText(result, stage.expectedText);

        if (capabilities.usage === "none") {
          expect(record.usages).toHaveLength(0);
          expect(finalUsage(result)).toEqual(ZERO_USAGE);
          return;
        }

        expect(record.usages.length).toBeGreaterThan(0);
        if (capabilities.usage === "per-turn") expect(record.usages.length).toBeGreaterThanOrEqual(2);
        expectMonotonic(record.usages);
        expect(finalUsage(result)).toEqual(record.usages.at(-1));
        if (stage.expectedUsage) expect(finalUsage(result)).toEqual(stage.expectedUsage);
      });
    });

    test("[#7] onThread is emitted exactly once when the harness exposes a session id", async () => {
      await withRun(adapter.stagers.sessionId, (stage, record) => {
        const result = expectResolved(record, "session id");
        expectOkText(result, stage.expectedText);
        expect(record.threads).toHaveLength(1);
        if (result.ok && result.threadId) expect(record.threads[0]).toBe(result.threadId);
      });
    });

    test("[#8] mid-turn harness crash resolves ok:false with a diagnostic", async () => {
      await withRun(adapter.stagers.midTurnCrash, (stage, record) => {
        expectFailed(expectResolved(record, "mid-turn crash"), stage.errorPattern);
      });
    });

    test("[#9] profile preamble alters the prompt and unsupported sandbox warnings do not throw", async () => {
      await withRun(adapter.stagers.profileApplication, (stage, record) => {
        expectOkText(expectResolved(record, "profile application"), stage.expectedText);
        if (stage.warnings) {
          const warnings = stage.warnings();
          for (const pattern of stage.expectedWarnings ?? []) {
            expect(warnings.some((w) => pattern.test(w))).toBe(true);
          }
        }
      });
    });

    test("[#10] run() never rejects for provided failure stagers", async () => {
      expect(adapter.stagers.failures.length).toBeGreaterThan(0);
      for (const failure of adapter.stagers.failures) {
        const stage = await failure.stage(harness);
        try {
          const record = await run(stage);
          const result = expectResolved(record, failure.name);
          expectFailed(result, stage.errorPattern);
        } finally {
          await stage.cleanup?.();
        }
      }
    });
  });
}
