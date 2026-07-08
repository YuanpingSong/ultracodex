import fs from "node:fs";
import path from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { JOURNAL_FILE, WORKFLOWS_DIR_NAME } from "../constants.js";
import { readJournal } from "../journal.js";
import { parseMeta } from "../loader.js";
import { listRuns, stateDir } from "../rundir.js";
import { packageRootDir } from "../skills.js";
import type { RunSummary } from "../types.js";
import { col } from "./colors.js";
import { fmtDuration, fmtTokens, parseBudget, truncate } from "./format.js";
import { useFlash, useTick } from "./hooks.js";
import { LoopView } from "./LoopView.js";
import { detectLoops, formatLoopListRow, type LoopInstance } from "./loops.js";
import { makeAgentOutputReader } from "./loopFiles.js";
import { initialState, reduce, type TuiState } from "./reducer.js";
import { prepareRun, rerunFromDir, spawnRunner } from "./spawn.js";

const RUNS_SHOWN = 12;
const LOOPS_SHOWN = 12;

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

type HomeTab = "runs" | "loops";

type Item =
  | { kind: "wf"; wf: WorkflowItem }
  | { kind: "run"; run: RunSummary }
  | { kind: "loop"; row: LoopRowItem };

type Mode = { kind: "list" } | { kind: "launch"; wf: WorkflowItem } | { kind: "loop"; runDir: string; loopId: string };

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
      loops = detectLoops(foldRun(run.runDir), makeAgentOutputReader(run.runDir));
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
  const [runs, setRuns] = useState<RunSummary[]>(() => listRuns(projectDir));
  const tick = useTick(2000, true);
  useEffect(() => {
    setRuns(listRuns(projectDir));
  }, [projectDir, tick]);

  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [tab, setTab] = useState<HomeTab>("runs");
  const [selIdx, setSelIdx] = useState(0);
  const [loopRows, setLoopRows] = useState<LoopRowItem[]>([]);
  const loopCache = useRef(new Map<string, { mtimeMs: number; loops: LoopInstance[] }>());
  const [flash, showFlash] = useFlash(3000);

  const shownRuns = useMemo(() => runs.slice(0, RUNS_SHOWN), [runs]);
  useEffect(() => {
    if (tab !== "loops") return;
    setLoopRows(loadLoopRows(shownRuns, loopCache.current));
  }, [shownRuns, tab]);

  const items: Item[] = [
    ...workflows.map((wf): Item => ({ kind: "wf", wf })),
    ...(tab === "runs"
      ? shownRuns.map((run): Item => ({ kind: "run", run }))
      : loopRows.map((row): Item => ({ kind: "loop", row }))),
  ];
  const sel = Math.min(selIdx, Math.max(0, items.length - 1));
  const selected = items[sel];

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
      if (key.upArrow) setSelIdx(Math.max(0, sel - 1));
      else if (key.downArrow) setSelIdx(Math.min(Math.max(0, items.length - 1), sel + 1));
      else if (key.tab) {
        setTab((t) => (t === "runs" ? "loops" : "runs"));
        setSelIdx(Math.min(sel, workflows.length));
      } else if (key.return) {
        if (!selected) return;
        if (selected.kind === "run") onAttach(selected.run.runDir);
        else if (selected.kind === "loop")
          setMode({ kind: "loop", runDir: selected.row.run.runDir, loopId: selected.row.loop.id });
        else if (selected.wf.error) showFlash(`invalid workflow: ${selected.wf.error}`);
        else setMode({ kind: "launch", wf: selected.wf });
      } else if (input === "n") {
        if (selected?.kind === "wf" && !selected.wf.error) setMode({ kind: "launch", wf: selected.wf });
      } else if (input === "r") {
        if (selected?.kind === "run" && selected.run.status !== "running") {
          try {
            const { runDir } = rerunFromDir(projectDir, selected.run.runDir);
            onAttach(runDir);
          } catch (e) {
            showFlash(`re-run failed: ${(e as Error).message}`);
          }
        }
      } else if (input === "q" || key.escape) onQuit();
    },
    { isActive: mode.kind === "list" },
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

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold color={col("cyan")}>
        ultracodex
      </Text>
      <Text dimColor>{projectDir}</Text>

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

      <TabStrip selected={tab} />

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
        ) : (
          <>
            <Text bold>Loops</Text>
            {loopRows.length === 0 && <Text dimColor> no loops detected in recent runs — see docs/loops.md</Text>}
            {loopRows.map((row, i) => {
              const idx = workflows.length + i;
              const isSel = mode.kind === "list" && idx === sel;
              return (
                <Text key={`${row.run.runId}:${row.loop.id}:${row.loopIndex}`} bold={isSel} wrap="truncate-end">
                  {formatLoopListRow({ runId: row.run.runId, loop: row.loop, selected: isSel })}
                  {row.loopCount > 1 && <Text dimColor> · loop {row.loopIndex + 1}/{row.loopCount}</Text>}
                </Text>
              );
            })}
          </>
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
      ) : (
        <Box marginTop={1} flexGrow={1} alignItems="flex-end">
          <Text dimColor wrap="truncate-end">
            ↑↓ select · ↵ attach/launch{tab === "loops" ? "/open loop" : ""} · tab{" "}
            {tab === "runs" ? "loops" : "runs"} · n new run · r re-run · q quit
          </Text>
          {flash && <Text color={col("cyan")}> {flash}</Text>}
        </Box>
      )}
    </Box>
  );
}

function TabStrip({ selected }: { selected: HomeTab }): ReactElement {
  return (
    <Box marginTop={1}>
      <Text inverse={selected === "runs"} dimColor={selected !== "runs"}>
        Runs
      </Text>
      <Text dimColor> ── </Text>
      <Text inverse={selected === "loops"} dimColor={selected !== "loops"}>
        Loops
      </Text>
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
