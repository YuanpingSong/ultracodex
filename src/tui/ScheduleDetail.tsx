import fs from "node:fs";
import path from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useState, type ReactElement } from "react";
import { listRuns, runsDir } from "../rundir.js";
import { isExecRunning } from "../schedule/exec.js";
import { nextFireMs, readScheduleSpec, type ScheduleSpec } from "../schedule/spec.js";
import { col } from "./colors.js";
import { spinnerFrame, truncate } from "./format.js";
import { useFlash, useTerminalSize, useTick } from "./hooks.js";
import { RunView } from "./RunView.js";
import {
  execScheduleDetached,
  readLogTailLines,
  removeScheduleForTui,
  toggleSchedulePaused,
} from "./scheduleActions.js";
import {
  execOutcomeGlyph,
  formatScheduleCountdown,
  formatScheduleTimestampShort,
  humanScheduleLabel,
  scheduleStatusGlyph,
  scheduleStatusWord,
} from "./schedules.js";

type Mode = { kind: "main" } | { kind: "confirmRemove" } | { kind: "run"; runDir: string };

interface DetailState {
  spec: ScheduleSpec | null;
  logLines: string[];
  running: boolean;
}

export interface ScheduleDetailProps {
  projectDir: string;
  name: string;
  onBack: () => void;
  onRemoved: () => void;
  onChanged: () => void;
  onQuit: () => void;
}

function readDetailState(projectDir: string, name: string): DetailState {
  let spec: ScheduleSpec | null = null;
  try {
    spec = readScheduleSpec(projectDir, name);
  } catch {
    spec = null;
  }
  return {
    spec,
    logLines: readLogTailLines(projectDir, name, 10),
    running: spec !== null && isExecRunning(projectDir, spec.name),
  };
}

function maxRunsLabel(spec: ScheduleSpec): string {
  return spec.maxRuns === null ? "—" : String(spec.maxRuns);
}

function runDirForId(projectDir: string, runId: string): string | null {
  const direct = path.join(runsDir(projectDir), runId);
  try {
    if (fs.statSync(direct).isDirectory()) return direct;
  } catch {
    // fall through to prefix-capable listRuns lookup
  }
  const match = listRuns(projectDir).find((run) => run.runId === runId);
  return match?.runDir ?? null;
}

