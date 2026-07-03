import fs from "node:fs";
import path from "node:path";
import { JOURNAL_FILE } from "./constants.js";
import type { JournalEvent } from "./types.js";

export class JournalWriter {
  private fd: number;

  constructor(runDir: string) {
    const filePath = path.join(runDir, JOURNAL_FILE);
    this.fd = fs.openSync(filePath, "a");
  }

  append(ev: JournalEvent): void {
    const line = JSON.stringify(ev) + "\n";
    fs.writeSync(this.fd, line);
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

export function readJournal(runDir: string): JournalEvent[] {
  const filePath = path.join(runDir, JOURNAL_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const events: JournalEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as JournalEvent);
    } catch {
      // tolerate trailing partial line
    }
  }
  return events;
}

export function tailJournal(
  runDir: string,
  onEvent: (ev: JournalEvent) => void,
  opts?: { signal?: AbortSignal; pollMs?: number },
): () => void {
  const filePath = path.join(runDir, JOURNAL_FILE);
  const pollMs = opts?.pollMs ?? 500;
  let offset = 0;
  let buffer = "";
  let stopped = false;
  let watcher: fs.FSWatcher | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function processNewData(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    if (stat.size <= offset) return;

    const fd = fs.openSync(filePath, "r");
    try {
      const toRead = stat.size - offset;
      const buf = Buffer.allocUnsafe(toRead);
      const bytesRead = fs.readSync(fd, buf, 0, toRead, offset);
      offset += bytesRead;
      buffer += buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }

    const lines = buffer.split("\n");
    // last element may be partial
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed) as JournalEvent;
        onEvent(ev);
      } catch {
        // skip malformed lines
      }
    }
  }

  function startWatching(): void {
    if (stopped) return;
    try {
      watcher = fs.watch(filePath, () => {
        if (!stopped) processNewData();
      });
      watcher.on("error", () => {
        // file may have been removed; restart polling
      });
    } catch {
      // file doesn't exist yet; will rely on poll
    }
  }

  // Replay existing content from byte 0
  processNewData();

  // Watch directory first (handles file-not-yet-existing), then file
  let dirWatcher: fs.FSWatcher | null = null;
  try {
    dirWatcher = fs.watch(runDir, (eventType, filename) => {
      if (stopped) return;
      if (filename === JOURNAL_FILE) {
        processNewData();
        // Once file exists, try to watch it directly too
        if (watcher === null) {
          startWatching();
        }
      }
    });
    dirWatcher.on("error", () => {});
  } catch {
    // directory watch failed; poll will cover it
  }

  startWatching();

  // Poll fallback
  timer = setInterval(() => {
    if (!stopped) processNewData();
  }, pollMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (watcher !== null) {
      try { watcher.close(); } catch {}
      watcher = null;
    }
    if (dirWatcher !== null) {
      try { dirWatcher.close(); } catch {}
      dirWatcher = null;
    }
  }

  if (opts?.signal) {
    opts.signal.addEventListener("abort", stop, { once: true });
  }

  return stop;
}
