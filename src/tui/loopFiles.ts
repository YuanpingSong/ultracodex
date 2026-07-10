import fs from "node:fs";
import path from "node:path";
import { MAX_VERDICT_JSON_BYTES } from "./loops.js";

export function readAgentOutputCapped(runDir: string, resultRef: string): string | null {
  const root = path.resolve(runDir);
  const abs = path.resolve(runDir, resultRef);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > MAX_VERDICT_JSON_BYTES) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export function makeAgentOutputReader(runDir: string): (resultRef: string) => string | null {
  return (resultRef) => readAgentOutputCapped(runDir, resultRef);
}

export function readJsonOutputCapped(runDir: string, resultRef: string | null): unknown {
  if (resultRef === null || !resultRef.endsWith(".json")) return undefined;
  const raw = readAgentOutputCapped(runDir, resultRef);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
