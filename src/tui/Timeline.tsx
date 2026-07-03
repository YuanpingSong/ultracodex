import { Box, Text, useInput, useStdout } from "ink";
import type { ReactElement } from "react";
import { col } from "./colors.js";
import { fmtDuration, ganttBar, statusColor, statusGlyph, truncate } from "./format.js";
import type { TuiState } from "./reducer.js";

const LABEL_WIDTH = 16;

export interface TimelineProps {
  state: TuiState;
  now: number;
  onBack: () => void;
  onQuit: () => void;
}

export function Timeline({ state, now, onBack, onQuit }: TimelineProps): ReactElement {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 100;
  const barWidth = Math.max(10, columns - LABEL_WIDTH - 8);

  useInput((input, key) => {
    if (key.escape || input === "t") onBack();
    else if (input === "q") onQuit();
  });

  const agents = [...state.agents.values()].sort((a, b) => a.n - b.n);
  const runStart = state.startTs ?? now;
  const runEnd = state.endTs ?? now;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={col("cyan")}>
        Timeline · {state.meta?.name ?? "?"} · {fmtDuration(runEnd - runStart)} total
      </Text>
      {agents.length === 0 && <Text dimColor>no agents yet</Text>}
      {agents.map((a) => {
        const { offset, length } = ganttBar(a.startTs, a.endTs ?? runEnd, runStart, runEnd, barWidth);
        const label = truncate(`${a.n} ${a.label}`, LABEL_WIDTH - 2).padEnd(LABEL_WIDTH);
        return (
          <Box key={a.n}>
            <Text dimColor={a.status === "skipped"}>
              {statusGlyph(a.status)} {label}
            </Text>
            <Text>{" ".repeat(offset)}</Text>
            <Text color={col(statusColor(a.status))}>{"█".repeat(length)}</Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>
          {" ".repeat(2 + LABEL_WIDTH)}0s{" ".repeat(Math.max(1, barWidth - 4 - fmtDuration(runEnd - runStart).length))}
          {fmtDuration(runEnd - runStart)}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>esc/t back · q quit</Text>
      </Box>
    </Box>
  );
}