export function ScheduleDetail({
  projectDir,
  name,
  onBack,
  onRemoved,
  onChanged,
  onQuit,
}: ScheduleDetailProps): ReactElement {
  const [mode, setMode] = useState<Mode>({ kind: "main" });
  const [state, setState] = useState<DetailState>(() => readDetailState(projectDir, name));
  const [flash, showFlash] = useFlash(3000);
  const refreshTick = useTick(2000, mode.kind !== "run");
  const secondTick = useTick(1000, mode.kind !== "run");
  const spinTick = useTick(250, state.running && mode.kind !== "run");
  const { rows } = useTerminalSize();
  void secondTick;

  const refresh = (): void => {
    setState(readDetailState(projectDir, name));
    onChanged();
  };

  useEffect(() => {
    if (mode.kind === "run") return;
    setState(readDetailState(projectDir, name));
  }, [projectDir, name, refreshTick, mode.kind]);

  const spec = state.spec;

  const execNow = (): void => {
    if (spec === null) {
      showFlash("schedule not found");
      return;
    }
    if (spec.status !== "active") {
      showFlash(`schedule is ${spec.status}`);
      return;
    }
    try {
      execScheduleDetached(spec);
      showFlash(`exec started: ${spec.name}`);
      refresh();
    } catch (err) {
      showFlash(`exec failed: ${(err as Error).message}`);
    }
  };

  const togglePaused = (): void => {
    if (spec === null) {
      showFlash("schedule not found");
      return;
    }
    try {
      const next = toggleSchedulePaused(projectDir, spec.name);
      showFlash(next.status === "paused" ? `paused schedule ${next.name}` : `resumed schedule ${next.name}`);
      refresh();
    } catch (err) {
      showFlash((err as Error).message);
      refresh();
    }
  };

  const remove = (): void => {
    if (spec === null) {
      onRemoved();
      return;
    }
    try {
      removeScheduleForTui(projectDir, spec.name);
      showFlash(`removed schedule ${spec.name}`);
    } catch (err) {
      showFlash(`remove failed: ${(err as Error).message}`);
      setMode({ kind: "main" });
      refresh();
      return;
    }
    onRemoved();
  };

  const openLastRun = (): void => {
    const runId = spec?.lastRun?.runId;
    if (!runId) {
      showFlash("no run id");
      return;
    }
    const runDir = runDirForId(projectDir, runId);
    if (runDir === null) {
      showFlash(`run not found: ${runId}`);
      return;
    }
    setMode({ kind: "run", runDir });
  };

  useInput(
    (input, key) => {
      if (mode.kind === "confirmRemove") {
        if (input === "y") remove();
        else if (input === "n" || key.escape) setMode({ kind: "main" });
        return;
      }
      if (key.escape) onBack();
      else if (input === "q") onQuit();
      else if (input === "e") execNow();
      else if (input === "p") togglePaused();
      else if (input === "x") setMode({ kind: "confirmRemove" });
      else if (key.return || input === "o") openLastRun();
    },
    { isActive: mode.kind === "main" || mode.kind === "confirmRemove" },
  );

  if (mode.kind === "run") {
    return (
      <RunView
        projectDir={projectDir}
        runDir={mode.runDir}
        rows={rows}
        onBack={() => setMode({ kind: "main" })}
        onQuit={onQuit}
      />
    );
  }

  if (spec === null) {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text bold color={col("cyan")}>
          schedule
        </Text>
        <Text color={col("red")}>schedule not found: {name}</Text>
        <Box flexGrow={1} />
        <Text dimColor>esc back · q quit</Text>
      </Box>
    );
  }

  const nowMs = Date.now();
  const status = scheduleStatusGlyph(spec.status);
  const spinner = spinnerFrame(spinTick);
  const next = nextFireMs(spec, nowMs);
  const countdown = formatScheduleCountdown({ spec, nowMs, nextMs: next });
  const nextText = next === null ? "—" : formatScheduleTimestampShort(new Date(next).toISOString());
  const lastRun = spec.lastRun;
  const lastGlyph = lastRun === null ? null : execOutcomeGlyph(lastRun.ok);
  const command = spec.command.join(" ");
  const footerOpen = spec.lastRun?.runId ? " · ↵/o open run" : "";

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text wrap="truncate-end">
        <Text bold color={col("cyan")}>
          {spec.name}
        </Text>{" "}
        · {humanScheduleLabel(spec)} ({spec.cronExpr}) ·{" "}
        <Text color={status.color === "dim" ? undefined : col(status.color)} dimColor={status.dim}>
          {status.glyph}
        </Text>{" "}
        {scheduleStatusWord(spec.status)}
        {state.running && (
          <Text color={col("cyan")}>
            {" "}
            · {spinner} running now
          </Text>
        )}
      </Text>
      <Text wrap="truncate-end">
        next {nextText} ({countdown}) · runs {spec.runs} · until-done {spec.untilDone ? "yes" : "no"} · max-runs{" "}
        {maxRunsLabel(spec)}
      </Text>
      <Text wrap="truncate-end">command {truncate(command, 180)}</Text>
      <Text dimColor wrap="truncate-end">
        project {spec.projectDir}
      </Text>
      {lastRun === null ? (
        <Text dimColor>last run —</Text>
      ) : (
        <Text wrap="truncate-end">
          last run{" "}
          <Text color={lastGlyph!.color === "dim" ? undefined : col(lastGlyph!.color)}>
            {lastGlyph!.glyph}
          </Text>{" "}
          {formatScheduleTimestampShort(lastRun.ts)} · exit {lastRun.exitCode}
          {lastRun.runId ? ` · ${lastRun.runId}` : ""}
        </Text>
      )}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>LOG</Text>
        {state.logLines.length === 0 ? (
          <Text dimColor>(no log)</Text>
        ) : (
          state.logLines.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))
        )}
      </Box>
      <Box flexGrow={1} />
      <Text dimColor wrap="truncate-end">
        {mode.kind === "confirmRemove"
          ? `remove ${spec.name}? y/n`
          : `e exec now · p pause/resume · x remove${footerOpen} · esc back · q quit`}
      </Text>
      {flash && <Text color={col("cyan")}> {flash}</Text>}
    </Box>
  );
}
