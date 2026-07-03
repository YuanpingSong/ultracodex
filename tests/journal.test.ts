import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JournalWriter, readJournal, tailJournal } from "../src/journal.js";
import { JOURNAL_FILE } from "../src/constants.js";
import type { JournalEvent } from "../src/types.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-journal-"));
}

const cleanups: string[] = [];
function tmpDir(): string {
  const d = makeTmpDir();
  cleanups.push(d);
  return d;
}

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try { fs.rmSync(d, { recursive: true }); } catch {}
  }
});

const sampleEvent: JournalEvent = {
  t: "run_start",
  ts: 1234567890,
  runId: "uc_test123",
  meta: { name: "test-workflow", description: "A test workflow" },
  scriptSha: "abc123",
  argsRef: null,
  budgetTotal: null,
  concurrency: 4,
};

describe("JournalWriter + readJournal round-trip", () => {
  it("writes and reads back a single event", () => {
    const dir = tmpDir();
    const w = new JournalWriter(dir);
    w.append(sampleEvent);
    w.close();

    const events = readJournal(dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(sampleEvent);
  });

  it("handles unicode in text fields", () => {
    const dir = tmpDir();
    const ev: JournalEvent = {
      t: "log",
      ts: 111,
      text: "日本語テスト 🎉 emoji & <tags> \"quotes\"",
    };
    const w = new JournalWriter(dir);
    w.append(ev);
    w.close();

    const events = readJournal(dir);
    expect(events).toHaveLength(1);
    expect((events[0] as { text: string }).text).toBe(ev.text);
  });

  it("writes multiple events and reads them all back", () => {
    const dir = tmpDir();
    const w = new JournalWriter(dir);

    const events: JournalEvent[] = [
      sampleEvent,
      { t: "phase", ts: 2, title: "Phase One" },
      { t: "log", ts: 3, text: "hello world" },
      {
        t: "run_end",
        ts: 4,
        status: "ok",
        resultRef: "result.json",
        error: null,
        totals: {
          agents: 1,
          ok: 1,
          failed: 0,
          skipped: 0,
          usage: {},
          ms: 500,
        },
      },
    ];

    for (const ev of events) {
      w.append(ev);
    }
    w.close();

    const read = readJournal(dir);
    expect(read).toHaveLength(events.length);
    expect(read).toEqual(events);
  });

  it("tolerates trailing partial line in journal file", () => {
    const dir = tmpDir();
    const w = new JournalWriter(dir);
    w.append(sampleEvent);
    w.close();

    // Append a partial (no newline) line
    const filePath = path.join(dir, JOURNAL_FILE);
    fs.appendFileSync(filePath, '{"t":"log","ts":99,"text":"partial"');

    const events = readJournal(dir);
    // Should read only the complete event
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(sampleEvent);
  });

  it("returns empty array when journal file does not exist", () => {
    const dir = tmpDir();
    expect(readJournal(dir)).toEqual([]);
  });

  it("opens append fd so multiple JournalWriter instances don't overwrite", () => {
    const dir = tmpDir();
    const w1 = new JournalWriter(dir);
    w1.append({ t: "log", ts: 1, text: "first" });
    w1.close();

    const w2 = new JournalWriter(dir);
    w2.append({ t: "log", ts: 2, text: "second" });
    w2.close();

    const events = readJournal(dir);
    expect(events).toHaveLength(2);
    expect((events[0] as { text: string }).text).toBe("first");
    expect((events[1] as { text: string }).text).toBe("second");
  });
});

describe("tailJournal", () => {
  it("replays existing events before following", async () => {
    const dir = tmpDir();
    const w = new JournalWriter(dir);
    w.append(sampleEvent);
    w.append({ t: "phase", ts: 2, title: "Init" });
    w.close();

    const received: JournalEvent[] = [];
    const stop = tailJournal(dir, (ev) => received.push(ev), { pollMs: 50 });

    // Wait a tick for replay to happen
    await new Promise((r) => setTimeout(r, 100));
    stop();

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(sampleEvent);
    expect(received[1]).toEqual({ t: "phase", ts: 2, title: "Init" });
  });

  it("sees events appended after attach", async () => {
    const dir = tmpDir();

    const received: JournalEvent[] = [];
    const stop = tailJournal(dir, (ev) => received.push(ev), { pollMs: 50 });

    // Give tail time to set up
    await new Promise((r) => setTimeout(r, 60));

    // Append events asynchronously
    const w = new JournalWriter(dir);
    w.append({ t: "log", ts: 10, text: "appended-1" });
    w.append({ t: "log", ts: 11, text: "appended-2" });
    w.close();

    // Wait for tail to pick them up (poll at 50ms, allow up to 600ms)
    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 600;
      const check = setInterval(() => {
        if (received.length >= 2 || Date.now() > deadline) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    stop();

    expect(received.length).toBeGreaterThanOrEqual(2);
    const texts = received.map((e) => (e as { text?: string }).text);
    expect(texts).toContain("appended-1");
    expect(texts).toContain("appended-2");
  });

  it("sees events appended by a separate spawned process", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, JOURNAL_FILE);

    const received: JournalEvent[] = [];
    const stop = tailJournal(dir, (ev) => received.push(ev), { pollMs: 50 });

    const script = `
      const fs = require("node:fs");
      setTimeout(() => {
        fs.appendFileSync(${JSON.stringify(filePath)},
          JSON.stringify({ t: "log", ts: 5, text: "from-child" }) + "\\n");
      }, 100);
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    const exited = new Promise<void>((r) => child.on("exit", () => r()));

    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 1500;
      const check = setInterval(() => {
        if (received.length >= 1 || Date.now() > deadline) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    stop();
    await exited;

    expect(received).toHaveLength(1);
    expect((received[0] as { text: string }).text).toBe("from-child");
  });

  it("AbortSignal stops the tail", async () => {
    const dir = tmpDir();
    const ac = new AbortController();

    let callCount = 0;
    tailJournal(dir, () => { callCount++; }, {
      pollMs: 30,
      signal: ac.signal,
    });

    await new Promise((r) => setTimeout(r, 80));
    ac.abort();

    const countAfterAbort = callCount;
    // Append something after abort
    const w = new JournalWriter(dir);
    w.append({ t: "log", ts: 1, text: "after-abort" });
    w.close();

    await new Promise((r) => setTimeout(r, 100));
    // Should not have received the new event
    expect(callCount).toBe(countAfterAbort);
  });

  it("stop function cancels watcher and timer", async () => {
    const dir = tmpDir();
    const received: JournalEvent[] = [];
    const stop = tailJournal(dir, (ev) => received.push(ev), { pollMs: 30 });

    await new Promise((r) => setTimeout(r, 50));
    stop();

    const w = new JournalWriter(dir);
    w.append({ t: "log", ts: 99, text: "after-stop" });
    w.close();

    await new Promise((r) => setTimeout(r, 100));
    // No new events should arrive
    const count = received.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(count);
  });

  it("does not corrupt a multi-byte UTF-8 character split across read boundaries", async () => {
    const dir = tmpDir();
    const filePath = path.join(dir, JOURNAL_FILE);
    const text = "日本語テスト 🎉";
    const line = Buffer.from(JSON.stringify({ t: "log", ts: 1, text }) + "\n", "utf8");
    // Split INSIDE the first multi-byte character (日 is 3 bytes in UTF-8).
    const splitAt = line.indexOf(Buffer.from("日", "utf8")) + 1;

    const received: JournalEvent[] = [];
    const stop = tailJournal(dir, (ev) => received.push(ev), { pollMs: 30 });

    fs.appendFileSync(filePath, line.subarray(0, splitAt));
    // Let the tail consume the first (partial) chunk before completing the line.
    await new Promise((r) => setTimeout(r, 150));
    fs.appendFileSync(filePath, line.subarray(splitAt));

    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 800;
      const check = setInterval(() => {
        if (received.length >= 1 || Date.now() > deadline) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    stop();

    expect(received).toHaveLength(1);
    const got = (received[0] as { text: string }).text;
    expect(got).toBe(text); // exact — no U+FFFD replacement chars
    expect(got).not.toContain("�");
  });

  it("handles file appearing after tail starts", async () => {
    const dir = tmpDir();

    const received: JournalEvent[] = [];
    const stop = tailJournal(dir, (ev) => received.push(ev), { pollMs: 40 });

    // File doesn't exist yet; wait a bit
    await new Promise((r) => setTimeout(r, 60));

    // Now create the file
    const w = new JournalWriter(dir);
    w.append({ t: "log", ts: 1, text: "created-late" });
    w.close();

    await new Promise<void>((resolve) => {
      const deadline = Date.now() + 600;
      const check = setInterval(() => {
        if (received.length >= 1 || Date.now() > deadline) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    stop();
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect((received[0] as { text: string }).text).toBe("created-late");
  });
});
