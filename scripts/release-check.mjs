// Live pre-release gate: runs the demo-video haiku actor-critic workflow
// through the REAL built CLI against REAL codex, asserts the run's
// intermediate state (journal, per-agent outputs) — not just the final
// JSON — and archives the whole run under .release-checks/ as release
// provenance. Requires an authenticated codex CLI; deliberately NOT in CI.
//
//   pnpm release:check            # defaults (gpt-5.5 · xhigh — the shipping path)
//   RELEASE_CHECK_FAST=1 ...      # spark · medium (quick smoke while iterating)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli.js");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "haiku-actor-critic.js");
const TIMEOUT_MS = 12 * 60 * 1000;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "✔" : "✖"} ${what}`);
  if (!ok) failures.push(what);
};

// -- scratch project ---------------------------------------------------------
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "uc-release-check-"));
if (process.env.RELEASE_CHECK_FAST) {
  fs.mkdirSync(path.join(proj, ".ultracodex"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".ultracodex", "config.toml"),
    '[backends.codex]\ndefault_model = "gpt-5.3-codex-spark"\ndefault_effort = "medium"\n',
  );
  console.log("ℹ RELEASE_CHECK_FAST: spark · medium (not the shipping defaults)");
}

// -- run the workflow ---------------------------------------------------------
console.log(`ℹ running haiku actor-critic live (budget 100k, timeout ${TIMEOUT_MS / 60000}m)…`);
const t0 = Date.now();
const run = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [CLI, "run", FIXTURE, "--json", "--budget", "100k"],
    { cwd: proj, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const watchdog = setTimeout(() => {
    child.kill("SIGKILL");
    resolve({ code: -1, out, err: err + "\n[release-check watchdog timeout]" });
  }, TIMEOUT_MS);
  child.on("close", (code) => {
    clearTimeout(watchdog);
    resolve({ code, out, err });
  });
});
const wallMs = Date.now() - t0;

check(run.code === 0, `run --json exited 0 (got ${run.code}) in ${Math.round(wallMs / 1000)}s`);

// -- final state --------------------------------------------------------------
let result = null;
try {
  result = JSON.parse(run.out);
} catch {
  check(false, `stdout parses as JSON (got: ${run.out.slice(0, 200)}… stderr: ${run.err.slice(0, 200)})`);
}
if (result) {
  check(typeof result.finalHaiku === "string" && result.finalHaiku.trim().split("\n").length >= 3,
    "finalHaiku present (3 lines)");
  check(Array.isArray(result.rounds) && result.rounds.length >= 1 && result.rounds.length <= 3,
    `rounds recorded (${result?.rounds?.length})`);
  for (const r of result?.rounds ?? []) {
    check(typeof r.pass === "boolean" && Array.isArray(r.issues), `round ${r.round}: schema'd critique`);
  }
}

// -- intermediate state (the journal is the spine — assert it) ----------------
const runsDir = path.join(proj, ".ultracodex", "runs");
const runId = fs.readdirSync(runsDir)[0];
const runDir = path.join(runsDir, runId);
const journal = fs.readFileSync(path.join(runDir, "journal.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const starts = journal.filter((e) => e.t === "agent_start");
const ends = journal.filter((e) => e.t === "agent_end");
const phases = journal.filter((e) => e.t === "phase").map((e) => e.title);
const runEnd = journal.find((e) => e.t === "run_end");

check(starts.length >= 2 && starts.length <= 6, `agent_start count sane (${starts.length})`);
check(starts.every((e) => typeof e.model === "string" && e.model.length > 0),
  `every agent_start records a resolved model (${[...new Set(starts.map((e) => e.model))].join(", ")})`);
check(ends.length === starts.length && ends.every((e) => e.status === "ok"),
  `every agent ended ok (${ends.length}/${starts.length})`);
check(ends.every((e) => e.usage.outputTokens > 0), "every agent metered real output tokens");
check(phases.includes("Round 1"), `phases journaled (${phases.join(" · ")})`);
check(runEnd?.status === "ok" && runEnd?.totals?.usage?.codex?.outputTokens > 0,
  `run_end ok with codex ledger (${runEnd?.totals?.usage?.codex?.outputTokens} out tok)`);

// per-agent output artifacts exist and critic outputs are valid JSON
const agentDirs = fs.readdirSync(path.join(runDir, "agents"));
check(agentDirs.length === starts.length, `per-agent dirs exist (${agentDirs.length})`);
for (const d of agentDirs) {
  const files = fs.readdirSync(path.join(runDir, "agents", d));
  const hasOutput = files.some((f) => f === "output.txt" || f === "output.json");
  check(hasOutput && files.includes("prompt.md"), `agents/${d}: prompt.md + output artifact`);
  if (d.includes("critic") && files.includes("output.json")) {
    const o = JSON.parse(fs.readFileSync(path.join(runDir, "agents", d, "output.json"), "utf8"));
    check(typeof o.pass === "boolean", `agents/${d}: output.json matches critique schema`);
  }
}

// -- archive as release provenance ---------------------------------------------
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const archive = path.join(ROOT, ".release-checks", `v${version}-${runId}`);
fs.mkdirSync(archive, { recursive: true });
fs.cpSync(runDir, archive, { recursive: true });
console.log(`ℹ run archived: ${path.relative(ROOT, archive)}`);

// -- human-readable round summary (the demo, replayed) -------------------------
if (result?.rounds) {
  for (const r of result.rounds) {
    console.log(`\n— round ${r.round} (${r.pass ? "PASS" : r.issues.join("; ")}) —\n${r.haiku}`);
  }
}

fs.rmSync(proj, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n✖ RELEASE CHECK FAILED (${failures.length}): do not ship.`);
  process.exit(1);
}
console.log(`\n✔ release check passed — ${starts.length} live agents, ${Math.round(wallMs / 1000)}s, v${version} ready.`);
