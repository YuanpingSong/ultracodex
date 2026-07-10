import { addSchedule } from "../schedule/add.js";
import fs from "node:fs";
import path from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { JOURNAL_FILE, WORKFLOWS_DIR_NAME } from "../constants.js";
import { slugify } from "../ids.js";
import { readJournal } from "../journal.js";
import { parseMeta } from "../loader.js";
import { listRunsReconciled, stateDir } from "../rundir.js";
import { packageRootDir } from "../skills.js";
import type { RunSummary } from "../types.js";
import { col } from "./colors.js";
import { fmtDuration, fmtTokens, parseBudget, spinnerFrame, truncate } from "./format.js";
import { useFlash, useTick } from "./hooks.js";
import { LoopView } from "./LoopView.js";
import { detectLoops, formatLoopListRow, type LoopInstance } from "./loops.js";
import { makeAgentOutputReader, readJsonOutputCapped } from "./loopFiles.js";
import { OrgView } from "./OrgView.js";
import { isOrgProject, refreshOrgSnapshot, type OrgSnapshotLoad } from "./orgFiles.js";
import { initialState, reduce, type TuiState } from "./reducer.js";
import {
  execScheduleDetached,
  loadMissedScheduleWarnings,
  loadScheduleSnapshot,
  refreshScheduleSnapshot,
  removeScheduleForTui,
  toggleSchedulePaused,
  type ScheduleRowItem,
  type ScheduleSnapshot,
} from "./scheduleActions.js";
import { ScheduleDetail } from "./ScheduleDetail.js";
import {
  execOutcomeGlyph,
  formatScheduleBudgetSuffix,
  formatScheduleLastRunCell,
  formatScheduleStateCell,
  humanScheduleLabel,
  scheduleStatusGlyph,
  validateScheduleFormDraft,
  type ScheduleFormDraft,
} from "./schedules.js";
import { prepareRun, rerunFromDir, spawnRunner } from "./spawn.js";

const RUNS_SHOWN = 12;
const LOOPS_SHOWN = 12;
// The Loops tab folds runs to find loops — cheap pure work over journals — so
// it scans well past the 12 rows the Runs tab shows; otherwise a loop in an
// older run reads as "no loops" while `show` on that run detects it.
const LOOPS_SCAN = 60;
const SCHEDULES_SHOWN = 12;

export interface WorkflowItem {
  file: string;
  name: string;
  description: string;
  whenToUse?: string;
  error?: string;
  builtin?: boolean;
}

interface LoopRowItem {
  run: RunSummary;
  loop: LoopInstance;
  loopIndex: number;
  loopCount: number;
}

type HomeTab = "runs" | "loops" | "schedules" | "org";

type Item =
  | { kind: "wf"; wf: WorkflowItem }
  | { kind: "run"; run: RunSummary }
  | { kind: "loop"; row: LoopRowItem }
  | { kind: "schedule"; row: ScheduleRowItem };

type Mode =
  | { kind: "list" }
  | { kind: "launch"; wf: WorkflowItem }
  | { kind: "scheduleForm"; wf: WorkflowItem }
  | { kind: "loop"; runDir: string; loopId: string }
  | { kind: "scheduleDetail"; name: string }
  | { kind: "scheduleRemoveConfirm"; name: string };

function loadWorkflowDir(dir: string, builtin: boolean): WorkflowItem[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  } catch {
    return [];
  }
  return entries.map((f) => {
    const file = path.join(dir, f);
    try {
      const { meta } = parseMeta(fs.readFileSync(file, "utf8"));
      const item: WorkflowItem = { file, name: meta.name, description: meta.description };
      if (meta.whenToUse !== undefined) item.whenToUse = meta.whenToUse;
      if (builtin) item.builtin = true;
      return item;
    } catch (e) {
      const item: WorkflowItem = { file, name: f.replace(/\.js$/, ""), description: "", error: (e as Error).message };
      if (builtin) item.builtin = true;
      return item;
    }
  });
}

export function loadWorkflows(projectDir: string): WorkflowItem[] {
  const saved = loadWorkflowDir(path.join(stateDir(projectDir), WORKFLOWS_DIR_NAME), false);
  const savedNames = new Set(saved.map((wf) => wf.name));
  const builtin = loadWorkflowDir(path.join(packageRootDir(), WORKFLOWS_DIR_NAME), true).filter(
    (wf) => !savedNames.has(wf.name),
  );
  return [...saved, ...builtin];
}

