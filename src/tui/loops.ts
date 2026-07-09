import { fmtDuration, fmtTokens, truncate } from "./format.js";
import type { AgentView, TuiState } from "./reducer.js";

export type LoopStatus = "running" | "converged" | "ended";
export type VerdictKind = "approved" | "rejected" | "unknown";

export interface RoundVerdict {
  kind: VerdictKind;
  text: string | null;
}

export interface Round {
  n: number;
  agents: AgentView[];
  outputTokens: number;
  durationMs: number;
  verdict: RoundVerdict;
}

export interface LoopInstance {
  id: string;
  rounds: Round[];
  status: LoopStatus;
  convergedAt: number | null;
  totalTokens: number;
  totalDurationMs: number;
}

const LABEL_ROUND_RE = /^(.*?)(?:-r|:round-)(\d+)$/;
const PHASE_ROUND_RE = /^(?:(.+?)\s*[·:–—-]?\s*)?[Rr]ound[\s-]?(\d+)$/;
export const MAX_VERDICT_JSON_BYTES = 256 * 1024;

const APPROVED_STRINGS = new Set(["approved", "pass", "passed", "ok", "yes", "done", "converged"]);
const REJECTED_STRINGS = new Set(["rejected", "fail", "failed", "no"]);
const BOOLEAN_VERDICT_FIELDS = ["approved", "pass", "passed", "ok", "real", "isReal", "converged", "done"] as const;
const TEXT_FIELDS = ["note", "reason", "summary"] as const;
const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

interface RoundMarker {
  form: "label" | "phase";
  stem: string | null;
  round: number;
  loopId: string;
}

function implicitLoopId(state: TuiState): string {
  return state.meta?.name ?? "loop";
}

function loopIdForMarker(form: RoundMarker["form"], stem: string | null, state: TuiState): string {
  if (stem !== null && stem.includes(":")) {
    return stem.slice(0, stem.lastIndexOf(":"));
  }
  if (form === "phase" && stem !== null && stem !== "") return stem;
  return implicitLoopId(state);
}

function markerFromAgent(agent: AgentView, state: TuiState): RoundMarker | null {
  const labelMatch = LABEL_ROUND_RE.exec(agent.label);
  if (labelMatch !== null) {
    const stem = labelMatch[1] ?? "";
    const round = Number.parseInt(labelMatch[2] ?? "", 10);
    if (Number.isFinite(round)) {
      return {
        form: "label",
        stem,
        round,
        loopId: loopIdForMarker("label", stem, state),
      };
    }
  }

  if (agent.phase === null) return null;
  const phaseMatch = PHASE_ROUND_RE.exec(agent.phase);
  if (phaseMatch === null) return null;
  const rawStem = phaseMatch[1]?.trim();
  const stem = rawStem === undefined || rawStem === "" ? null : rawStem;
  const round = Number.parseInt(phaseMatch[2] ?? "", 10);
  if (!Number.isFinite(round)) return null;
  return {
    form: "phase",
    stem,
    round,
    loopId: loopIdForMarker("phase", stem, state),
  };
}

function inferredNowMs(state: TuiState): number {
  let now = state.endTs ?? state.startTs ?? 0;
  for (const agent of state.agents.values()) {
    now = Math.max(now, agent.endTs ?? agent.startTs);
  }
  return now;
}

function roundOutputTokens(agents: readonly AgentView[]): number {
  let total = 0;
  for (const agent of agents) total += agent.usage.outputTokens;
  return total;
}

function roundDurationMs(agents: readonly AgentView[], nowMs: number): number {
  if (agents.length === 0) return 0;
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const agent of agents) {
    minStart = Math.min(minStart, agent.startTs);
    maxEnd = Math.max(maxEnd, agent.endTs ?? nowMs);
  }
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return 0;
  return Math.max(0, maxEnd - minStart);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function verdictTextFromRecord(value: Record<string, unknown>): string | null {
  const issues = value["issues"];
  if (Array.isArray(issues)) {
    const joined = issues.map((item) => String(item)).join("; ");
    if (joined.trim() !== "") return truncate(joined, 120);
  } else if (typeof issues === "string" && issues.trim() !== "") {
    return truncate(issues, 120);
  }

  for (const field of TEXT_FIELDS) {
    const text = value[field];
    if (typeof text === "string" && text.trim() !== "") return truncate(text, 120);
  }
  return null;
}

