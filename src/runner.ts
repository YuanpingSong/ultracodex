import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  INTERRUPT_GRACE_MS,
  OPTIONS_SNAPSHOT,
  PID_FILE,
  RESULT_FILE,
  SCRIPT_SNAPSHOT,
  WORKFLOWS_DIR_NAME,
} from "./constants.js";
import { loadConfig } from "./config.js";
import { loadScript } from "./loader.js";
import { JournalWriter } from "./journal.js";
import { stateDir, writePidFile } from "./rundir.js";
import { tailControl } from "./control.js";
import { createRuntime } from "./runtime.js";
import { createExecutors } from "./executor/router.js";
import { sha256Hex } from "./ids.js";
import type { RunOptions, RunStatus, WorkflowGlobals, WorkflowMeta } from "./types.js";

type Outcome =
  | { kind: "ok"; value: unknown }
  | { kind: "failed"; error: string }
  | { kind: "stopped" };

export async function runnerMain(runDir: string): Promise<void> {
  let options: RunOptions;
  let source: string;
  let script: ReturnType<typeof loadScript>;
  try {
    options = JSON.parse(
      fs.readFileSync(path.join(runDir, OPTIONS_SNAPSHOT), "utf8"),
    ) as RunOptions;
    options.runDir = runDir;
    source = fs.readFileSync(path.join(runDir, SCRIPT_SNAPSHOT), "utf8");
    script = loadScript(source, { strict: options.strict });
  } catch (err) {
    // Startup failure: journal a run_end so consumers see "failed", not "dead".
    try {
      const journal = new JournalWriter(runDir);
      journal.append({
        t: "run_end",
        ts: Date.now(),
        status: "failed",
        resultRef: null,
        error: errMsg(err),
        totals: { agents: 0, ok: 0, failed: 0, skipped: 0, usage: {}, ms: 0 },
      });
      journal.close();
    } catch {
      // nothing left to report to
    }
    return;
  }

  const config = loadConfig(options.projectDir);
  const executors = createExecutors(config);
  const journal = new JournalWriter(runDir);
  journal.append({
    t: "run_start",
    ts: Date.now(),
    runId: options.runId,
    meta: script.meta,
    scriptSha: sha256Hex(source),
    argsRef: options.argsPath,
    budgetTotal: options.budgetTotal,
    concurrency: options.concurrency,
  });
  writePidFile(runDir, process.pid);

  const runtime = createRuntime({
    journal,
    executors,
    config,
    options,
    meta: script.meta,
    loadChildWorkflow: (ref) => loadChildWorkflow(options, ref),
  });
  const { controller } = runtime;

  let settleExternal: (o: Outcome) => void = () => {};
  const external = new Promise<Outcome>((resolve) => {
    settleExternal = resolve;
  });
  const requestStop = (): void => {
    controller.stop();
    settleExternal({ kind: "stopped" });
  };

  // Runtime already exists, so pre-written commands replayed at attach dispatch safely.
  const stopTail = tailControl(runDir, (cmd) => {
    switch (cmd.cmd) {
      case "stop":
        requestStop();
        break;
      case "pause":
        controller.pause(); // controller journals the paused ack
        break;
      case "resume":
        controller.resume(); // controller journals the resumed ack
        break;
      case "skip":
        controller.skip(cmd.n);
        break;
    }
  });

  const onSignal = (): void => requestStop();
  const onUncaught = (err: unknown): void => {
    controller.stop();
    settleExternal({ kind: "failed", error: errMsg(err) });
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);

  const bodySettled: Promise<Outcome> = script.body(runtime.globals).then(
    (value): Outcome => ({ kind: "ok", value }),
    (err): Outcome => ({ kind: "failed", error: errMsg(err) }),
  );

  let outcome = await Promise.race([bodySettled, external]);
  if (outcome.kind === "stopped") {
    // Let aborted agents journal their agent_end before we seal the journal.
    await Promise.race([bodySettled, sleep(INTERRUPT_GRACE_MS)]);
  } else if (outcome.kind === "ok" && controller.stopped) {
    outcome = { kind: "stopped" };
  }

  stopTail();
  process.off("SIGTERM", onSignal);
  process.off("SIGINT", onSignal);
  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onUncaught);

  let status: RunStatus;
  let resultRef: string | null = null;
  let error: string | null = null;
  if (outcome.kind === "ok") {
    try {
      const value = outcome.value === undefined ? null : outcome.value;
      fs.writeFileSync(
        path.join(runDir, RESULT_FILE),
        JSON.stringify(value, null, 2) + "\n",
        "utf8",
      );
      status = "ok";
      resultRef = RESULT_FILE;
    } catch (err) {
      status = "failed";
      error = `failed to serialize workflow result: ${errMsg(err)}`;
    }
  } else if (outcome.kind === "failed") {
    status = "failed";
    error = outcome.error;
  } else {
    status = "stopped";
  }

  journal.append({
    t: "run_end",
    ts: Date.now(),
    status,
    resultRef,
    error,
    totals: controller.totals(),
  });
  journal.close();
  try {
    fs.rmSync(path.join(runDir, PID_FILE), { force: true });
  } catch {
    // pid file is advisory
  }
}

function loadChildWorkflow(
  options: RunOptions,
  ref: string | { scriptPath: string },
): { meta: WorkflowMeta; body: (g: WorkflowGlobals) => Promise<unknown> } {
  let source: string;
  let expectName: string | null = null;
  if (typeof ref === "string") {
    expectName = ref;
    const p = path.join(stateDir(options.projectDir), WORKFLOWS_DIR_NAME, `${ref}.js`);
    try {
      source = fs.readFileSync(p, "utf8");
    } catch {
      throw new Error(`unknown workflow "${ref}" (expected ${p})`);
    }
  } else {
    try {
      source = fs.readFileSync(ref.scriptPath, "utf8");
    } catch (err) {
      throw new Error(`unreadable workflow script "${ref.scriptPath}": ${errMsg(err)}`);
    }
  }
  const loaded = loadScript(source, { strict: options.strict });
  if (expectName !== null && loaded.meta.name !== expectName) {
    throw new Error(
      `workflow "${expectName}": meta.name is "${loaded.meta.name}" (must match the filename)`,
    );
  }
  return { meta: loaded.meta, body: loaded.body };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  // vm-context errors are cross-realm: not instanceof the host Error.
  if (err !== null && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    if (import.meta.url === pathToFileURL(entry).href) return true;
  } catch {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const runDir = process.argv[2];
  if (!runDir) {
    process.stderr.write("usage: runner.js <runDir>\n");
    process.exit(2);
  } else {
    runnerMain(path.resolve(runDir)).then(
      () => process.exit(0), // status lives in the journal, not the exit code
      (err) => {
        process.stderr.write(
          `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
        );
        process.exit(0);
      },
    );
  }
}