/**
 * Launch-form budget validation, mirroring `cli run --budget` semantics:
 * empty → no budget; "500k" / "1.5m" / plain count → tokens; anything else
 * (or a non-positive amount) is an error — never silently launch unbounded.
 */
export function validateBudgetInput(
  text: string,
): { ok: true; budgetTotal: number | null } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, budgetTotal: null };
  const n = parseBudget(trimmed);
  if (n === null || n <= 0) {
    return {
      ok: false,
      error: `invalid budget "${trimmed}" (use e.g. 500k, 1.5m, or a plain token count)`,
    };
  }
  return { ok: true, budgetTotal: n };
}

function runGlyph(r: RunSummary): { glyph: string; color: string | undefined; dim: boolean } {
  switch (r.status) {
    case "running":
      return { glyph: "●", color: col("cyan"), dim: false };
    case "ok":
      return { glyph: "✔", color: col("green"), dim: false };
    case "failed":
      return { glyph: "✖", color: col("red"), dim: false };
    case "stopped":
      return { glyph: "⊘", color: col("yellow"), dim: false };
    case "dead":
      return { glyph: "✖", color: undefined, dim: true };
  }
}

function foldRun(runDir: string): TuiState {
  let state = initialState();
  for (const event of readJournal(runDir)) state = reduce(state, event);
  return state;
}

function journalMtimeMs(runDir: string): number | null {
  try {
    return fs.statSync(path.join(runDir, JOURNAL_FILE)).mtimeMs;
  } catch {
    return null;
  }
}

function loadLoopRows(
  runs: readonly RunSummary[],
  cache: Map<string, { mtimeMs: number; loops: LoopInstance[] }>,
): LoopRowItem[] {
  const rows: LoopRowItem[] = [];
  for (const run of runs) {
    const mtimeMs = journalMtimeMs(run.runDir);
    if (mtimeMs === null) continue;
    let loops = cache.get(run.runId)?.mtimeMs === mtimeMs ? cache.get(run.runId)!.loops : undefined;
    if (loops === undefined) {
      const state = foldRun(run.runDir);
      loops = detectLoops(
        state,
        makeAgentOutputReader(run.runDir),
        undefined,
        readJsonOutputCapped(run.runDir, state.resultRef),
      );
      cache.set(run.runId, { mtimeMs, loops });
    }
    loops.forEach((loop, loopIndex) => rows.push({ run, loop, loopIndex, loopCount: loops.length }));
    if (rows.length >= LOOPS_SHOWN) return rows.slice(0, LOOPS_SHOWN);
  }
  return rows.slice(0, LOOPS_SHOWN);
}

export interface HomeViewProps {
  projectDir: string;
  onAttach: (runDir: string) => void;
  onQuit: () => void;
}

