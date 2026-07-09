import type { ScheduleExecOutcome } from "../schedule/log.js";
import { nextFireMs } from "../schedule/time.js";
import type { ScheduleSpec, ScheduleStatus } from "../schedule/spec.js";
import { parseBudget } from "../budget.js";

export type ScheduleGlyphColor = "cyan" | "yellow" | "green" | "red" | "dim";

export interface ScheduleGlyph {
  glyph: string;
  color: ScheduleGlyphColor;
  dim: boolean;
}

export interface ScheduleFormDraft {
  name: string;
  cadence: "every" | "daily";
  value: string;
  untilDone: boolean;
  maxRuns: string;
  budget: string;
  argsJson: string;
}

export type ScheduleFormValidation =
  | {
      ok: true;
      name: string;
      every?: string;
      daily?: string;
      untilDone: boolean;
      maxRuns?: string;
      budget?: string;
      argsJson?: string;
    }
  | { ok: false; error: string; field: keyof ScheduleFormDraft };

export function scheduleStatusGlyph(status: ScheduleStatus): ScheduleGlyph {
  switch (status) {
    case "active":
      return { glyph: "●", color: "cyan", dim: false };
    case "paused":
      return { glyph: "⊘", color: "yellow", dim: false };
    case "retired":
      return { glyph: "○", color: "dim", dim: true };
  }
}

export function execOutcomeGlyph(ok: boolean): ScheduleGlyph {
  return ok
    ? { glyph: "✔", color: "green", dim: false }
    : { glyph: "✖", color: "red", dim: false };
}

export function buildScheduleHistoryStrip(
  outcomes: readonly ScheduleExecOutcome[],
  running = false,
  spinner = "●",
  maxOutcomes = 4,
): string {
  const cap = Math.max(0, Math.trunc(maxOutcomes));
  const visible = cap === 0 ? [] : outcomes.slice(-cap);
  const glyphs = visible.map((outcome) => execOutcomeGlyph(outcome.ok).glyph);
  if (running) glyphs.push(spinner);
  return glyphs.length === 0 ? "—" : glyphs.join(" ");
}

function formatRemainingMs(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}

export function formatScheduleCountdown(opts: {
  spec: Pick<ScheduleSpec, "schedule">;
  nowMs: number;
  overdue?: boolean;
  nextMs?: number | null;
}): string {
  if (opts.overdue) return "OVERDUE";
  const nextMsValue = opts.nextMs === undefined ? nextFireMs(opts.spec, opts.nowMs) : opts.nextMs;
  if (nextMsValue === null) return "—";
  if (nextMsValue < opts.nowMs) return "OVERDUE";
  return `in ${formatRemainingMs(nextMsValue - opts.nowMs)}`;
}

export function humanScheduleLabel(spec: Pick<ScheduleSpec, "schedule" | "cronExpr">): string {
  switch (spec.schedule.kind) {
    case "every":
      return `every ${spec.schedule.value}`;
    case "daily":
      return `daily ${spec.schedule.value}`;
    case "cron":
      return spec.cronExpr;
  }
}

export function scheduleStatusWord(status: ScheduleStatus): string {
  return status;
}

function scheduleStatusRank(status: ScheduleStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "paused":
      return 1;
    case "retired":
      return 2;
  }
}

export function compareScheduleSpecsForDisplay(a: ScheduleSpec, b: ScheduleSpec, nowMs: number): number {
  const ar = scheduleStatusRank(a.status);
  const br = scheduleStatusRank(b.status);
  if (ar !== br) return ar - br;

  if (a.status === "active" && b.status === "active") {
    const an = nextFireMs(a, nowMs);
    const bn = nextFireMs(b, nowMs);
    const av = an ?? Number.POSITIVE_INFINITY;
    const bv = bn ?? Number.POSITIVE_INFINITY;
    if (av !== bv) return av - bv;
  }

  return a.name.localeCompare(b.name);
}

export function sortScheduleSpecsForDisplay<T extends ScheduleSpec>(specs: readonly T[], nowMs: number): T[] {
  return [...specs].sort((a, b) => compareScheduleSpecsForDisplay(a, b, nowMs));
}

