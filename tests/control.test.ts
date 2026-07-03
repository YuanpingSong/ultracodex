import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendControl, tailControl } from "../src/control.js";
import { CONTROL_FILE } from "../src/constants.js";
import type { ControlCommand } from "../src/types.js";

const cleanups: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-control-"));
  cleanups.push(d);
  return d;
}

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try { fs.rmSync(d, { recursive: true }); } catch {}
  }
});

function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = setInterval(() => {
      if (pred() || Date.now() > deadline) {
        clearInterval(check);
        resolve();
      }
    }, 15);
  });
}

describe("appendControl", () => {
  it("appends one JSON object per line", () => {
    const dir = tmpDir();
    appendControl(dir, { cmd: "pause" });
    appendControl(dir, { cmd: "skip", n: 4 });

    const raw = fs.readFileSync(path.join(dir, CONTROL_FILE), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ cmd: "pause" });
    expect(JSON.parse(lines[1]!)).toEqual({ cmd: "skip", n: 4 });
  });
});

describe("tailControl", () => {
  it("replays commands written BEFORE attach (from byte 0)", async () => {
    const dir = tmpDir();
    appendControl(dir, { cmd: "pause" });
    appendControl(dir, { cmd: "resume" });

    const received: ControlCommand[] = [];
    const stop = tailControl(dir, (cmd) => received.push(cmd), { pollMs: 50 });

    await waitFor(() => received.length >= 2, 500);
    stop();

    expect(received).toEqual([{ cmd: "pause" }, { cmd: "resume" }]);
  });

  it("follows commands appended after attach", async () => {
    const dir = tmpDir();
    appendControl(dir, { cmd: "pause" });

    const received: ControlCommand[] = [];
    const stop = tailControl(dir, (cmd) => received.push(cmd), { pollMs: 50 });

    await waitFor(() => received.length >= 1, 500);
    appendControl(dir, { cmd: "skip", n: 2 });
    appendControl(dir, { cmd: "stop" });

    await waitFor(() => received.length >= 3);
    stop();

    expect(received).toEqual([
      { cmd: "pause" },
      { cmd: "skip", n: 2 },
      { cmd: "stop" },
    ]);
  });

  it("handles control file not existing at attach time", async () => {
    const dir = tmpDir();

    const received: ControlCommand[] = [];
    const stop = tailControl(dir, (cmd) => received.push(cmd), { pollMs: 40 });

    await new Promise((r) => setTimeout(r, 60));
    expect(received).toHaveLength(0);

    appendControl(dir, { cmd: "stop" });

    await waitFor(() => received.length >= 1);
    stop();

    expect(received).toEqual([{ cmd: "stop" }]);
  });

  it("tolerates a trailing partial line, delivering it once completed", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, CONTROL_FILE);

    const received: ControlCommand[] = [];
    const stop = tailControl(dir, (cmd) => received.push(cmd), { pollMs: 40 });

    fs.appendFileSync(filePath, '{"cmd":"skip",');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);

    fs.appendFileSync(filePath, '"n":7}\n');
    await waitFor(() => received.length >= 1);
    stop();

    expect(received).toEqual([{ cmd: "skip", n: 7 }]);
  });

  it("stop function cancels the tail", async () => {
    const dir = tmpDir();
    const received: ControlCommand[] = [];
    const stop = tailControl(dir, (cmd) => received.push(cmd), { pollMs: 30 });

    await new Promise((r) => setTimeout(r, 50));
    stop();

    appendControl(dir, { cmd: "pause" });
    await new Promise((r) => setTimeout(r, 120));
    expect(received).toHaveLength(0);
  });

  it("AbortSignal stops the tail", async () => {
    const dir = tmpDir();
    const ac = new AbortController();
    const received: ControlCommand[] = [];
    tailControl(dir, (cmd) => received.push(cmd), {
      pollMs: 30,
      signal: ac.signal,
    });

    appendControl(dir, { cmd: "pause" });
    await waitFor(() => received.length >= 1);
    ac.abort();

    appendControl(dir, { cmd: "stop" });
    await new Promise((r) => setTimeout(r, 120));
    expect(received).toEqual([{ cmd: "pause" }]);
  });
});
