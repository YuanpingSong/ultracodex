import fs from "node:fs";
import path from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { appendControl } from "../control.js";
import { pidAlive, readPid } from "../rundir.js";
import { AgentDetail } from "./AgentDetail.js";
import { copyToClipboard } from "./clipboard.js";
import { col } from "./colors.js";
import {
  budgetBar,
  fmtClock,
  fmtDuration,
  fmtTokens,
  liveOutputTokens,
  spinnerFrame,
  statusColor,
  statusGlyph,
  truncate,
} from "./format.js";
import { useFlash, useFileTail, useJournalState, useTick } from "./hooks.js";
import type { AgentView, TuiState } from "./reducer.js";
import { Timeline } from "./Timeline.js";

const CARD_TIER_MAX = 8;
const ROW_TIER_MAX = 30;
const CARD_OK_KEEP = 3;
const NARRATOR_TAIL = 4;

/** How long a live runner may go without a pidfile before we call it dead. */
export const RUNNER_START_GRACE_MS = 5000;

/**
 * Dead-runner heuristic while the journal still says "running":
 * - pidfile present → dead iff the pid is gone;
 * - no pidfile → the runner writes it right after run_start, so a runner that
 *   died first never will. Dead once run_start (or, before run_start, the
 *   attach time) is older than a small grace period.
 */
export function runnerLooksDead(opts: {
  pid: number | null;
  alive: boolean;
  runStartTs: number | null;
  attachedTs: number;
  now: number;
  graceMs?: number;
}): boolean {
  if (opts.pid !== null) return !opts.alive;
  const since = opts.runStartTs ?? opts.attachedTs;
  return opts.now - since > (opts.graceMs ?? RUNNER_START_GRACE_MS);
}

type Mode =
  | { kind: "main" }
  | { kind: "detail"; n: number }
  | { kind: "timeline" }
  | { kind: "confirm"; action: "stop" | "skip"; n?: number };

export interface RunViewProps {
  projectDir: string;
  runDir: string;
  onBack: () => void;
  onQuit: () => void;
}