function verdictFromJson(value: unknown): RoundVerdict {
  if (!isRecord(value)) return { kind: "unknown", text: null };

  const verdict = value["verdict"];
  if (typeof verdict === "string") {
    const raw = verdict.trim();
    const normalized = raw.toLowerCase();
    if (APPROVED_STRINGS.has(normalized)) {
      return { kind: "approved", text: verdictTextFromRecord(value) };
    }
    if (REJECTED_STRINGS.has(normalized)) {
      return { kind: "rejected", text: verdictTextFromRecord(value) };
    }
    return { kind: "unknown", text: raw === "" ? null : truncate(raw, 120) };
  }

  const text = verdictTextFromRecord(value);
  for (const field of BOOLEAN_VERDICT_FIELDS) {
    const bool = value[field];
    if (typeof bool === "boolean") {
      return { kind: bool ? "approved" : "rejected", text };
    }
  }
  return { kind: "unknown", text };
}

export function extractRoundVerdict(
  agents: readonly AgentView[],
  readAgentOutput: (resultRef: string) => string | null,
): RoundVerdict {
  const ordered = [...agents].sort((a, b) => b.n - a.n);
  for (const agent of ordered) {
    const ref = agent.resultRef;
    if (ref === null || !ref.endsWith(".json")) continue;

    let raw: string | null;
    try {
      raw = readAgentOutput(ref);
    } catch {
      continue;
    }
    if (typeof raw !== "string") continue;
    if (Buffer.byteLength(raw, "utf8") > MAX_VERDICT_JSON_BYTES) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    return verdictFromJson(parsed);
  }
  return { kind: "unknown", text: null };
}

export function detectLoops(
  state: TuiState,
  readAgentOutput: (resultRef: string) => string | null,
  nowMs = inferredNowMs(state),
): LoopInstance[] {
  const groups = new Map<string, Map<number, AgentView[]>>();
  const agents = [...state.agents.values()].sort((a, b) => a.n - b.n);

  for (const agent of agents) {
    const marker = markerFromAgent(agent, state);
    if (marker === null) continue;
    let rounds = groups.get(marker.loopId);
    if (rounds === undefined) {
      rounds = new Map<number, AgentView[]>();
      groups.set(marker.loopId, rounds);
    }
    const bucket = rounds.get(marker.round);
    if (bucket === undefined) rounds.set(marker.round, [agent]);
    else bucket.push(agent);
  }

  const loops: LoopInstance[] = [];
  const entries = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [id, roundsByN] of entries) {
    const qualifies = roundsByN.size >= 2 || (roundsByN.size >= 1 && state.status === "running");
    if (!qualifies) continue;

    const rounds: Round[] = [...roundsByN.entries()]
      .sort(([a], [b]) => a - b)
      .map(([n, roundAgents]) => {
        const sortedAgents = [...roundAgents].sort((a, b) => a.n - b.n);
        return {
          n,
          agents: sortedAgents,
          outputTokens: roundOutputTokens(sortedAgents),
          durationMs: roundDurationMs(sortedAgents, nowMs),
          verdict: extractRoundVerdict(sortedAgents, readAgentOutput),
        };
      });

    const last = rounds[rounds.length - 1];
    if (last === undefined) continue;
    const totalTokens = rounds.reduce((sum, round) => sum + round.outputTokens, 0);
    const totalDurationMs = rounds.reduce((sum, round) => sum + round.durationMs, 0);
    const status: LoopStatus =
      state.status === "running" ? "running" : last.verdict.kind === "approved" ? "converged" : "ended";

    loops.push({
      id,
      rounds,
      status,
      convergedAt: status === "converged" ? last.n : null,
      totalTokens,
      totalDurationMs,
    });
  }

  return loops;
}

export function verdictGlyph(verdict: RoundVerdict, running = false, spinner = "●"): string {
  if (running) return spinner;
  switch (verdict.kind) {
    case "approved":
      return "✔";
    case "rejected":
      return "✖";
    case "unknown":
      return "·";
  }
}

export function loopStatusGlyph(status: LoopStatus, spinner = "●"): string {
  switch (status) {
    case "running":
      return spinner;
    case "converged":
      return "✔";
    case "ended":
      return "✖";
  }
}

export function roundIsRunning(round: Round): boolean {
  return round.agents.some((agent) => agent.status === "running");
}

export function trajectoryStrip(rounds: readonly Round[], spinner = "●", maxRounds?: number): string {
  const cap = maxRounds === undefined ? rounds.length : Math.max(0, Math.trunc(maxRounds));
  const visible = cap > 0 && rounds.length > cap ? rounds.slice(-cap) : [...rounds];
  const prefix = cap > 0 && rounds.length > cap ? "… " : "";
  return prefix + visible.map((round) => verdictGlyph(round.verdict, roundIsRunning(round), spinner)).join(" ");
}

export function valueSparkline(
  values: readonly number[],
  options: { zeroBase?: boolean; flatGlyph?: string } = {},
): string {
  const finite = values.filter((value) => Number.isFinite(value)).map((value) => Math.max(0, value));
  if (finite.length === 0) return "";
  const min = options.zeroBase === true ? 0 : Math.min(...finite);
  const max = Math.max(...finite);
  if (max <= min) return finite.map(() => options.flatGlyph ?? SPARK_BLOCKS[SPARK_BLOCKS.length - 1]).join("");
  return finite
    .map((value) => {
      const index = Math.round(((value - min) / (max - min)) * (SPARK_BLOCKS.length - 1));
      return SPARK_BLOCKS[index]!;
    })
    .join("");
}