export function HomeView({ projectDir, onAttach, onQuit }: HomeViewProps): ReactElement {
  const workflows = useMemo(() => loadWorkflows(projectDir), [projectDir]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const tick = useTick(2000, true);
  useEffect(() => {
    let active = true;
    void listRunsReconciled(projectDir).then((nextRuns) => {
      if (active) setRuns(nextRuns);
    });
    return () => {
      active = false;
    };
  }, [projectDir, tick]);

  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [tab, setTab] = useState<HomeTab>("runs");
  const [selIdx, setSelIdx] = useState(0);
  const [loopRows, setLoopRows] = useState<LoopRowItem[]>([]);
  const [scheduleRows, setScheduleRows] = useState<ScheduleRowItem[]>([]);
  const [orgEnabled, setOrgEnabled] = useState(() => isOrgProject(projectDir));
  const [orgLoad, setOrgLoad] = useState<OrgSnapshotLoad | null>(null);
  const [missedWarnings, setMissedWarnings] = useState<string[]>(() => loadMissedScheduleWarnings(projectDir));
  const loopCache = useRef(new Map<string, { mtimeMs: number; loops: LoopInstance[] }>());
  const scheduleSnapshot = useRef<ScheduleSnapshot | null>(null);
  const orgSnapshot = useRef<OrgSnapshotLoad | null>(null);
  const [flash, showFlash] = useFlash(3000);
  const countdownTick = useTick(1000, tab === "schedules");
  void countdownTick;

  const shownRuns = useMemo(() => runs.slice(0, RUNS_SHOWN), [runs]);
  const shownSchedules = useMemo(() => scheduleRows.slice(0, SCHEDULES_SHOWN), [scheduleRows]);
  const scannedRuns = useMemo(() => runs.slice(0, LOOPS_SCAN), [runs]);
  useEffect(() => {
    if (tab !== "loops") return;
    setLoopRows(loadLoopRows(scannedRuns, loopCache.current));
  }, [scannedRuns, tab]);

  useEffect(() => {
    setMissedWarnings(loadMissedScheduleWarnings(projectDir));
  }, [projectDir, tick]);

  useEffect(() => {
    if (tab !== "schedules") return;
    const next = refreshScheduleSnapshot(projectDir, scheduleSnapshot.current, Date.now());
    scheduleSnapshot.current = next;
    setScheduleRows(next.rows);
    setMissedWarnings(next.warnings);
  }, [projectDir, tab, tick]);

  useEffect(() => {
    const enabled = isOrgProject(projectDir);
    setOrgEnabled(enabled);
    if (!enabled) {
      orgSnapshot.current = null;
      setOrgLoad(null);
      if (tab === "org") {
        setTab("runs");
        setSelIdx(0);
      }
    }
  }, [projectDir, tab, tick]);

  useEffect(() => {
    if (tab !== "org" || !orgEnabled) return;
    const next = refreshOrgSnapshot(projectDir, orgSnapshot.current, Date.now());
    orgSnapshot.current = next;
    setOrgLoad(next);
  }, [projectDir, tab, tick, orgEnabled]);

  const items: Item[] =
    tab === "runs"
      ? [
          ...workflows.map((wf): Item => ({ kind: "wf", wf })),
          ...shownRuns.map((run): Item => ({ kind: "run", run })),
        ]
      : tab === "loops"
        ? loopRows.map((row): Item => ({ kind: "loop", row }))
        : tab === "schedules"
          ? shownSchedules.map((row): Item => ({ kind: "schedule", row }))
          : [];
  const sel = Math.min(selIdx, Math.max(0, items.length - 1));
  const selected = items[sel];

  const reloadSchedules = (selectedName?: string): void => {
    const next = loadScheduleSnapshot(projectDir, Date.now());
    scheduleSnapshot.current = next;
    setScheduleRows(next.rows);
    setMissedWarnings(next.warnings);
    if (selectedName !== undefined) {
      const visible = next.rows.slice(0, SCHEDULES_SHOWN);
      const idx = visible.findIndex((row) => row.spec.name === selectedName);
      setSelIdx(Math.max(0, idx));
    }
  };

  const reloadOrg = (): void => {
    if (!orgEnabled) return;
    const next = refreshOrgSnapshot(projectDir, null, Date.now());
    orgSnapshot.current = next;
    setOrgLoad(next);
  };

  const launch = (wf: WorkflowItem, args: unknown, budgetTotal: number | null): void => {
    try {
      const source = fs.readFileSync(wf.file, "utf8");
      const { runDir } = prepareRun({ projectDir, scriptSource: source, args, budgetTotal });
      spawnRunner(runDir);
      onAttach(runDir);
    } catch (e) {
      showFlash(`launch failed: ${(e as Error).message}`);
    }
  };

  useInput(
    (input, key) => {
      if (mode.kind === "scheduleRemoveConfirm") {
        if (input === "y") {
          try {
            removeScheduleForTui(projectDir, mode.name);
            showFlash(`removed schedule ${mode.name}`);
          } catch (e) {
            showFlash(`remove failed: ${(e as Error).message}`);
          }
          setMode({ kind: "list" });
          reloadSchedules();
        } else if (input === "n" || key.escape) {
          setMode({ kind: "list" });
        }
        return;
      }
      if (key.tab) {
        setTab((t) => nextHomeTab(t, orgEnabled));
        setSelIdx(0);
        return;
      }
      if (tab === "org" && key.escape) {
        setTab("runs");
        setSelIdx(0);
        return;
      }
      if (input === "q" || key.escape) {
        onQuit();
        return;
      }
      if (tab === "org") return;

      if (key.upArrow) setSelIdx(Math.max(0, sel - 1));
      else if (key.downArrow) setSelIdx(Math.min(Math.max(0, items.length - 1), sel + 1));
      else if (key.return) {
        if (!selected) return;
        if (selected.kind === "run") onAttach(selected.run.runDir);
        else if (selected.kind === "loop")
          setMode({ kind: "loop", runDir: selected.row.run.runDir, loopId: selected.row.loop.id });
        else if (selected.kind === "schedule")
          setMode({ kind: "scheduleDetail", name: selected.row.spec.name });
        else if (selected.wf.error) showFlash(`invalid workflow: ${selected.wf.error}`);
        else setMode({ kind: "launch", wf: selected.wf });
      } else if (input === "n") {
        if (tab !== "runs") return;
        if (selected?.kind === "wf" && !selected.wf.error) setMode({ kind: "launch", wf: selected.wf });
      } else if (input === "S") {
        if (tab !== "runs") return;
        if (selected?.kind === "wf" && !selected.wf.error) setMode({ kind: "scheduleForm", wf: selected.wf });
        else if (selected?.kind === "wf" && selected.wf.error) showFlash(`invalid workflow: ${selected.wf.error}`);
      } else if (input === "r") {
        if (tab !== "runs") return;
        if (selected?.kind === "run" && selected.run.status !== "running") {
          try {
            const { runDir } = rerunFromDir(projectDir, selected.run.runDir);
            onAttach(runDir);
          } catch (e) {
            showFlash(`re-run failed: ${(e as Error).message}`);
          }
        }
      } else if (tab === "schedules" && input === "e") {
        if (selected?.kind !== "schedule") {
          showFlash("select a schedule");
          return;
        }
        const spec = selected.row.spec;
        if (spec.status !== "active") {
          showFlash(`schedule is ${spec.status}`);
          return;
        }
        try {
          execScheduleDetached(spec);
          showFlash(`exec started: ${spec.name}`);
          reloadSchedules(spec.name);
        } catch (e) {
          showFlash(`exec failed: ${(e as Error).message}`);
        }
      } else if (tab === "schedules" && input === "p") {
        if (selected?.kind !== "schedule") {
          showFlash("select a schedule");
          return;
        }
        try {
          const next = toggleSchedulePaused(projectDir, selected.row.spec.name);
          showFlash(next.status === "paused" ? `paused schedule ${next.name}` : `resumed schedule ${next.name}`);
          reloadSchedules(next.name);
        } catch (e) {
          showFlash((e as Error).message);
          reloadSchedules(selected.row.spec.name);
        }
      } else if (tab === "schedules" && input === "x") {
        if (selected?.kind !== "schedule") {
          showFlash("select a schedule");
          return;
        }
        setMode({ kind: "scheduleRemoveConfirm", name: selected.row.spec.name });
      }
    },
    { isActive: mode.kind === "list" || mode.kind === "scheduleRemoveConfirm" },
  );

  const now = Date.now();

  if (mode.kind === "loop") {
    return (
      <LoopView
        runDir={mode.runDir}
        initialLoopId={mode.loopId}
        onBack={() => {
          setTab("loops");
          setMode({ kind: "list" });
        }}
        onQuit={onQuit}
      />
    );
  }

  if (mode.kind === "scheduleDetail") {
    return (
      <ScheduleDetail
        projectDir={projectDir}
        name={mode.name}
        onBack={() => {
          setTab("schedules");
          setMode({ kind: "list" });
          reloadSchedules(mode.name);
        }}
        onChanged={() => reloadSchedules(mode.name)}
        onRemoved={() => {
          setTab("schedules");
          setMode({ kind: "list" });
          showFlash(`removed schedule ${mode.name}`);
          reloadSchedules();
        }}
        onQuit={onQuit}
      />
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold color={col("cyan")}>
        ultracodex
      </Text>
      <Text dimColor>{projectDir}</Text>
      {missedWarnings.slice(0, 2).map((warning) => (
        <Text key={warning} color={col("yellow")} dimColor wrap="truncate-end">
          {warning}
        </Text>
      ))}
      {missedWarnings.length > 2 && (
        <Text color={col("yellow")} dimColor>
          +{missedWarnings.length - 2} more
        </Text>
      )}

      <TabStrip selected={tab} orgEnabled={orgEnabled} />

      {tab === "runs" && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Workflows</Text>
          {workflows.length === 0 && <Text dimColor> none — add .ultracodex/workflows/*.js</Text>}
          {workflows.map((wf, i) => {
            const isSel = mode.kind === "list" && items[sel]?.kind === "wf" && i === sel;
            return (
              <Box key={wf.file} flexDirection="column">
                <Text bold={isSel} wrap="truncate-end">
                  {isSel ? "❯ " : "  "}
                  <Text color={wf.error ? col("red") : col("cyan")}>{wf.name}</Text>
                  {wf.builtin && <Text dimColor> (builtin)</Text>}
                  {wf.error ? <Text color={col("red")}> — invalid meta</Text> : <Text dimColor> — {wf.description}</Text>}
                </Text>
                {isSel && wf.whenToUse && (
                  <Text dimColor wrap="truncate-end">
                    {"    "}when to use: {truncate(wf.whenToUse, 120)}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {tab === "runs" ? (
          <>
            <Text bold>Runs</Text>
            {shownRuns.length === 0 && <Text dimColor> no runs yet</Text>}
            {shownRuns.map((r, i) => {
              const idx = workflows.length + i;
              const isSel = mode.kind === "list" && idx === sel;
              const g = runGlyph(r);
              const elapsed =
                r.startedAt !== null
                  ? fmtDuration((r.endedAt ?? (r.status === "running" ? now : r.startedAt)) - r.startedAt)
                  : "—";
              return (
                <Text key={r.runId} bold={isSel} dimColor={g.dim && !isSel} wrap="truncate-end">
                  {isSel ? "❯ " : "  "}
                  <Text color={g.color}>{g.glyph}</Text> {r.runId} <Text dimColor>{r.name ?? "?"}</Text> · {r.status} ·{" "}
                  {elapsed} · {r.agentsDone}/{r.agentsTotal} agents · {fmtTokens(r.outputTokens)} tok
                </Text>
              );
            })}
          </>
        ) : tab === "loops" ? (
          <>
            <Text bold>Loops</Text>
            {loopRows.length === 0 && <Text dimColor> no loops detected in recent runs — see docs/loops.md</Text>}
            {loopRows.map((row, i) => {
              const idx = i;
              const isSel = mode.kind === "list" && idx === sel;
              const loopColor =
                row.loop.status === "running"
                  ? col("cyan")
                  : row.loop.status === "converged"
                    ? col("green")
                    : row.loop.endedWithRejection
                      ? col("red")
                      : undefined;
              const neutralEnded = row.loop.status === "ended" && !row.loop.endedWithRejection;
              return (
                <Text
                  key={`${row.run.runId}:${row.loop.id}:${row.loopIndex}`}
                  bold={isSel}
                  color={loopColor}
                  dimColor={neutralEnded && !isSel}
                  wrap="truncate-end"
                >
                  {formatLoopListRow({ runId: row.run.runId, loop: row.loop, selected: isSel })}
                  {row.loopCount > 1 && <Text dimColor> · loop {row.loopIndex + 1}/{row.loopCount}</Text>}
                </Text>
              );
            })}
          </>
        ) : tab === "schedules" ? (
          <>
            <Text bold>Schedules</Text>
            {shownSchedules.length === 0 && (
              <Text dimColor> no schedules — ultracodex schedule add &lt;name&gt; --every 30m -- run &lt;wf&gt;</Text>
            )}
            {shownSchedules.map((row, i) => {
              const idx = i;
              const isSel =
                (mode.kind === "list" || mode.kind === "scheduleRemoveConfirm") && idx === sel;
              const confirming = mode.kind === "scheduleRemoveConfirm" && mode.name === row.spec.name;
              return (
                <ScheduleRow
                  key={row.spec.name}
                  row={row}
                  selected={isSel}
                  confirmingRemove={confirming}
                  nowMs={now}
                  spinner={spinnerFrame(Math.floor(now / 250))}
                />
              );
            })}
            {selected?.kind === "schedule" && (
              <ScheduleInlineDetail row={selected.row} />
            )}
          </>
        ) : (
          <OrgView projectDir={projectDir} load={orgLoad} active={mode.kind === "list" && tab === "org"} onChanged={reloadOrg} />
        )}
      </Box>

      {mode.kind === "launch" ? (
        <LaunchForm
          wf={mode.wf}
          onCancel={() => setMode({ kind: "list" })}
          onSubmit={(args, budget) => {
            setMode({ kind: "list" });
            launch(mode.wf, args, budget);
          }}
        />
      ) : mode.kind === "scheduleForm" ? (
        <ScheduleForm
          projectDir={projectDir}
          wf={mode.wf}
          onCancel={() => setMode({ kind: "list" })}
          onCreated={(name, cronExpr) => {
            setMode({ kind: "list" });
            setTab("schedules");
            showFlash(`scheduled ${name} (${cronExpr})`);
            reloadSchedules(name);
          }}
        />
      ) : (
        <Box marginTop={1} flexGrow={1} alignItems="flex-end">
          <Text dimColor wrap="truncate-end">
            {footerText(tab, orgEnabled)}
          </Text>
          {flash && <Text color={col("cyan")}> {flash}</Text>}
        </Box>
      )}
    </Box>
  );
}

function TabStrip({ selected, orgEnabled }: { selected: HomeTab; orgEnabled: boolean }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text inverse={selected === "runs"} dimColor={selected !== "runs"}>
        Runs
      </Text>
      <Text dimColor> | </Text>
      <Text inverse={selected === "loops"} dimColor={selected !== "loops"}>
        Loops
      </Text>
      <Text dimColor> | </Text>
      <Text inverse={selected === "schedules"} dimColor={selected !== "schedules"}>
        Schedules
      </Text>
      {orgEnabled && (
        <>
          <Text dimColor> | </Text>
          <Text inverse={selected === "org"} dimColor={selected !== "org"}>
            Org
          </Text>
        </>
      )}
    </Box>
  );
}

function nextHomeTab(tab: HomeTab, orgEnabled: boolean): HomeTab {
  const tabs: HomeTab[] = orgEnabled ? ["runs", "loops", "schedules", "org"] : ["runs", "loops", "schedules"];
  const index = tabs.indexOf(tab);
  return tabs[(index + 1) % tabs.length] ?? "runs";
}

function footerText(tab: HomeTab, orgEnabled: boolean): string {
  switch (tab) {
    case "runs":
      return "↑↓ select · ↵ attach/launch · tab loops · n new run · S schedule · r re-run · q quit";
    case "loops":
      return "↑↓ select · ↵ open loop · tab schedules · q quit";
    case "schedules":
      return `↑↓ select · ↵ detail · e exec now · p pause/resume · x remove · tab ${orgEnabled ? "org" : "runs"} · q quit`;
    case "org":
      return "j/k/↑↓ move · l/↵ expand · v view · tab runs · q quit";
  }
}

function ScheduleRow({
  row,
  selected,
  confirmingRemove,
  nowMs,
  spinner,
}: {
  row: ScheduleRowItem;
  selected: boolean;
  confirmingRemove: boolean;
  nowMs: number;
  spinner: string;
}): ReactElement {
  const status = scheduleStatusGlyph(row.spec.status);
  const stateCell = row.running ? "running now" : formatScheduleStateCell(row.spec, nowMs, row.overdue);
  const stateColor = row.running ? "cyan" : stateCell === "OVERDUE" ? "yellow" : undefined;
  return (
    <Text key={row.spec.name} bold={selected} dimColor={status.dim && !selected} wrap="truncate-end">
      {selected ? "❯ " : "  "}
      <Text color={status.color === "dim" ? undefined : col(status.color)} dimColor={status.dim}>
        {status.glyph}
      </Text>{" "}
      {row.spec.name} <Text dimColor>{humanScheduleLabel(row.spec)}</Text>   <ScheduleHistory row={row} spinner={spinner} />{" "}
      <Text color={stateColor === undefined ? undefined : col(stateColor)}>{stateCell}</Text>   {row.spec.runs} run
      {row.spec.runs === 1 ? "" : "s"}
      {confirmingRemove && <Text color={col("yellow")}>   remove? y/n</Text>}
    </Text>
  );
}

function ScheduleHistory({ row, spinner }: { row: ScheduleRowItem; spinner: string }): ReactElement {
  const history = row.history.slice(-4);
  if (history.length === 0 && !row.running) return <Text dimColor>—</Text>;
  return (
    <Text>
      {history.map((outcome, i) => {
        const g = execOutcomeGlyph(outcome.ok);
        return (
          <Text key={`${outcome.ts}:${i}`}>
            {i > 0 ? " " : ""}
            <Text color={g.color === "dim" ? undefined : col(g.color)} dimColor={g.dim}>
              {g.glyph}
            </Text>
          </Text>
        );
      })}
      {row.running && (
        <Text>
          {history.length > 0 ? " " : ""}
          <Text color={col("cyan")}>{spinner}</Text>
        </Text>
      )}
    </Text>
  );
}

function ScheduleInlineDetail({ row }: { row: ScheduleRowItem }): ReactElement {
  const lastLog = row.logLines[row.logLines.length - 1];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>  selected: {row.spec.name}</Text>
      <Text wrap="truncate-end">
        {"  "}command {truncate(row.spec.command.join(" "), 140)} · until-done: {row.spec.untilDone ? "yes" : "no"}
        {formatScheduleBudgetSuffix(row.spec)}
      </Text>
      <Text wrap="truncate-end">  {formatScheduleLastRunCell(row.spec.lastRun)}</Text>
      {lastLog !== undefined && (
        <Text dimColor wrap="truncate-end">
          {"  "}LOG {lastLog}
        </Text>
      )}
    </Box>
  );
}

function LaunchForm({
  wf,
  onCancel,
  onSubmit,
}: {
  wf: WorkflowItem;
  onCancel: () => void;
  onSubmit: (args: unknown, budgetTotal: number | null) => void;
}): ReactElement {
  const [field, setField] = useState<0 | 1>(0);
  const [args, setArgs] = useState("");
  const [budget, setBudget] = useState("");
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (field === 0) {
        setField(1);
        return;
      }
      let parsed: unknown = undefined;
      if (args.trim() !== "") {
        try {
          parsed = JSON.parse(args);
        } catch {
          setError("args must be valid JSON (or empty)");
          setField(0);
          return;
        }
      }
      const b = validateBudgetInput(budget);
      if (!b.ok) {
        setError(b.error);
        setField(1);
        return;
      }
      onSubmit(parsed, b.budgetTotal);
      return;
    }
    if (key.tab) {
      setField((f) => (f === 0 ? 1 : 0));
      return;
    }
    if (key.backspace || key.delete) {
      if (field === 0) setArgs((s) => s.slice(0, -1));
      else setBudget((s) => s.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow) {
      setError(null);
      if (field === 0) setArgs((s) => s + input);
      else setBudget((s) => s + input);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={col("cyan")} paddingX={1} marginTop={1}>
      <Text bold color={col("cyan")}>
        launch {wf.name}
      </Text>
      <Text>
        <Text bold={field === 0} color={field === 0 ? col("cyan") : undefined}>
          args (JSON, empty for none):{" "}
        </Text>
        {args}
        {field === 0 && <Text inverse> </Text>}
      </Text>
      <Text>
        <Text bold={field === 1} color={field === 1 ? col("cyan") : undefined}>
          budget (e.g. 500k, empty for none):{" "}
        </Text>
        {budget}
        {field === 1 && <Text inverse> </Text>}
      </Text>
      {error && <Text color={col("red")}>{error}</Text>}
      <Text dimColor>↵ next/launch · tab switch field · esc cancel</Text>
    </Box>
  );
}

function scheduleFieldIndex(field: keyof ScheduleFormDraft): number {
  switch (field) {
    case "name":
      return 0;
    case "cadence":
      return 1;
    case "value":
      return 2;
    case "untilDone":
      return 3;
    case "maxRuns":
      return 4;
    case "budget":
      return 5;
    case "argsJson":
      return 6;
  }
}

function fieldName(field: number): keyof ScheduleFormDraft {
  return ["name", "cadence", "value", "untilDone", "maxRuns", "budget", "argsJson"][field] as keyof ScheduleFormDraft;
}

function ScheduleForm({
  projectDir,
  wf,
  onCancel,
  onCreated,
}: {
  projectDir: string;
  wf: WorkflowItem;
  onCancel: () => void;
  onCreated: (name: string, cronExpr: string) => void;
}): ReactElement {
  const [field, setField] = useState(0);
  const [draft, setDraft] = useState<ScheduleFormDraft>(() => ({
    name: slugify(wf.name),
    cadence: "every",
    value: "30m",
    untilDone: false,
    maxRuns: "",
    budget: "",
    argsJson: "",
  }));
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const validated = validateScheduleFormDraft(draft);
    if (!validated.ok) {
      setError(validated.error);
      setField(scheduleFieldIndex(validated.field));
      return;
    }
    const command = ["run", wf.file];
    if (validated.argsJson !== undefined) command.push("--args", validated.argsJson);
    try {
      const { spec } = addSchedule({
        projectDir,
        name: validated.name,
        command,
        every: validated.every,
        daily: validated.daily,
        untilDone: validated.untilDone,
        maxRuns: validated.maxRuns,
        budget: validated.budget,
        pathEnv: process.env.PATH ?? "",
      });
      onCreated(spec.name, spec.cronExpr);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setTextField = (key: "name" | "value" | "maxRuns" | "budget" | "argsJson", value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (field < 6) setField((f) => f + 1);
      else submit();
      return;
    }
    if (key.tab) {
      setField((f) => (f + 1) % 7);
      return;
    }
    if (key.upArrow) {
      setField((f) => Math.max(0, f - 1));
      return;
    }
    if (key.downArrow) {
      setField((f) => Math.min(6, f + 1));
      return;
    }

    const active = fieldName(field);
    if (active === "cadence") {
      if (key.leftArrow || key.rightArrow || input === " ") {
        setDraft((d) => ({
          ...d,
          cadence: d.cadence === "every" ? "daily" : "every",
          value: d.cadence === "every" ? "18:30" : "30m",
        }));
        setError(null);
      }
      return;
    }
    if (active === "untilDone") {
      if (input === "y" || input === "Y") setDraft((d) => ({ ...d, untilDone: true }));
      else if (input === "n" || input === "N") setDraft((d) => ({ ...d, untilDone: false }));
      else if (key.leftArrow || key.rightArrow || input === " ") {
        setDraft((d) => ({ ...d, untilDone: !d.untilDone }));
      }
      setError(null);
      return;
    }
    if (key.backspace || key.delete) {
      setTextField(active, draft[active].slice(0, -1));
      setError(null);
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.leftArrow && !key.rightArrow) {
      setTextField(active, draft[active] + input);
      setError(null);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={col("cyan")} paddingX={1} marginTop={1}>
      <Text bold color={col("cyan")}>
        schedule workflow: {wf.name}
      </Text>
      <ScheduleFormTextLine label="name" active={field === 0} value={draft.name} placeholder="" />
      <Text>
        <Text bold={field === 1} color={field === 1 ? col("cyan") : undefined}>
          cadence     {" "}
        </Text>
        <Text color={draft.cadence === "every" ? col("cyan") : undefined}>{draft.cadence === "every" ? "●" : "○"}</Text>{" "}
        every   <Text color={draft.cadence === "daily" ? col("cyan") : undefined}>{draft.cadence === "daily" ? "●" : "○"}</Text>{" "}
        daily
      </Text>
      <ScheduleFormTextLine label="value" active={field === 2} value={draft.value} placeholder="" />
      <Text>
        <Text bold={field === 3} color={field === 3 ? col("cyan") : undefined}>
          until-done  {" "}
        </Text>
        {draft.untilDone ? "yes" : "no"}
      </Text>
      <ScheduleFormTextLine label="max-runs" active={field === 4} value={draft.maxRuns} placeholder="(none)" />
      <ScheduleFormTextLine label="budget" active={field === 5} value={draft.budget} placeholder="(none)" />
      <ScheduleFormTextLine label="args" active={field === 6} value={draft.argsJson} placeholder="(none)" />
      {error && <Text color={col("red")}>{error}</Text>}
      <Text dimColor>↵ next/create · tab switch field · esc cancel</Text>
    </Box>
  );
}

function ScheduleFormTextLine({
  label,
  active,
  value,
  placeholder,
}: {
  label: string;
  active: boolean;
  value: string;
  placeholder: string;
}): ReactElement {
  const shown = value === "" ? placeholder : value;
  return (
    <Text>
      <Text bold={active} color={active ? col("cyan") : undefined}>
        {label.padEnd(12)}
      </Text>
      {value === "" && placeholder !== "" ? <Text dimColor>{shown}</Text> : shown}
      {active && <Text inverse> </Text>}
    </Text>
  );
}