export function RunView({ runDir, onBack, onQuit }: RunViewProps): ReactElement {
  const state = useJournalState(runDir);
  const running = state.status === "running";
  useTick(250, running); // spinner + elapsed re-render while live
  const now = Date.now();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 100;

  const [mode, setMode] = useState<Mode>({ kind: "main" });
  const [selIdx, setSelIdx] = useState(0);
  const [flash, showFlash] = useFlash(2500);

  const [runnerDead, setRunnerDead] = useState(false);
  const [attachedTs] = useState(() => Date.now());
  const startTs = state.startTs;
  useEffect(() => {
    if (!running) {
      setRunnerDead(false);
      return;
    }
    const check = (): void => {
      const pid = readPid(runDir);
      setRunnerDead(
        runnerLooksDead({
          pid,
          alive: pid !== null && pidAlive(pid),
          runStartTs: startTs,
          attachedTs,
          now: Date.now(),
        }),
      );
    };
    check();
    const t = setInterval(check, 2000);
    return () => clearInterval(t);
  }, [runDir, running, startTs, attachedTs]);

  const controlsEnabled = running && !runnerDead;

  const agents = useMemo(() => [...state.agents.values()].sort((a, b) => a.n - b.n), [state]);
  const tier = agents.length <= CARD_TIER_MAX ? "cards" : agents.length <= ROW_TIER_MAX ? "rows" : "aggregate";
  const selectable = useMemo(
    () => (tier === "aggregate" ? agents.filter((a) => a.status === "running" || a.status === "failed") : agents),
    [agents, tier],
  );
  const sel = Math.min(selIdx, Math.max(0, selectable.length - 1));
  const selectedAgent = selectable[sel];

  const exportResult = (): void => {
    if (!state.resultRef) {
      showFlash("no result yet");
      return;
    }
    const abs = path.join(runDir, state.resultRef);
    let contents: string | null = null;
    try {
      contents = fs.readFileSync(abs, "utf8");
    } catch {
      // fall through
    }
    if (contents !== null && copyToClipboard(contents)) showFlash("result copied to clipboard");
    else showFlash(`result: ${abs}`);
  };

  useInput(
    (input, key) => {
      if (mode.kind === "confirm") {
        if (input === "y") {
          if (mode.action === "stop") {
            appendControl(runDir, { cmd: "stop" });
            showFlash("stop sent");
          } else if (mode.action === "skip" && mode.n !== undefined) {
            appendControl(runDir, { cmd: "skip", n: mode.n });
            showFlash(`skip agent ${mode.n} sent`);
          }
        }
        setMode({ kind: "main" });
        return;
      }
      if (key.upArrow) setSelIdx(Math.max(0, sel - 1));
      else if (key.downArrow) setSelIdx(Math.min(Math.max(0, selectable.length - 1), sel + 1));
      else if (key.return) {
        if (selectedAgent) setMode({ kind: "detail", n: selectedAgent.n });
      } else if (input === "t") setMode({ kind: "timeline" });
      else if (input === "p") {
        if (!controlsEnabled) showFlash(runnerDead ? "runner exited — controls disabled" : "run is not running");
        else {
          appendControl(runDir, { cmd: state.paused ? "resume" : "pause" });
          showFlash(state.paused ? "resume sent" : "pause sent");
        }
      } else if (input === "x") {
        if (!controlsEnabled) showFlash(runnerDead ? "runner exited — controls disabled" : "run is not running");
        else setMode({ kind: "confirm", action: "stop" });
      } else if (input === "k") {
        if (!controlsEnabled) showFlash(runnerDead ? "runner exited — controls disabled" : "run is not running");
        else if (selectedAgent && selectedAgent.status === "running")
          setMode({ kind: "confirm", action: "skip", n: selectedAgent.n });
        else showFlash("select a running agent to skip");
      } else if (input === "s") exportResult();
      else if (key.escape) onBack();
      else if (input === "q") onQuit();
    },
    { isActive: mode.kind === "main" || mode.kind === "confirm" },
  );

  if (mode.kind === "timeline") {
    return <Timeline state={state} now={now} onBack={() => setMode({ kind: "main" })} onQuit={onQuit} />;
  }
  if (mode.kind === "detail") {
    const agent = state.agents.get(mode.n);
    if (agent) {
      return (
        <AgentDetail
          runDir={runDir}
          agent={agent}
          now={now}
          onBack={() => setMode({ kind: "main" })}
          onQuit={onQuit}
        />
      );
    }
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header state={state} now={now} />
      {runnerDead && running && (
        <Text color={col("red")} bold>
          runner exited (no run_end) — controls disabled
        </Text>
      )}
      <PhaseStrip state={state} />
      <Box flexDirection="column" marginTop={1}>
        {agents.length === 0 && <Text dimColor>waiting for agents…</Text>}
        {tier === "cards" && (
          <Cards agents={agents} selected={selectedAgent} now={now} endTs={state.endTs} columns={columns} />
        )}
        {tier === "rows" &&
          agents.map((a) => (
            <AgentRow key={a.n} agent={a} selected={a === selectedAgent} now={now} endTs={state.endTs} columns={columns} />
          ))}
        {tier === "aggregate" && (
          <Aggregate state={state} selectable={selectable} selected={selectedAgent} now={now} columns={columns} />
        )}
      </Box>
      {state.narrator.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {state.narrator.slice(-NARRATOR_TAIL).map((entry, i) => (
            <Text key={i} color={entry.warn ? col("yellow") : undefined} dimColor={!entry.warn}>
              {fmtClock(entry.ts)} {truncate(entry.text, Math.max(20, columns - 12))}
            </Text>
          ))}
        </Box>
      )}
      {state.status !== "running" && <ResultPane state={state} runDir={runDir} />}
      <Box marginTop={1}>
        {mode.kind === "confirm" ? (
          <Text color={col("yellow")} bold>
            {mode.action === "stop" ? "stop the run?" : `skip agent ${mode.n}?`} y/n
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            ↑↓ select · ↵ detail · t timeline · p {state.paused ? "resume" : "pause"} · x stop · k skip · s result ·
            esc home · q quit
          </Text>
        )}
        {flash && <Text color={col("cyan")}> {flash}</Text>}
      </Box>
    </Box>
  );
}

