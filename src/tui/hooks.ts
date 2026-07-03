import fs from "node:fs";
import { useCallback, useEffect, useRef, useState } from "react";
import { tailJournal } from "../journal.js";
import { initialState, reduce, type TuiState } from "./reducer.js";

const FLUSH_MS = 100; // 10fps re-render cap

/** Tail journal.jsonl → reducer fold; replay-on-attach, batched flushes. */
export function useJournalState(runDir: string): TuiState {
  const [state, setState] = useState<TuiState>(initialState);
  useEffect(() => {
    let acc = initialState();
    let dirty = false;
    const stop = tailJournal(runDir, (ev) => {
      acc = reduce(acc, ev);
      dirty = true;
    });
    // tailJournal replays existing events synchronously — flush the replay now
    dirty = false;
    setState(acc);
    const timer = setInterval(() => {
      if (dirty) {
        dirty = false;
        setState(acc);
      }
    }, FLUSH_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [runDir]);
  return state;
}

/** Live terminal dimensions; re-renders on resize (full-screen layouts). */
export function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState({
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  useEffect(() => {
    const onResize = () =>
      setSize({ columns: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);
  return size;
}

/** Monotonic counter for spinners / elapsed tickers. */
export function useTick(ms: number, active: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms, active]);
  return n;
}

/** Transient footer message ("copied", "pause sent", …). */
export function useFlash(ttlMs = 2000): [string | null, (msg: string) => void] {
  const [flash, setFlash] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback(
    (msg: string) => {
      setFlash(msg);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setFlash(null), ttlMs);
    },
    [ttlMs],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return [flash, show];
}

/** Poll the tail (last `maxLines` non-empty lines, last 64KB) of a file. */
export function useFileTail(filePath: string | null, maxLines: number, pollMs = 500): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (!filePath) {
      setLines([]);
      return;
    }
    let stopped = false;
    const read = (): void => {
      let next: string[] = [];
      try {
        const stat = fs.statSync(filePath);
        const start = Math.max(0, stat.size - 64 * 1024);
        const fd = fs.openSync(filePath, "r");
        try {
          const buf = Buffer.allocUnsafe(stat.size - start);
          const n = fs.readSync(fd, buf, 0, buf.length, start);
          next = buf
            .subarray(0, n)
            .toString("utf8")
            .split("\n")
            .filter((l) => l.trim() !== "")
            .slice(-maxLines);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        next = [];
      }
      if (stopped) return;
      const joined = next.join("\n");
      setLines((prev) => (prev.join("\n") === joined ? prev : next));
    };
    read();
    const t = setInterval(read, pollMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [filePath, maxLines, pollMs]);
  return lines;
}
