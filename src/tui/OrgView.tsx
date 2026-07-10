import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactElement, type SetStateAction } from "react";
import { col } from "./colors.js";
import { TabOnboarding, ORG_ONBOARDING } from "./onboarding.js";
import {
  buildOrgTreeRows,
  defaultOrgExpanded,
  defaultOrgSelectedPath,
  displayOrgPath,
  formatOrgAttentionRow,
  formatOrgBriefBodyLines,
  formatOrgBriefQueueRow,
  formatOrgBriefStatusLine,
  formatOrgDetailLines,
  formatOrgMovedRow,
  formatOrgOpsFooterLine,
  formatOrgOpsHeaderLine,
  formatOrgTreeDisplayRow,
  formatOrgTreeHeaderLine,
  nextOrgSubview,
  type OrgAgentSnapshot,
  type OrgSeverity,
  type OrgSnapshot,
  type OrgSubview,
  type OrgTreeDisplayRow,
} from "./org.js";
import { markOrgBriefRead, type OrgSnapshotLoad } from "./orgFiles.js";

export interface OrgViewProps {
  projectDir: string;
  load: OrgSnapshotLoad | null;
  active?: boolean;
  onChanged?: () => void;
}

export function OrgView({ projectDir, load, active = true, onChanged }: OrgViewProps): ReactElement {
  const snapshot = load?.snapshot ?? null;
  const [view, setView] = useState<OrgSubview>("tree");
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [selectedPath, setSelectedPath] = useState(".");
  const [briefPath, setBriefPath] = useState(".");
  const markedBrief = useRef<string | null>(null);
  const { stdout } = useStdout();
  const columns = Math.max(40, (stdout?.columns ?? 100) - 2);

  const rows = useMemo(
    () => (snapshot === null ? [] : buildOrgTreeRows(snapshot, expanded)),
    [snapshot, expanded],
  );

  useEffect(() => {
    if (snapshot === null) return;
    setExpanded((current) => pruneExpanded(snapshot, current));
  }, [snapshot]);

  useEffect(() => {
    if (snapshot === null) return;
    setSelectedPath((current) => defaultOrgSelectedPath(snapshot, current, rows));
    setBriefPath((current) => (snapshot.agents.some((agent) => agent.path === current) ? current : "."));
  }, [snapshot, rows]);

  useEffect(() => {
    if (!active || view !== "briefs" || snapshot === null) return;
    const agent = snapshot.agents.find((row) => row.path === briefPath);
    if (agent === undefined) return;
    const key = `${projectDir}\0${agent.path}\0${agent.brief.mtimeMs}`;
    if (markedBrief.current === key) return;
    markedBrief.current = key;
    try {
      markOrgBriefRead(projectDir, agent.path);
      onChanged?.();
    } catch {
      // Brief-read stamps are a navigation convenience; rendering should not fail
      // just because the state file is temporarily unwritable.
    }
  }, [active, briefPath, onChanged, projectDir, snapshot, view]);

  useInput(
    (input, key) => {
      if (snapshot === null) return;
      if (input === "v") {
        setView((current) => nextOrgSubview(current));
        return;
      }
      if (view === "tree") {
        if (input === "j" || key.downArrow) moveTree(rows, selectedPath, 1, setSelectedPath);
        else if (input === "k" || key.upArrow) moveTree(rows, selectedPath, -1, setSelectedPath);
        else if (input === "l" || key.return) toggleExpanded(snapshot, selectedPath, setExpanded);
      } else if (view === "briefs") {
        if (input === "j" || key.downArrow) moveBrief(snapshot, briefPath, 1, setBriefPath);
        else if (input === "k" || key.upArrow) moveBrief(snapshot, briefPath, -1, setBriefPath);
      }
    },
    { isActive: active && snapshot !== null },
  );

  if (snapshot === null) {
    return (
      <>
        <Text bold>Org</Text>
        <Text dimColor> loading org state</Text>
      </>
    );
  }

  if (view === "ops") return <OrgOpsView snapshot={snapshot} columns={columns} />;
  if (view === "briefs") return <OrgBriefsView snapshot={snapshot} briefPath={briefPath} columns={columns} />;
  return <OrgTreeView snapshot={snapshot} rows={rows} selectedPath={selectedPath} columns={columns} />;
}

