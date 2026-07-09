import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fromPosix, normalizeAgentPath } from "./common.js";

export const STATE_RELATIVE_PATH = ".ultracodex/org/state/last-wake.json";

export interface WakeRecord {
  lastWake?: string;
  cycle?: number;
  lastSeverity?: string;
}

export type WakeState = Record<string, WakeRecord>;

export async function readLastWakeState(rootDir = process.cwd()): Promise<WakeState> {
  const file = statePath(rootDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return {};
    throw err;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${STATE_RELATIVE_PATH} must contain a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const raw = obj.agents && typeof obj.agents === "object" && !Array.isArray(obj.agents) ? obj.agents : obj;
  return normalizeWakeState(raw as Record<string, unknown>);
}

export async function writeLastWakeState(rootDir = process.cwd(), state: WakeState = {}): Promise<void> {
  const file = statePath(rootDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(normalizeWakeState(state), null, 2)}\n`, "utf8");
}

export async function updateAgentWakeState(
  rootDir = process.cwd(),
  agentPath: string,
  patch: WakeRecord = {},
): Promise<WakeRecord> {
  const state = await readLastWakeState(rootDir);
  const key = normalizeAgentPath(agentPath);
  state[key] = normalizeWakeRecord({ ...(state[key] ?? {}), ...patch });
  await writeLastWakeState(rootDir, state);
  return state[key]!;
}

export function normalizeWakeState(state: Record<string, unknown> = {}): WakeState {
  const out: WakeState = {};
  for (const [rawKey, rawRecord] of Object.entries(state ?? {})) {
    out[normalizeAgentPath(rawKey)] = normalizeWakeRecord(rawRecord);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function normalizeWakeRecord(record: unknown = {}): WakeRecord {
  const out: WakeRecord = {};
  if (record && typeof record === "object" && !Array.isArray(record)) {
    const row = record as Record<string, unknown>;
    if (row.lastWake !== undefined && row.lastWake !== null) out.lastWake = String(row.lastWake);
    if (row.cycle !== undefined && row.cycle !== null) out.cycle = Number(row.cycle);
    if (row.lastSeverity !== undefined && row.lastSeverity !== null) out.lastSeverity = String(row.lastSeverity);
  }
  return out;
}

function statePath(rootDir: string): string {
  return path.join(path.resolve(rootDir), fromPosix(STATE_RELATIVE_PATH));
}
