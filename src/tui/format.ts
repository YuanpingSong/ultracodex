import type { Usage } from "../types.js";
import type { AgentView, PhaseView, TuiState } from "./reducer.js";

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

/**
 * Phase-tab model for the run view strip: index 0 is the "All" tab (the
 * default), index i in [1, phaseCount] is phases[i-1]. Clamps into
 * [0, phaseCount] — no wrap, so with zero phases every index lands on "All"
 * and ←/→ are no-ops.
 */
export function clampPhaseFilter(index: number, phaseCount: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, phaseCount), Math.max(0, Math.trunc(index)));
}

/** Phase title selected by the filter, or null for the "All" tab. */
export function phaseFilterTitle(phases: PhaseView[], filterIndex: number): string | null {
  const i = clampPhaseFilter(filterIndex, phases.length);
  return i === 0 ? null : phases[i - 1]!.title;
}

/**
 * Agents visible under the phase filter. "All" (index 0, or any index that
 * clamps to it) returns the list unchanged — byte-identical to unfiltered.
 * A phase tab shows only agents tagged with that phase; agents whose phase is
 * null appear only under "All".
 */
export function filterAgentsByPhase(
  agents: AgentView[],
  phases: PhaseView[],
  filterIndex: number,
): AgentView[] {
  const title = phaseFilterTitle(phases, filterIndex);
  if (title === null) return agents;
  return agents.filter((a) => a.phase === title);
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

export interface ContentBudgetOpts {
  /** A "runner exited" banner is shown (1 row). */
  runnerDeadBanner?: boolean;
  /** Number of narrator lines that will be shown (0 hides the whole strip). */
  narratorLines?: number;
  /** The run has finished, so the result pane will render. */
  hasResultPane?: boolean;
  /** Hard cap on result-tail rows (defaults to RESULT_TAIL_MAX). */
  resultTailMax?: number;
}

export interface ContentBudget {
  /** Rows available for the agent list (windowed against this). */
  agentRows: number;
  /** Rows available for the result-pane tail (excludes its border/title). */
  resultRows: number;
}

/** The finished-run result pane never tails more than this many rows. */
export const RESULT_TAIL_MAX = 20;

/**
 * Split the terminal's total rows into fixed chrome + the rows left for the
 * scrollable content (the agent list, plus the result pane on finished runs).
 * Everything here is pure so the geometry is unit-tested rather than eyeballed
 * against a live Yoga layout.
 *
 * Chrome accounted for (matching RunView's fixed rows):
 * - header line (1),
 * - phase strip (1),
 * - the agent-list marginTop spacer (1),
 * - optional runner-dead banner (1),
 * - the narrator strip: its marginTop spacer (1) + one row per shown line,
 * - the footer line (1) + its marginTop spacer (1).
 *
 * On finished runs the result pane also costs its marginTop spacer (1) + round
 * border top/bottom (2) + title (1) = 4 rows before a single tail row. The
 * remaining content is split so the agent list keeps priority (it holds the
 * selection) while the result tail is capped at min(RESULT_TAIL_MAX, half the
 * content) so neither pane starves the other on tall terminals.
 */
export function computeContentBudget(totalRows: number, opts: ContentBudgetOpts = {}): ContentBudget {
  const rows = Number.isFinite(totalRows) ? Math.max(0, Math.trunc(totalRows)) : 0;
  const narratorLines = Math.max(0, Math.trunc(opts.narratorLines ?? 0));
  const tailMax = Math.max(0, Math.trunc(opts.resultTailMax ?? RESULT_TAIL_MAX));

  let chrome = 0;
  chrome += 1; // header
  chrome += 1; // phase strip
  chrome += 1; // agent list marginTop spacer
  if (opts.runnerDeadBanner) chrome += 1;
  if (narratorLines > 0) chrome += 1 + narratorLines; // marginTop spacer + lines
  chrome += 2; // footer line + its marginTop spacer

  const content = Math.max(0, rows - chrome);

  if (!opts.hasResultPane) {
    return { agentRows: content, resultRows: 0 };
  }

  // Result pane chrome: marginTop spacer (1) + round border (2) + title (1).
  const resultChrome = 4;
  const forResult = Math.max(0, content - resultChrome);
  // Cap the tail so the agent list keeps at least half the content; when the
  // screen is too small for the pane's chrome, the tail collapses to 0.
  const resultRows = Math.min(tailMax, Math.floor(content / 2), forResult);
  const agentRows = Math.max(0, content - resultChrome - resultRows);
  return { agentRows, resultRows };
}

export interface AgentWindow<T> {
  /** The contiguous slice to render, always including the selected item. */
  slice: T[];
  /** Count hidden above the slice (0 when nothing is clipped there). */
  above: number;
  /** Count hidden below the slice (0 when nothing is clipped there). */
  below: number;
}

/**
 * Viewport a list around `selectedIndex` so it fits in `capacity` rows without
 * ever scrolling the selection off-screen. When the whole list fits, the slice
 * is the list itself with above/below = 0.
 *
 * Overflow markers ("↑ N more" / "↓ N more") each cost one of the `capacity`
 * rows and take priority over showing an extra item, so whenever items are
 * clipped on a side its marker is shown and `above`/`below` report the true
 * hidden counts. The rendered total (markers + slice length) never exceeds
 * `capacity`.
 *
 * The selected item is mandatory — it is always inside the slice, so up/down
 * navigation can never lose the cursor. The one degenerate case is capacity 1
 * with overflow: a single row can hold only the selected item, leaving no room
 * for a marker, so the markers are dropped (`above`/`below` = 0). The rendered
 * row count is guaranteed ≤ capacity for every input.
 */
export function windowAgents<T>(
  items: T[],
  selectedIndex: number,
  capacity: number,
): AgentWindow<T> {
  const n = items.length;
  const cap = Math.max(0, Math.trunc(capacity));
  if (n === 0 || cap === 0) return { slice: [], above: 0, below: 0 };
  if (cap >= n) return { slice: items, above: 0, below: 0 };

  const sel = Math.max(0, Math.min(n - 1, Math.trunc(selectedIndex)));

  // Fixed point: how many item rows we can show depends on how many markers we
  // show, and vice-versa. Two edges → at most two markers, so iterate until the
  // marker count stabilises (bounded, ≤ 3 passes).
  let markerRows = 0;
  let start = 0;
  let end = 0;
  for (let pass = 0; pass < 3; pass++) {
    const itemSlots = Math.max(1, cap - markerRows); // selected item always fits
    // Center the window on the selection, clamped inside the list.
    start = Math.max(0, Math.min(sel - Math.floor((itemSlots - 1) / 2), n - itemSlots));
    end = Math.min(n, start + itemSlots);
    const next = (start > 0 ? 1 : 0) + (n - end > 0 ? 1 : 0);
    if (next === markerRows) break;
    markerRows = next;
  }

  let above = start;
  let below = n - end;
  // Degenerate cap 1: the lone row is the selected item; no room for a marker.
  if (end - start + (above > 0 ? 1 : 0) + (below > 0 ? 1 : 0) > cap) {
    above = 0;
    below = 0;
  }

  return { slice: items.slice(start, end), above, below };
}
