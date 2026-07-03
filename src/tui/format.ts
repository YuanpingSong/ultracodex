import type { Usage } from "../types.js";
import type { TuiState } from "./reducer.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
}

export function statusGlyph(status: "running" | "ok" | "failed" | "skipped"): string {
  switch (status) {
    case "ok":
      return "✔";
    case "failed":
      return "✖";
    case "skipped":
      return "⊘";
    case "running":
      return "●";
  }
}

export function statusColor(status: "running" | "ok" | "failed" | "skipped"): string {
  switch (status) {
    case "ok":
      return "green";
    case "failed":
      return "red";
    case "skipped":
      return "gray";
    case "running":
      return "cyan";
  }
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  if (m < 60) return `${m}m${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) {
    const v = n / 1e3;
    return `${v >= 100 ? String(Math.round(v)) : v.toFixed(1)}k`;
  }
  const v = n / 1e6;
  return `${v >= 100 ? String(Math.round(v)) : v.toFixed(1)}M`;
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)) + "…";
}

export function sumOutputTokens(byBackend: Record<string, Usage>): number {
  let total = 0;
  for (const u of Object.values(byBackend)) total += u.outputTokens;
  return total;
}

/** Finished-agent totals plus live ticks from still-running agents. */
export function liveOutputTokens(state: TuiState): number {
  let total = state.outputTokens;
  for (const a of state.agents.values()) {
    if (a.status === "running") total += a.usage.outputTokens;
  }
  return total;
}

export function budgetBar(spent: number, total: number, width = 10): string {
  const ratio = total > 0 ? Math.max(0, Math.min(1, spent / total)) : 0;
  const filled = Math.round(ratio * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}

/** Gantt lane geometry: character offset + length within `width` columns. */
export function ganttBar(
  startTs: number,
  endTs: number,
  runStart: number,
  runEnd: number,
  width: number,
): { offset: number; length: number } {
  const span = Math.max(1, runEnd - runStart);
  const from = Math.max(0, Math.min(1, (startTs - runStart) / span));
  const to = Math.max(from, Math.min(1, (endTs - runStart) / span));
  const offset = Math.min(Math.max(0, width - 1), Math.floor(from * width));
  const length = Math.max(1, Math.round((to - from) * width));
  return { offset, length: Math.min(length, width - offset) };
}

/** "500k" → 500000, "1.5m" → 1500000, "" → null, garbage → null. */
export function parseBudget(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(t);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const mult = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1;
  return Math.round(n * mult);
}
