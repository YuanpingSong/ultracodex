import fs from "node:fs";
import path from "node:path";
import { Box, Text, useInput } from "ink";
import { useMemo, type ReactElement } from "react";
import { AGENTS_DIR } from "../constants.js";
import { slugify } from "../ids.js";
import { copyToClipboard, openInEditor } from "./clipboard.js";
import { col } from "./colors.js";
import { fmtDuration, fmtTokens, statusColor, statusGlyph, truncate } from "./format.js";
import { useFileTail, useFlash } from "./hooks.js";
import type { AgentView } from "./reducer.js";

const PROMPT_LINES = 8;
const EVENT_LINES = 10;
const OUTPUT_LINES = 12;

export interface AgentDetailProps {
  runDir: string;
  agent: AgentView;
  now: number;
  onBack: () => void;
  onQuit: () => void;
}

export function AgentDetail({ runDir, agent, now, onBack, onQuit }: AgentDetailProps): ReactElement {
  const [flash, showFlash] = useFlash();
  const dir = path.join(runDir, AGENTS_DIR, `${agent.n}-${slugify(agent.label)}`);

  const prompt = useMemo<string | null>(() => {
    try {
      return fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
    } catch {
      return null;
    }
  }, [dir]);

  const eventLines = useFileTail(path.join(dir, "events.jsonl"), EVENT_LINES);
  const outputPath =
    agent.resultRef !== null && agent.status !== "running" ? path.join(runDir, agent.resultRef) : null;
  const outputLines = useFileTail(outputPath, OUTPUT_LINES);

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    } else if (input === "q") {
      onQuit();
    } else if (input === "c") {
      if (!agent.threadId) showFlash("no thread id yet");
      else if (copyToClipboard(`codex resume ${agent.threadId}`)) showFlash("copied: codex resume " + agent.threadId);
      else showFlash("clipboard unavailable — codex resume " + agent.threadId);
    } else if (input === "o") {
      if (outputPath) openInEditor(outputPath);
      else showFlash("no output yet");
    }
  });

  const dur = fmtDuration((agent.endTs ?? now) - agent.startTs);
  const backend = agent.model ? `${agent.backend}·${agent.model}` : agent.backend;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={col(statusColor(agent.status))}>{statusGlyph(agent.status)}</Text>{" "}
        <Text bold>{agent.label}</Text>
        <Text dimColor>
          {" "}
          · #{agent.n} · {backend} · {agent.status} · {dur} · {fmtTokens(agent.usage.outputTokens)} tok ·{" "}
          {agent.activityCount} acts
        </Text>
      </Text>
      {agent.threadId && <Text dimColor>thread {agent.threadId} — press c to copy resume command</Text>}
      {agent.error && <Text color={col("red")}>error: {truncate(agent.error, 200)}</Text>}

      <Box flexDirection="column" marginTop={1}>
        <Text bold color={col("cyan")}>
          Prompt
        </Text>
        {prompt === null ? (
          <Text dimColor>(prompt.md not found)</Text>
        ) : (
          prompt
            .split("\n")
            .slice(0, PROMPT_LINES)
            .map((l, i) => (
              <Text key={i} dimColor wrap="truncate-end">
                {l || " "}
              </Text>
            ))
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold color={col("cyan")}>
          Events {agent.status === "running" ? "(live)" : ""}
        </Text>
        {eventLines.length === 0 ? (
          <Text dimColor>(no events yet)</Text>
        ) : (
          eventLines.map((l, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {l}
            </Text>
          ))
        )}
      </Box>

      {outputPath !== null && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={col("cyan")}>
            Output — {agent.resultRef}
          </Text>
          {outputLines.map((l, i) => (
            <Text key={i} wrap="truncate-end">
              {l}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>c copy resume · o open output in $EDITOR · esc back · q quit</Text>
        {flash && <Text color={col("cyan")}> {flash}</Text>}
      </Box>
    </Box>
  );
}
