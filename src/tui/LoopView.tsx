import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { AgentDetail } from "./AgentDetail.js";
import { col } from "./colors.js";
import {
  costSparkline,
  deltaPct,
  detectLoops,
  formatLoopHeaderLine,
  formatRoundLedgerRow,
  roundIsRunning,
  verdictGlyph,
  type LoopInstance,
  type Round,
} from "./loops.js";
import { makeAgentOutputReader, readJsonOutputCapped } from "./loopFiles.js";
import { fmtDuration, fmtTokens, spinnerFrame, statusColor, statusGlyph, truncate } from "./format.js";
import { useJournalState, useTick } from "./hooks.js";
import type { AgentView } from "./reducer.js";

type Mode = { kind: "main" } | { kind: "detail"; n: number };

export interface LoopViewProps {
  runDir: string;
  initialLoopId?: string;
  onBack: () => void;
  onQuit: () => void;
}

export function LoopView({ runDir, initialLoopId, onBack, onQuit }: LoopViewProps): ReactElement {
  const state = useJournalState(runDir);
  const running = state.status === "running";
  useTick(250, running);
  const now = Date.now();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 100;
  const spinner = spinnerFrame(Math.floor(now / 250));
  const readAgentOutput = useMemo(() => makeAgentOutputReader(runDir), [runDir]);
  const runResult = useMemo(
    () => readJsonOutputCapped(runDir, state.resultRef),
    [runDir, state.resultRef],
  );
  const loops = useMemo(
    () => detectLoops(state, readAgentOutput, now, runResult),
    [state, readAgentOutput, now, runResult],
  );

  const appliedInitialLoop = useRef(false);
  const [mode, setMode] = useState<Mode>({ kind: "main" });
  const [loopIdx, setLoopIdx] = useState(0);
  const [roundIdx, setRoundIdx] = useState(0);

  useEffect(() => {
    if (loops.length === 0) return;
    if (!appliedInitialLoop.current && initialLoopId !== undefined) {
      const idx = loops.findIndex((loop) => loop.id === initialLoopId);
      if (idx >= 0) setLoopIdx(idx);
      appliedInitialLoop.current = true;
      return;
    }
    setLoopIdx((idx) => Math.min(idx, loops.length - 1));
  }, [initialLoopId, loops]);

  const loop = loops[loopIdx];
  useEffect(() => {
    setRoundIdx((idx) => Math.min(idx, Math.max(0, (loop?.rounds.length ?? 1) - 1)));
  }, [loop]);

  const selectedRound = loop?.rounds[roundIdx];
  const focusedAgent = selectedRound?.agents[selectedRound.agents.length - 1];

  useInput(
    (input, key) => {
      if (key.escape) onBack();
      else if (input === "q") onQuit();
      else if ((input === "L" || input === "l") && loops.length > 1) {
        setLoopIdx((idx) => (idx + 1) % loops.length);
        setRoundIdx(0);
      } else if (key.upArrow && loop !== undefined) {
        setRoundIdx((idx) => Math.max(0, idx - 1));
      } else if (key.downArrow && loop !== undefined) {
        setRoundIdx((idx) => Math.min(loop.rounds.length - 1, idx + 1));
      } else if (key.return && focusedAgent !== undefined) {
        setMode({ kind: "detail", n: focusedAgent.n });
      }
    },
    { isActive: mode.kind === "main" },
  );

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

  if (loop === undefined) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text bold color={col("cyan")}>
          loops
        </Text>
        <Text dimColor>no loops detected in this run</Text>
        <Box flexGrow={1} />
        <Text dimColor>esc back · q quit</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text wrap="truncate-end">
        <Text bold color={col("cyan")}>
          {formatLoopHeaderLine(loop, state.runId, spinner)}
        </Text>
        {loops.length > 1 && (
          <Text dimColor>
            {" "}
            · loop {loopIdx + 1}/{loops.length} · L next
          </Text>
        )}
      </Text>

      <Hero loop={loop} spinner={spinner} columns={columns} />

      <Box flexDirection="column" marginTop={1}>
        <Text bold>ROUND LEDGER</Text>
        <Text dimColor>  rnd  verdict   agents tok    Δtok   time</Text>
        {loop.rounds.map((round, i) => (
          <Text key={round.n} bold={i === roundIdx} wrap="truncate-end">
            {formatRoundLedgerRow(loop, i, i === roundIdx, spinner)}
          </Text>
        ))}
      </Box>

      {selectedRound !== undefined && (
        <RoundAgents round={selectedRound} now={now} endTs={state.endTs} columns={columns} />
      )}

      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">
        ↑↓ rounds · ↵ agent detail · esc back · q quit
        {loops.length > 1 ? ` · loop ${loopIdx + 1}/${loops.length} · L next` : ""}
      </Text>
    </Box>
  );
}