export function formatScheduleStateCell(
  spec: Pick<ScheduleSpec, "schedule" | "status" | "retiredReason">,
  nowMs: number,
  overdue = false,
): string {
  if (spec.status === "paused") return "paused";
  if (spec.status === "retired") {
    return spec.retiredReason ? `retired (${spec.retiredReason})` : "retired";
  }
  return formatScheduleCountdown({ spec, nowMs, overdue });
}

export function formatScheduleRow(opts: {
  spec: ScheduleSpec;
  history?: readonly ScheduleExecOutcome[];
  running?: boolean;
  selected?: boolean;
  overdue?: boolean;
  nowMs?: number;
  spinner?: string;
  maxHistory?: number;
}): string {
  const nowMs = opts.nowMs ?? Date.now();
  const pointer = opts.selected ? "❯ " : "  ";
  const status = scheduleStatusGlyph(opts.spec.status).glyph;
  const history = buildScheduleHistoryStrip(
    opts.history ?? [],
    !!opts.running,
    opts.spinner ?? "●",
    opts.maxHistory,
  );
  const countdown = formatScheduleStateCell(opts.spec, nowMs, !!opts.overdue);
  const runs = `${opts.spec.runs} run${opts.spec.runs === 1 ? "" : "s"}`;
  return `${pointer}${status} ${opts.spec.name}   ${humanScheduleLabel(opts.spec)}   ${history}   ${countdown}   ${runs}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatScheduleTimestampShort(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatScheduleLastRunCell(lastRun: ScheduleSpec["lastRun"]): string {
  if (lastRun === null) return "last run —";
  const glyph = execOutcomeGlyph(lastRun.ok).glyph;
  const runId = lastRun.runId ? ` · ${lastRun.runId}` : "";
  return `last run ${glyph} ${formatScheduleTimestampShort(lastRun.ts)} · exit ${lastRun.exitCode}${runId}`;
}

export function formatScheduleBudgetSuffix(spec: Pick<ScheduleSpec, "budget">): string {
  return spec.budget === null ? "" : ` · budget: ${spec.budget}`;
}

export function validateScheduleFormDraft(draft: ScheduleFormDraft): ScheduleFormValidation {
  const name = draft.name.trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return {
      ok: false,
      field: "name",
      error: `invalid schedule name "${name}" (use lowercase letters, digits, and hyphens)`,
    };
  }

  const value = draft.value.trim();
  if (draft.cadence === "every") {
    const m = /^([1-9]\d*)([mh])$/.exec(value);
    if (m === null) return { ok: false, field: "value", error: `invalid --every "${value}" (use 1-59m or 1-23h)` };
    const n = Number(m[1]);
    if (m[2] === "m" && (n < 1 || n > 59)) {
      return { ok: false, field: "value", error: `invalid --every "${value}" (minutes must be 1-59)` };
    }
    if (m[2] === "h" && (n < 1 || n > 23)) {
      return { ok: false, field: "value", error: `invalid --every "${value}" (hours must be 1-23)` };
    }
  } else {
    const m = /^(\d{2}):(\d{2})$/.exec(value);
    if (m === null) return { ok: false, field: "value", error: `invalid --daily "${value}" (use HH:MM)` };
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      return { ok: false, field: "value", error: `invalid --daily "${value}" (use HH:MM in 00:00-23:59)` };
    }
  }

  const maxRuns = draft.maxRuns.trim();
  if (maxRuns !== "") {
    const n = Number(maxRuns);
    if (!Number.isInteger(n) || n < 1) {
      return {
        ok: false,
        field: "maxRuns",
        error: `--max-runs must be a positive integer (got "${maxRuns}")`,
      };
    }
  }

  const budget = draft.budget.trim();
  if (budget !== "") {
    try {
      parseBudget(budget);
    } catch (err) {
      return {
        ok: false,
        field: "budget",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const argsJson = draft.argsJson.trim();
  if (argsJson !== "") {
    try {
      JSON.parse(argsJson);
    } catch {
      return { ok: false, field: "argsJson", error: "args must be valid JSON (or empty)" };
    }
  }

  return {
    ok: true,
    name,
    ...(draft.cadence === "every" ? { every: value } : { daily: value }),
    untilDone: draft.untilDone,
    ...(maxRuns === "" ? {} : { maxRuns }),
    ...(budget === "" ? {} : { budget }),
    ...(argsJson === "" ? {} : { argsJson }),
  };
}