function OrgTreeView({
  snapshot,
  rows,
  selectedPath,
  columns,
}: {
  snapshot: OrgSnapshot;
  rows: OrgTreeDisplayRow[];
  selectedPath: string;
  columns: number;
}): ReactElement {
  const leftWidth = Math.max(30, Math.min(46, Math.floor(columns * 0.46)));
  const selected = snapshot.agents.find((agent) => agent.path === selectedPath) ?? snapshot.agents[0] ?? null;
  return (
    <>
      <Text bold>
        Org <Text dimColor>tree</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {formatOrgTreeHeaderLine(snapshot, columns)}
      </Text>
      {snapshot.tickInfo.latestWake === null ? (
        <TabOnboarding o={ORG_ONBOARDING} />
      ) : (
        // In-TUI triggers land in v0.6; for now, point at the real command paths
        // (a tick wakes seats + lints + repairs; audit checks brief accuracy).
        <Box>
          <Text dimColor>drive · </Text>
          <Text color={col("green")}>ultracodex org tick</Text>
          <Text dimColor> · </Text>
          <Text color={col("green")}>ultracodex org audit</Text>
        </Box>
      )}
      {snapshot.agents.length === 0 ? (
        <Text dimColor> no org seats</Text>
      ) : (
        <Box flexDirection="row" marginTop={1}>
          <Box flexDirection="column" width={leftWidth}>
            {rows.map((row) => {
              const agent = snapshot.agents.find((item) => item.path === row.path);
              const isSelected = row.path === selectedPath;
              return (
                <Text
                  key={row.path}
                  bold={isSelected}
                  color={agent ? severityColorProp(agent.severity) : undefined}
                  wrap="truncate-end"
                >
                  {formatOrgTreeDisplayRow(snapshot, row, { selected: isSelected, width: leftWidth })}
                </Text>
              );
            })}
          </Box>
          <Box flexDirection="column" marginLeft={2} flexGrow={1}>
            {selected === null ? <Text dimColor>select a seat</Text> : <OrgSeatDetail snapshot={snapshot} agent={selected} />}
          </Box>
        </Box>
      )}
      <OrgWarnings snapshot={snapshot} />
    </>
  );
}

