// The fake over REAL TCP + the adapter's fetch transport. The main opencode
// suites force FAKE_OPENCODE_STDIO_HTTP=1 so they stay green inside sandboxes
// that block listen(); this file covers the fetch/announce-line path those
// suites cannot, and self-skips where listen() is denied.
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPENCODE_CONFIG, INTERRUPT_GRACE_MS } from "../src/constants.js";
import { OpencodeExecutor } from "../src/executor/opencode.js";
import type { ExecutorContext, Usage } from "../src/types.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-opencode", "opencode");

function canListen(): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(0, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}
const TCP = await canListen();

function makeCtx(signal?: AbortSignal) {
  const usages: Usage[] = [];
  const threads: string[] = [];
  const ctx: ExecutorContext = {
    signal: signal ?? new AbortController().signal,
    onActivity: () => {},
    onUsage: (u) => usages.push(u),
    onThread: (t) => threads.push(t),
  };
  return { ctx, usages, threads };
}

function tmpCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ucx-opencode-tcp-"));
}

describe.skipIf(!TCP)("opencode adapter over real TCP (fetch transport)", () => {
  const exec = new OpencodeExecutor({ ...DEFAULT_OPENCODE_CONFIG, binary: FAKE }, {});

  test("text call round-trips through a real bound port", async () => {
    const { ctx, usages, threads } = makeCtx();
    const res = await exec.run({ prompt: "[[reply:tcp-ok]]", cwd: tmpCwd(), label: "tcp:text" }, ctx);
    expect(res).toEqual(expect.objectContaining({ ok: true, text: "tcp-ok" }));
    expect(threads).toHaveLength(1);
    expect(usages.length).toBeGreaterThan(0);
  });

  test("schema call returns the structured object via wire format", async () => {
    const { ctx } = makeCtx();
    const res = await exec.run(
      {
        prompt: '[[structured:{"word":"alpha"}]]',
        schema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
        cwd: tmpCwd(),
        label: "tcp:schema",
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.object).toEqual({ word: "alpha" });
  });

  test("abort mid-turn settles within the grace window", async () => {
    const abort = new AbortController();
    const { ctx } = makeCtx(abort.signal);
    const started = Date.now();
    const pending = exec.run({ prompt: "[[hang]]", cwd: tmpCwd(), label: "tcp:abort" }, ctx);
    setTimeout(() => abort.abort(), 300);
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(300 + INTERRUPT_GRACE_MS);
  });
});
