// Parent-verify live smoke: REAL opencode serve over REAL HTTP.
// Runs only with LIVE_OPENCODE=1 — never in the default suite (spawns the
// real binary, hits a real provider).
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_OPENCODE_CONFIG } from "../src/constants.js";
import { OpencodeExecutor } from "../src/executor/opencode.js";
import type { ExecutorContext, Usage } from "../src/types.js";

const LIVE = process.env.LIVE_OPENCODE === "1";

function ctx(): { ctx: ExecutorContext; usages: Usage[]; threads: string[] } {
  const usages: Usage[] = [];
  const threads: string[] = [];
  return {
    ctx: {
      signal: new AbortController().signal,
      onActivity: () => {},
      onUsage: (u) => usages.push(u),
      onThread: (t) => threads.push(t),
    },
    usages,
    threads,
  };
}

describe.skipIf(!LIVE)("live opencode smoke (real serve, real HTTP)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ucx-live-smoke-"));
  const exec = new OpencodeExecutor({ ...DEFAULT_OPENCODE_CONFIG }, {});

  test("text call round-trips with usage and threadId", async () => {
    const c = ctx();
    const res = await exec.run(
      { prompt: "Reply with exactly the word: smoke-ok", cwd, label: "live:text" },
      c.ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("smoke-ok");
      expect(res.usage.outputTokens).toBeGreaterThan(0);
      expect(res.threadId).toMatch(/^ses_/);
    }
    expect(c.threads).toHaveLength(1);
    expect(c.usages.length).toBeGreaterThan(0);
  }, 180_000);

  test("schema call returns a validated object via wire format", async () => {
    const c = ctx();
    const res = await exec.run(
      {
        prompt: "Return the word alpha.",
        schema: {
          type: "object",
          properties: { word: { type: "string" }, note: { type: "string" } },
          required: ["word"],
        },
        cwd,
        label: "live:schema",
      },
      c.ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.object as { word: string }).word.toLowerCase()).toContain("alpha");
      expect(res.text).toBeUndefined();
    }
  }, 180_000);
});
