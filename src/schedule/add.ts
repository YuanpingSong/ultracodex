import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveScript } from "../workflows.js";
import { parseBudget } from "../budget.js";
import { CliError } from "../cli-error.js";
import { installScheduleCrontabLine, validateCrontabPaths } from "./crontab.js";
import {
  maybeReadScheduleSpec,
  newScheduleSpec,
  parseCron,
  parseDaily,
  parseEvery,
  removeScheduleSpec,
  scheduleSpecPath,
  validateScheduleName,
  writeScheduleSpec,
  type ParsedSchedule,
  type ScheduleSpec,
} from "./spec.js";

export interface ScheduleAddOpts {
  every?: string;
  daily?: string;
  cron?: string;
  untilDone?: boolean;
  maxRuns?: string;
  budget?: string;
}

export interface AddScheduleInput extends ScheduleAddOpts {
  name: string;
  command: string[];
  projectDir: string;
  nodeBin?: string;
  cliPath?: string;
  pathEnv?: string;
  now?: Date;
}

export interface AddScheduleResult {
  spec: ScheduleSpec;
}

export const NO_SCHEDULE_BUDGET_WARNING = (name: string): string =>
  `warning: no token budget on scheduled run '${name}' — an unattended loop without --budget can exhaust your quota; add --budget (e.g. --budget 200k)`;

export function selectedSchedule(opts: Pick<ScheduleAddOpts, "every" | "daily" | "cron">): ParsedSchedule {
  const selected = [opts.every, opts.daily, opts.cron].filter((v) => v !== undefined).length;
  if (selected !== 1) {
    throw new Error("choose exactly one of --every, --daily, or --cron");
  }
  if (opts.every !== undefined) return parseEvery(opts.every);
  if (opts.daily !== undefined) return parseDaily(opts.daily);
  return parseCron(opts.cron!);
}

export function parseMaxRuns(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--max-runs must be a positive integer (got "${value}")`);
  }
  return n;
}

export function normalizeScheduleCommand(
  projectDir: string,
  argv: string[],
  untilDone: boolean,
): string[] {
  if (argv.length === 0) throw new Error("schedule command is required after --");
  if (untilDone && argv[0] !== "run") {
    throw new Error("--until-done requires a scheduled `run` command");
  }
  if (argv[0] !== "run") return argv;
  const ref = argv[1];
  if (!ref) throw new Error("scheduled `run` command requires a script or workflow name");
  return ["run", resolveScript(projectDir, ref), ...argv.slice(2)];
}

function defaultCliPath(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = path.extname(here) || ".js";
  const candidate = path.resolve(path.dirname(here), `../cli${ext}`);
  return fs.existsSync(candidate) ? candidate : path.resolve(path.dirname(here), "../cli.js");
}

export function addSchedule(input: AddScheduleInput): AddScheduleResult {
  const projectDir = input.projectDir;
  validateScheduleName(input.name);
  if (
    maybeReadScheduleSpec(projectDir, input.name) !== null ||
    fs.existsSync(scheduleSpecPath(projectDir, input.name))
  ) {
    throw new Error(`schedule "${input.name}" already exists`);
  }
  const parsed = selectedSchedule(input);
  const untilDone = !!input.untilDone;
  const normalizedCommand = normalizeScheduleCommand(projectDir, input.command ?? [], untilDone);
  if (input.budget !== undefined) {
    if (normalizedCommand[0] !== "run") {
      throw new CliError("--budget requires a scheduled `run` command");
    }
    parseBudget(input.budget);
  }
  const spec = newScheduleSpec({
    name: input.name,
    schedule: parsed.schedule,
    cronExpr: parsed.cronExpr,
    command: normalizedCommand,
    projectDir,
    untilDone,
    maxRuns: parseMaxRuns(input.maxRuns),
    budget: input.budget ?? null,
    nodeBin: input.nodeBin ?? process.execPath,
    cliPath: input.cliPath ?? defaultCliPath(),
    pathEnv: input.pathEnv ?? process.env.PATH ?? "",
    now: input.now,
  });
  validateCrontabPaths(spec);
  writeScheduleSpec(spec);
  try {
    installScheduleCrontabLine(spec);
  } catch (err) {
    removeScheduleSpec(projectDir, input.name);
    throw err;
  }
  if (
    normalizedCommand[0] === "run" &&
    input.budget === undefined &&
    !normalizedCommand.includes("--budget")
  ) {
    process.stderr.write(NO_SCHEDULE_BUDGET_WARNING(input.name) + "\n");
  }
  return { spec };
}