export function costSparkline(rounds: readonly Round[]): string {
  return valueSparkline(
    rounds.map((round) => round.outputTokens),
    { zeroBase: true, flatGlyph: SPARK_BLOCKS[0] },
  );
}

function pctChange(first: number, last: number): number | null {
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  return Math.round(((last - first) / first) * 100);
}

export function deltaPct(first: number, last: number): string {
  const pct = pctChange(first, last);
  if (pct === null) return "—";
  if (pct > 0) return `↑${pct}%`;
  if (pct < 0) return `↓${Math.abs(pct)}%`;
  return "0%";
}

export function tokenDeltaPct(previous: number | null | undefined, current: number): string {
  if (previous === null || previous === undefined) return "—";
  const pct = pctChange(previous, current);
  if (pct === null) return "—";
  if (pct > 0) return `+${pct}%`;
  if (pct < 0) return `−${Math.abs(pct)}%`;
  return "0%";
}

export function formatLoopStatus(loop: LoopInstance, spinner = "●"): string {
  const rounds = loop.rounds.length;
  const lastRound = loop.rounds[rounds - 1]?.n ?? 0;
  if (loop.status === "running") return `${loopStatusGlyph("running", spinner)} running (round ${lastRound})`;
  if (loop.status === "converged") return `${loopStatusGlyph("converged")} converged after ${rounds} rounds`;
  return `${loopStatusGlyph("ended")} ended after ${rounds} rounds (not converged)`;
}

function normalizeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatLoopHeaderTokens(tokens: number): string {
  const n = normalizeNonNegative(tokens);
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

function formatLoopHeaderDuration(ms: number): string {
  const s = normalizeNonNegative(ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function formatLoopListTokens(tokens: number): string {
  return fmtTokens(normalizeNonNegative(tokens));
}

function formatLoopListDuration(ms: number): string {
  const s = Math.floor(normalizeNonNegative(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

export function formatLoopTotals(loop: LoopInstance): string {
  return `${formatLoopHeaderTokens(loop.totalTokens)} tok · ${formatLoopHeaderDuration(loop.totalDurationMs)}`;
}

export function formatLoopHeaderLine(loop: LoopInstance, runId: string | null, spinner = "●"): string {
  return `${loop.id} · ${runId ?? "?"} · ${formatLoopStatus(loop, spinner)} · ${formatLoopTotals(loop)}`;
}

export function roundVerdictLabel(round: Round, spinner = "●"): string {
  if (roundIsRunning(round)) return `${spinner} running`;
  return `${verdictGlyph(round.verdict)} ${round.verdict.kind}`;
}

export function formatRoundLedgerRow(loop: LoopInstance, roundIndex: number, selected = false, spinner = "●"): string {
  const round = loop.rounds[roundIndex];
  if (round === undefined) return "";
  const previous = roundIndex > 0 ? loop.rounds[roundIndex - 1]?.outputTokens : undefined;
  const pointer = selected ? "❯ " : "  ";
  const rnd = `r${round.n}`.padEnd(4);
  const verdict = roundVerdictLabel(round, spinner).padEnd(10);
  const agents = String(round.agents.length).padEnd(6);
  const tok = fmtTokens(round.outputTokens).padEnd(7);
  const delta = tokenDeltaPct(previous, round.outputTokens).padEnd(6);
  return `${pointer}${rnd} ${verdict} ${agents} ${tok} ${delta} ${fmtDuration(round.durationMs)}`;
}

export function formatLoopListRow(opts: {
  runId: string;
  loop: LoopInstance;
  selected?: boolean;
  spinner?: string;
  maxTrajectory?: number;
}): string {
  const spinner = opts.spinner ?? "●";
  const lastRound = opts.loop.rounds[opts.loop.rounds.length - 1]?.n ?? 0;
  const status =
    opts.loop.status === "running"
      ? `running r${lastRound}`
      : opts.loop.status === "converged"
        ? `converged r${opts.loop.convergedAt ?? lastRound}`
        : `ended r${lastRound}`;
  return `${opts.selected ? "❯ " : "  "}${loopStatusGlyph(opts.loop.status, spinner)} ${opts.runId} ${
    opts.loop.id
  } · ${trajectoryStrip(opts.loop.rounds, spinner, opts.maxTrajectory ?? 10)} · ${status} · ${formatLoopListTokens(
    opts.loop.totalTokens,
  )} · ${formatLoopListDuration(opts.loop.totalDurationMs)}`;
}