function Hero({ loop, spinner, columns }: { loop: LoopInstance; spinner: string; columns: number }): ReactElement {
  const capped = loop.rounds.length > 10;
  const visible = capped ? loop.rounds.slice(-10) : loop.rounds;
  const chipPrefix = capped ? "… " : "";
  const chipWidth = visible.length > 5 ? 9 : 13;
  const chips =
    chipPrefix +
    visible
      .map((round) => `r${round.n} ${verdictGlyph(round.verdict, roundIsRunning(round), spinner)}`.padEnd(chipWidth))
      .join("")
      .trimEnd();
  const tokenLine =
    (capped ? "  " : "") +
    visible
      .map((round) => fmtTokens(round.outputTokens).padEnd(chipWidth))
      .join("")
      .trimEnd();
  const first = loop.rounds[0]?.outputTokens ?? 0;
  const last = loop.rounds[loop.rounds.length - 1]?.outputTokens ?? 0;
  const spark = `cost/round ${costSparkline(loop.rounds)} ${deltaPct(first, last)}`;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate-end">  {truncate(chips, Math.max(20, columns - 2))}</Text>
      <Box>
        <Text wrap="truncate-end"> {truncate(tokenLine, Math.max(20, columns - spark.length - 4))}</Text>
        <Box flexGrow={1} />
        <Text dimColor wrap="truncate-end">
          {spark}
        </Text>
      </Box>
    </Box>
  );
}

function RoundAgents({
  round,
  now,
  endTs,
  columns,
}: {
  round: Round;
  now: number;
  endTs: number | null;
  columns: number;
}): ReactElement {
  const verdict = round.verdict.text
    ? `    └ verdict: ${round.verdict.kind} — "${truncate(round.verdict.text, Math.max(20, columns - 30))}"`
    : null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        ROUND r{round.n} — {round.agents.length} agent{round.agents.length === 1 ? "" : "s"}
      </Text>
      {round.agents.map((agent) => (
        <LoopAgentRow key={agent.n} agent={agent} now={now} endTs={endTs} columns={columns} />
      ))}
      {verdict !== null && (
        <Text dimColor wrap="truncate-end">
          {verdict}
        </Text>
      )}
    </Box>
  );
}

function LoopAgentRow({
  agent: a,
  now,
  endTs,
  columns,
}: {
  agent: AgentView;
  now: number;
  endTs: number | null;
  columns: number;
}): ReactElement {
  const dur = fmtDuration((a.endTs ?? endTs ?? now) - a.startTs);
  const backend = a.model ? `${a.backend}·${a.model}` : a.backend;
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
      wrap="truncate-end"
    >
      {"  "}
      <Text color={col(statusColor(a.status))}>
        {a.status === "running" ? spinnerFrame(Math.floor(now / 250)) : statusGlyph(a.status)}
      </Text>{" "}
      {truncate(a.label, Math.max(10, columns - 44))}{" "}
      <Text dimColor>
        · {backend} · {dur} · {fmtTokens(a.usage.outputTokens)} tok
      </Text>
      {act}
    </Text>
  );
}