function Header({ state, now }: { state: TuiState; now: number }): ReactElement {
  const endTs = state.endTs ?? now;
  const elapsed = state.startTs !== null ? endTs - state.startTs : 0;
  const agents = [...state.agents.values()];
  const done = agents.filter((a) => a.status !== "running").length;
  const tokens = liveOutputTokens(state);
  const statusCol =
    state.status === "ok" ? "green" : state.status === "failed" ? "red" : state.status === "stopped" ? "yellow" : "cyan";
  return (
    <Text wrap="truncate-end">
      <Text bold color={col("cyan")}>
        {state.meta?.name ?? "(waiting for runner…)"}
      </Text>
      <Text dimColor> · {state.runId ?? "?"} · </Text>
      <Text color={col(statusCol)}>{state.status}</Text>
      <Text dimColor>
        {" "}
        · {fmtDuration(elapsed)} · {done}/{agents.length} agents · {fmtTokens(tokens)} tok
      </Text>
      {state.budgetTotal !== null && (
        <Text color={col("magenta")}> {budgetBar(tokens, state.budgetTotal)}</Text>
      )}
      {state.paused && (
        <Text color={col("yellow")} bold inverse>
          {" PAUSED "}
        </Text>
      )}
    </Text>
  );
}

function PhaseStrip({ state }: { state: TuiState }): ReactElement | null {
  if (state.phases.length === 0) return null;
  return (
    <Box>
      {state.phases.map((p, i) => {
        const finished =
          p.total > 0 && p.running === 0 && p.done + p.failed === p.total && p.title !== state.currentPhase;
        const active = p.running > 0 || p.title === state.currentPhase;
        const glyph = finished ? "✔" : active ? "●" : "○";
        const color = finished ? "green" : active ? "cyan" : undefined;
        return (
          <Text key={p.title}>
            {i > 0 && <Text dimColor> ── </Text>}
            <Text color={color ? col(color) : undefined} dimColor={!finished && !active}>
              {glyph} {p.title} {p.done}/{p.total}
            </Text>
            {p.failed > 0 && <Text color={col("red")}> ✖{p.failed}</Text>}
          </Text>
        );
      })}
    </Box>
  );
}

function Cards({
  agents,
  selected,
  now,
  endTs,
  columns,
}: {
  agents: AgentView[];
  selected: AgentView | undefined;
  now: number;
  endTs: number | null;
  columns: number;
}): ReactElement {
  const okAgents = agents.filter((a) => a.status === "ok");
  const collapsed = new Set(
    okAgents
      .slice(0, Math.max(0, okAgents.length - CARD_OK_KEEP))
      .filter((a) => a !== selected)
      .map((a) => a.n),
  );
  return (
    <Box flexDirection="column">
      {collapsed.size > 0 && (
        <Text dimColor>
          {"  "}({collapsed.size} more <Text color={col("green")}>✔</Text>)
        </Text>
      )}
      {agents
        .filter((a) => !collapsed.has(a.n))
        .map((a) => (
          <AgentCard key={a.n} agent={a} selected={a === selected} now={now} endTs={endTs} columns={columns} />
        ))}
    </Box>
  );
}

