import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CONTROL_FILE } from "./constants.js";
import type { ControlCommand } from "./types.js";

export function appendControl(runDir: string, cmd: ControlCommand): void {
  const filePath = path.join(runDir, CONTROL_FILE);
  const line = JSON.stringify(cmd) + "\n";
  fs.appendFileSync(filePath, line, "utf8");
}

export function tailControl(
  runDir: string,
  onCommand: (cmd: ControlCommand) => void,
  opts?: { signal?: AbortSignal; pollMs?: number },
): () => void {
  const filePath = path.join(runDir, CONTROL_FILE);
  const pollMs = opts?.pollMs ?? 500;
  let offset = 0;
  let buffer = "";
  const decoder = new StringDecoder("utf8");
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
      buffer += decoder.write(buf.subarray(0, bytesRead));
    } finally {
      fs.closeSync(fd);
    }

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const cmd = JSON.parse(trimmed) as ControlCommand;
        onCommand(cmd);
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
      watcher.on("error", () => {});
    } catch {
      // file doesn't exist yet; rely on poll
    }
  }

  // Replay from byte 0 (runner attaches at startup and must see pre-written commands)
  processNewData();

  // Watch directory for file creation
  let dirWatcher: fs.FSWatcher | null = null;
  try {
    dirWatcher = fs.watch(runDir, (eventType, filename) => {
      if (stopped) return;
      if (filename === CONTROL_FILE) {
        processNewData();
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