function OrgSeatDetail({ snapshot, agent }: { snapshot: OrgSnapshot; agent: OrgAgentSnapshot }): ReactElement {
  const lines = formatOrgDetailLines(snapshot, agent.path, { briefLines: 0 });
  return (
    <>
      {lines.slice(0, 5).map((line) => (
        <Text key={line} wrap="truncate-end">
          {line}
        </Text>
      ))}
      <Box flexDirection="column" borderStyle="single" borderColor={col(severityColor(agent.severity) ?? "gray")} paddingX={1} marginTop={1}>
        <Text bold wrap="truncate-end">
          BRIEF {agent.brief.updated ?? "--"} · {agent.brief.confidence ?? "--"}
        </Text>
        {formatOrgBriefBodyLines(snapshot, agent.path, { maxLines: 12 }).map((line, index) => (
          <Text key={`${index}:${line}`} dimColor={index > 7} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
    </>
  );
}

function OrgOpsView({ snapshot, columns }: { snapshot: OrgSnapshot; columns: number }): ReactElement {
  const moved = snapshot.tickInfo.whatMoved;
  const attention = snapshot.tickInfo.attentionRows;
  return (
    <>
      <Text bold>
        Org <Text dimColor>ops</Text>
      </Text>
      <Text wrap="truncate-end">{formatOrgOpsHeaderLine(snapshot, columns)}</Text>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>WHAT MOVED</Text>
        {moved.length === 0 ? (
          <Text dimColor>  no recorded wakes in last tick</Text>
        ) : (
          moved.slice(0, 8).map((row) => (
            <Text key={`${row.time}:${row.seat}:${row.text}`} color={severityColorProp(row.severity)} wrap="truncate-end">
              {formatOrgMovedRow(row, columns)}
            </Text>
          ))
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>NEEDS ATTENTION</Text>
        {attention.length === 0 ? (
          <Text dimColor>  none</Text>
        ) : (
          attention.slice(0, 10).map((row) => (
            <Text key={`${row.kind}:${row.seat}:${row.text}`} color={attentionColor(row.kind)} wrap="truncate-end">
              {formatOrgAttentionRow(row, columns)}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {formatOrgOpsFooterLine(snapshot, columns)}
        </Text>
      </Box>
      <OrgWarnings snapshot={snapshot} />
    </>
  );
}

function OrgBriefsView({
  snapshot,
  briefPath,
  columns,
}: {
  snapshot: OrgSnapshot;
  briefPath: string;
  columns: number;
}): ReactElement {
  const agent = snapshot.agents.find((row) => row.path === briefPath) ?? snapshot.agents.find((row) => row.path === ".") ?? snapshot.agents[0] ?? null;
  const selectedPath = agent?.path ?? ".";
  const wide = columns >= 96;
  const queueWidth = wide ? Math.min(32, Math.floor(columns * 0.32)) : columns;
  const mainWidth = wide ? Math.max(40, columns - queueWidth - 4) : columns;
  const bodyLines = formatOrgBriefBodyLines(snapshot, selectedPath, { maxLines: 18, width: mainWidth });
  const queue = snapshot.unreadBriefs.length ? snapshot.unreadBriefs : [null];
  return (
    <>
      <Text bold>
        Org <Text dimColor>briefs</Text>
      </Text>
      <Text dimColor wrap="truncate-end">
        {displayOrgPath(selectedPath)} · unread {snapshot.unreadBriefs.length}
      </Text>
      <Box flexDirection={wide ? "row" : "column"} marginTop={1}>
        <Box flexDirection="column" width={wide ? mainWidth : undefined}>
          {bodyLines.map((line, index) => (
            <Text key={`${index}:${line}`} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" marginLeft={wide ? 2 : 0} marginTop={wide ? 0 : 1} width={wide ? queueWidth : undefined}>
          <Text bold>UNREAD</Text>
          {queue.slice(0, 10).map((row) => (
            <Text key={row?.path ?? "none"} bold={row?.path === selectedPath} wrap="truncate-end">
              {formatOrgBriefQueueRow(row, { selected: row?.path === selectedPath, width: queueWidth })}
            </Text>
          ))}
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">
        {formatOrgBriefStatusLine(snapshot, selectedPath, columns)}
      </Text>
      <OrgWarnings snapshot={snapshot} />
    </>
  );
}

function OrgWarnings({ snapshot }: { snapshot: OrgSnapshot }): ReactElement | null {
  if (snapshot.warnings.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {snapshot.warnings.slice(0, 2).map((warning) => (
        <Text key={warning} color={col("yellow")} dimColor wrap="truncate-end">
          {warning}
        </Text>
      ))}
    </Box>
  );
}

function moveTree(
  rows: readonly OrgTreeDisplayRow[],
  selectedPath: string,
  delta: number,
  setSelectedPath: (path: string) => void,
): void {
  if (rows.length === 0) return;
  const current = Math.max(0, rows.findIndex((row) => row.path === selectedPath));
  const next = Math.max(0, Math.min(rows.length - 1, current + delta));
  setSelectedPath(rows[next]?.path ?? ".");
}

function toggleExpanded(
  snapshot: OrgSnapshot,
  selectedPath: string,
  setExpanded: Dispatch<SetStateAction<Set<string> | null>>,
): void {
  const children = snapshot.childrenByParent[selectedPath] ?? [];
  if (children.length === 0) return;
  setExpanded((current) => {
    const next = current === null ? defaultOrgExpanded(snapshot) : new Set(current);
    if (next.has(selectedPath)) next.delete(selectedPath);
    else next.add(selectedPath);
    return next;
  });
}

function moveBrief(
  snapshot: OrgSnapshot,
  briefPath: string,
  delta: number,
  setBriefPath: (path: string) => void,
): void {
  const queue = [".", ...snapshot.unreadBriefs.map((row) => row.path)];
  if (queue.length === 0) return;
  const current = Math.max(0, queue.indexOf(briefPath));
  setBriefPath(queue[wrapIndex(current + delta, queue.length)] ?? ".");
}

function pruneExpanded(snapshot: OrgSnapshot, current: Set<string> | null): Set<string> | null {
  if (current === null) return null;
  const valid = new Set(snapshot.agents.map((agent) => agent.path));
  const next = new Set([...current].filter((agentPath) => valid.has(agentPath)));
  return next;
}

function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

function severityColor(severity: OrgSeverity): string | undefined {
  if (severity === "urgent") return "red";
  if (severity === "material") return "yellow";
  if (severity === "notable") return "cyan";
  return undefined;
}

function severityColorProp(severity: OrgSeverity): string | undefined {
  const color = severityColor(severity);
  return color === undefined ? undefined : col(color);
}

function attentionColor(kind: string): string | undefined {
  if (kind === "overdue") return col("red");
  if (kind === "ticket" || kind === "review") return col("yellow");
  return undefined;
}
