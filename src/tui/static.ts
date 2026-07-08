import pc from "picocolors";
import type { TuiState } from "./reducer.js";
import {
  fmtClock,
  fmtDuration,
  fmtTokens,
  liveOutputTokens,
  statusGlyph,
  truncate,
} from "./format.js";
import {
  detectLoops,
  formatLoopStatus,
  formatLoopTotals,
  roundVerdictLabel,
  trajectoryStrip,
} from "./loops.js";

const NARRATOR_TAIL = 6;

export function renderRunStatic(
  state: TuiState,
  opts?: { color?: boolean; readAgentOutput?: (resultRef: string) => string | null },
): string {
  const enabled = (opts?.color ?? true) && !process.env.NO_COLOR;
  const c = pc.createColors(enabled);

  const lines: string[] = [];
  const now = Date.now();
  const endTs = state.endTs ?? now;
  const elapsed = state.startTs !== null ? endTs - state.startTs : 0;
  const agents = [...state.agents.values()].sort((a, b) => a.n - b.n);
  const done = agents.filter((a) => a.status !== "running").length;
  const tokens = liveOutputTokens(state);

  const statusText =
    state.status === "ok"
      ? c.green("ok")
      : state.status === "failed"
        ? c.red("failed")
        : state.status === "stopped"
          ? c.yellow("stopped")
          : c.cyan("running");

  const header = [
    c.bold(state.meta?.name ?? "(unknown workflow)"),
    state.runId ?? "?",
    statusText,
    fmtDuration(elapsed),
    `${done}/${agents.length} agents`,
    `${fmtTokens(tokens)} out tok`,
  ];
  if (state.budgetTotal !== null) {
    header.push(`budget ${fmtTokens(tokens)}/${fmtTokens(state.budgetTotal)}`);
  }
  if (state.paused) header.push(c.yellow("PAUSED"));
  lines.push(header.join(" · "));

  if (state.phases.length > 0) {
    const segs = state.phases.map((p) => {
      const finished =
        p.total > 0 && p.running === 0 && p.done + p.failed === p.total && p.title !== state.currentPhase;
      const glyph =
        p.running > 0
          ? c.cyan("●")
          : finished
            ? c.green("✔")
            : p.title === state.currentPhase
              ? c.cyan("●")
              : c.dim("○");
      return `${glyph} ${p.title} ${p.done}/${p.total}`;
    });
    lines.push(segs.join(" ── "));
  }

  if (agents.length > 0) lines.push("");
  for (const a of agents) {
    const dur = fmtDuration((a.endTs ?? endTs) - a.startTs);
    const backend = a.model ? `${a.backend}·${a.model}` : a.backend;
    const tok = fmtTokens(a.usage.outputTokens);
    let line: string;
    switch (a.status) {
      case "failed":
        line = c.red(
          `${statusGlyph("failed")} ${a.n} ${a.label} · ${backend} · ${dur} · ${tok} tok · ${truncate(a.error ?? "failed", 80)}`,
        );
        break;
      case "skipped":
        line = c.dim(`${statusGlyph("skipped")} ${a.n} ${a.label} · ${backend} · ${dur} · skipped`);
        break;
      case "ok":
        line = `${c.green(statusGlyph("ok"))} ${a.n} ${a.label} · ${backend} · ${dur} · ${tok} tok`;
        break;
      case "running": {
        const act = a.activity ? ` · ${truncate(a.activity.text, 60)}` : "";
        line = `${c.cyan(statusGlyph("running"))} ${a.n} ${a.label} · ${backend} · ${dur} · ${tok} tok${act}`;
        break;
      }
    }
    lines.push("  " + line);
  }

  if (state.narrator.length > 0) {
    lines.push("");
    for (const entry of state.narrator.slice(-NARRATOR_TAIL)) {
      const text = `${fmtClock(entry.ts)} ${entry.text}`;
      lines.push("  " + (entry.warn ? c.yellow(text) : c.dim(text)));
    }
  }

  const loops = detectLoops(state, opts?.readAgentOutput ?? (() => null), endTs);
  if (loops.length > 0) {
    lines.push("");
    lines.push(c.bold("LOOPS"));
    for (const loop of loops) {
      lines.push(
        `  ${loop.id} · ${formatLoopStatus(loop)} · ${trajectoryStrip(loop.rounds)} · ${formatLoopTotals(loop)}`,
      );
      for (const round of loop.rounds) {
        lines.push(
          `    r${round.n} ${roundVerdictLabel(round)} · ${round.agents.length} agent${
            round.agents.length === 1 ? "" : "s"
          } · ${fmtTokens(round.outputTokens)} tok · ${fmtDuration(round.durationMs)}`,
        );
      }
    }
  }

  const tail: string[] = [];
  if (state.status === "ok" && state.resultRef) {
    tail.push(c.green(`result: ${state.resultRef}`));
  } else if (state.status === "failed") {
    tail.push(c.red(`error: ${state.error ?? "unknown"}`));
  } else if (state.status === "stopped") {
    tail.push(c.yellow("stopped by user"));
  }
  for (const a of agents) {
    if (a.status === "failed" && a.threadId) {
      tail.push(c.dim(`  resume agent ${a.n} (${a.label}): codex resume ${a.threadId}`));
    }
  }
  if (tail.length > 0) {
    lines.push("");
    lines.push(...tail);
  }

  return lines.join("\n");
}