function AgentCard({
  agent: a,
  selected,
  now,
  endTs,
  columns,
}: {
  agent: AgentView;
  selected: boolean;
  now: number;
  endTs: number | null;
  columns: number;
}): ReactElement {
  const pointer = selected ? "❯ " : "  ";
  const dur = fmtDuration((a.endTs ?? endTs ?? now) - a.startTs);
  const backend = a.model ? `${a.backend}·${a.model}` : a.backend;
  const glyph =
    a.status === "running" ? (
      <Text color={col("cyan")}>{spinnerFrame(Math.floor(now / 250))}</Text>
    ) : (
      <Text color={col(statusColor(a.status))}>{statusGlyph(a.status)}</Text>
    );

  if (a.status === "ok") {
    return (
      <Text dimColor={!selected} wrap="truncate-end">
        {pointer}
        <Text color={col("green")}>✔</Text> {a.label} <Text dimColor>· {fmtTokens(a.usage.outputTokens)} tok · {dur}</Text>
      </Text>
    );
  }
  if (a.status === "skipped") {
    return (
      <Text dimColor wrap="truncate-end">
        {pointer}⊘ {a.label} · skipped
      </Text>
    );
  }
  if (a.status === "failed") {
    return (
      <Text color={col("red")} wrap="truncate-end">
        {pointer}✖ {a.label} — {truncate(a.error ?? "failed", Math.max(20, columns - a.label.length - 8))}
      </Text>
    );
  }
  const verifying = a.activity?.phase === "verifying";
  return (
    <Box flexDirection="column">
      <Text bold={selected} wrap="truncate-end">
        {pointer}
        {glyph} {a.label} <Text dimColor>{backend}</Text>{" "}
        <Text color={col("yellow")}>{fmtTokens(a.usage.outputTokens)} tok</Text>{" "}
        <Text dimColor>
          {a.activityCount} acts · {dur}
        </Text>
      </Text>
      {a.activity && (
        <Text color={verifying ? col("yellow") : undefined} dimColor={!verifying} wrap="truncate-end">
          {"    "}
          {truncate(a.activity.text, Math.max(20, columns - 6))}
        </Text>
      )}
    </Box>
  );
}

function AgentRow({
  agent: a,
  selected,
  now,
  endTs,
  columns,
}: {
  agent: AgentView;
  selected: boolean;
  now: number;
  endTs: number | null;
  columns: number;
}): ReactElement {
  const pointer = selected ? "❯ " : "  ";
  const dur = fmtDuration((a.endTs ?? endTs ?? now) - a.startTs);
  const act =
    a.status === "running" && a.activity
      ? ` · ${truncate(a.activity.text, 40)}`
      : a.status === "failed"
        ? ` — ${truncate(a.error ?? "failed", 40)}`
        : "";
  return (
    <Text
      color={a.status === "failed" ? col("red") : undefined}
      dimColor={a.status === "ok" || a.status === "skipped"}
      bold={selected}
      wrap="truncate-end"
    >
      {pointer}
      <Text color={col(statusColor(a.status))}>
        {a.status === "running" ? spinnerFrame(Math.floor(now / 250)) : statusGlyph(a.status)}
      </Text>{" "}
      {a.label} <Text dimColor>· {a.backend} · {fmtTokens(a.usage.outputTokens)} tok · {dur}</Text>
      {act}
    </Text>
  );
}

function Aggregate({
  state,
  selectable,
  selected,
  now,
  columns,
}: {
  state: TuiState;
  selectable: AgentView[];
  selected: AgentView | undefined;
  now: number;
  columns: number;
}): ReactElement {
  return (
    <Box flexDirection="column">
      {state.phases.map((p) => (
        <Text key={p.title} dimColor>
          {p.title}: {p.running} running · {p.done} done{p.failed > 0 ? ` · ${p.failed} failed` : ""} of {p.total}
        </Text>
      ))}
      {selectable.map((a) => (
        <AgentRow key={a.n} agent={a} selected={a === selected} now={now} endTs={state.endTs} columns={columns} />
      ))}
    </Box>
  );
}

function ResultPane({ state, runDir }: { state: TuiState; runDir: string }): ReactElement {
  const resultPath = state.resultRef !== null ? path.join(runDir, state.resultRef) : null;
  const lines = useFileTail(resultPath, 20, 2000);
  const title =
    state.status === "ok" ? "Result" : state.status === "stopped" ? "Stopped" : "Failed";
  const color = state.status === "ok" ? "green" : state.status === "stopped" ? "yellow" : "red";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={col(color)} paddingX={1} marginTop={1}>
      <Text bold color={col(color)}>
        {title}
        {state.resultRef ? <Text dimColor> — {state.resultRef}</Text> : null}
      </Text>
      {state.error && <Text color={col("red")}>{state.error}</Text>}
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l}
        </Text>
      ))}
      {resultPath !== null && lines.length === 0 && <Text dimColor>(empty result)</Text>}
    </Box>
  );
}
