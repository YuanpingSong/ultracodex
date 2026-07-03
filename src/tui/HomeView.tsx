import fs from "node:fs";
import path from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { WORKFLOWS_DIR_NAME } from "../constants.js";
import { parseMeta } from "../loader.js";
import { listRuns, stateDir } from "../rundir.js";
import type { RunSummary } from "../types.js";
import { col } from "./colors.js";
import { fmtDuration, fmtTokens, parseBudget, truncate } from "./format.js";
import { useFlash, useTick } from "./hooks.js";
import { prepareRun, rerunFromDir, spawnRunner } from "./spawn.js";

const RUNS_SHOWN = 12;

interface WorkflowItem {
  file: string;
  name: string;
  description: string;
  whenToUse?: string;
  error?: string;
}

type Item = { kind: "wf"; wf: WorkflowItem } | { kind: "run"; run: RunSummary };

type Mode = { kind: "list" } | { kind: "launch"; wf: WorkflowItem };

function loadWorkflows(projectDir: string): WorkflowItem[] {
  const dir = path.join(stateDir(projectDir), WORKFLOWS_DIR_NAME);
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
      return item;
    } catch (e) {
      return { file, name: f.replace(/\.js$/, ""), description: "", error: (e as Error).message };
    }
  });
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
  const [selIdx, setSelIdx] = useState(0);
  const [flash, showFlash] = useFlash(3000);

  const shownRuns = runs.slice(0, RUNS_SHOWN);
  const items: Item[] = [
    ...workflows.map((wf): Item => ({ kind: "wf", wf })),
    ...shownRuns.map((run): Item => ({ kind: "run", run })),
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
      else if (key.return) {
        if (!selected) return;
        if (selected.kind === "run") onAttach(selected.run.runDir);
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

      <Box flexDirection="column" marginTop={1}>
        <Text bold>Runs</Text>
        {shownRuns.length === 0 && <Text dimColor> no runs yet</Text>}
        {shownRuns.map((r, i) => {
          const idx = workflows.length + i;
          const isSel = mode.kind === "list" && idx === sel;
          const g = runGlyph(r);
          const elapsed =
            r.startedAt !== null ? fmtDuration((r.endedAt ?? (r.status === "running" ? now : r.startedAt)) - r.startedAt) : "—";
          return (
            <Text key={r.runId} bold={isSel} dimColor={g.dim && !isSel} wrap="truncate-end">
              {isSel ? "❯ " : "  "}
              <Text color={g.color}>{g.glyph}</Text> {r.runId} <Text dimColor>{r.name ?? "?"}</Text> · {r.status} ·{" "}
              {elapsed} · {r.agentsDone}/{r.agentsTotal} agents · {fmtTokens(r.outputTokens)} tok
            </Text>
          );
        })}
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
            ↑↓ select · ↵ attach/launch · n new run · r re-run · q quit
          </Text>
          {flash && <Text color={col("cyan")}> {flash}</Text>}
        </Box>
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
