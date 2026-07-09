import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WORKFLOWS_DIR_NAME } from "../constants.js";
import { stateDir } from "../rundir.js";
import { packageRootDir } from "../skills.js";
import { dateOnly, normalizeAgentPath, todayIso } from "./common.js";
import { deliver, type RoutedMessage, type RouterOptions } from "./router.js";

const execFileDefault = promisify(execFileCallback);
const MAX_BUFFER = 64 * 1024 * 1024;
const VERDICTS = new Set(["verified", "unsupported", "contradicted", "uncheckable"]);

type ExecFile = (
  command: string,
  args: string[],
  options: { cwd: string; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

type DeliverMessage = (message: RoutedMessage, options?: RouterOptions) => Promise<Record<string, unknown>>;

export interface OrgAuditOptions {
  root?: string;
  sample?: number | string;
  date?: string;
}

export interface OrgAuditDeps {
  execFile?: ExecFile;
  deliverMessage?: DeliverMessage;
  env?: NodeJS.ProcessEnv;
}

export interface OrgAuditFinding {
  agent: string;
  file: string;
  line: number | null;
  claim: string;
  verdict: "verified" | "unsupported" | "contradicted" | "uncheckable";
  note: string;
}

export interface OrgAuditTally {
  verified: number;
  unsupported: number;
  contradicted: number;
  uncheckable: number;
}

export interface OrgAuditSummary {
  date: string;
  accuracy: number;
  tally: OrgAuditTally;
  sampled: number;
  findings: OrgAuditFinding[];
  done: boolean;
  historyAppended: boolean;
  notifications: number;
}

export async function runOrgAudit(options: OrgAuditOptions = {}, deps: OrgAuditDeps = {}): Promise<OrgAuditSummary> {
  const root = path.resolve(options.root ?? process.cwd());
  const sample = normalizeSample(options.sample ?? 25);
  const date = dateOnly(options.date ?? todayIso());
  const rawResult = await invokeOrgAuditWorkflow(root, sample, deps);
  const result = normalizeAuditResult(rawResult);
  const historyAppended = await appendAuditHistory(root, {
    date,
    accuracy: result.accuracy,
    tally: result.tally,
    sampled: result.sampled,
  });
  const notifications = await deliverFindings(root, date, result.findings, deps.deliverMessage ?? deliver);

  return {
    date,
    accuracy: result.accuracy,
    tally: result.tally,
    sampled: result.sampled,
    findings: result.findings,
    done: result.done,
    historyAppended,
    notifications,
  };
}

async function invokeOrgAuditWorkflow(root: string, sample: number, deps: OrgAuditDeps): Promise<unknown> {
  const env = deps.env ?? process.env;
  const command = env.ULTRACODEX_BIN ?? process.execPath;
  const prefix = env.ULTRACODEX_BIN ? [] : [cliEntryPath()];
  const execFile = deps.execFile ?? execFileDefault as ExecFile;
  const run = await execFile(
    command,
    [...prefix, "run", orgAuditWorkflowPath(), "--args", JSON.stringify({ sample }), "--json"],
    { cwd: root, maxBuffer: MAX_BUFFER },
  );
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    throw new Error(`org-audit returned malformed JSON: ${(err as Error).message}`);
  }
}

function orgAuditWorkflowPath(): string {
  return path.join(packageRootDir(), WORKFLOWS_DIR_NAME, "org-audit.js");
}

function cliEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.js");
}

function normalizeSample(value: number | string): number {
  const sample = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(sample) || sample < 1) {
    throw new Error(`--sample must be a positive integer (got "${value}")`);
  }
  return sample;
}

function normalizeAuditResult(value: unknown): Omit<OrgAuditSummary, "date" | "historyAppended" | "notifications"> {
  const row = isRecord(value) ? value : {};
  const findings = normalizeFindings(row.findings);
  const tally = normalizeTally(row.tally, findings);
  const sampled = normalizeSampled(row.sampled, findings.length);
  const accuracy = accuracyFromTally(tally);
  return {
    accuracy,
    tally,
    sampled,
    findings,
    done: accuracy >= 0.99,
  };
}

function normalizeFindings(value: unknown): OrgAuditFinding[] {
  if (!Array.isArray(value)) return [];
  return value.map((finding): OrgAuditFinding => {
    const row = isRecord(finding) ? finding : {};
    return {
      agent: normalizeFindingAgent(row.agent),
      file: typeof row.file === "string" && row.file.trim() ? row.file.trim().replace(/\\/g, "/") : ".",
      line: Number.isInteger(row.line) ? Number(row.line) : null,
      claim: typeof row.claim === "string" ? row.claim.trim() : "",
      verdict: normalizeVerdict(row.verdict),
      note: typeof row.note === "string" && row.note.trim() ? row.note.trim() : "no note",
    };
  });
}

function normalizeFindingAgent(value: unknown): string {
  try {
    return normalizeAgentPath(value ?? ".");
  } catch {
    return ".";
  }
}

function normalizeVerdict(value: unknown): OrgAuditFinding["verdict"] {
  const text = String(value ?? "").toLowerCase();
  return VERDICTS.has(text) ? text as OrgAuditFinding["verdict"] : "uncheckable";
}

function normalizeTally(value: unknown, findings: OrgAuditFinding[]): OrgAuditTally {
  if (isRecord(value)) {
    return {
      verified: nonNegativeInt(value.verified),
      unsupported: nonNegativeInt(value.unsupported),
      contradicted: nonNegativeInt(value.contradicted),
      uncheckable: nonNegativeInt(value.uncheckable),
    };
  }
  const tally: OrgAuditTally = { verified: 0, unsupported: 0, contradicted: 0, uncheckable: 0 };
  for (const finding of findings) tally[finding.verdict] += 1;
  return tally;
}

function nonNegativeInt(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function normalizeSampled(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function accuracyFromTally(tally: OrgAuditTally): number {
  const checkable = tally.verified + tally.unsupported + tally.contradicted;
  return checkable > 0 ? round4(tally.verified / checkable) : 0;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

async function appendAuditHistory(
  root: string,
  row: { date: string; accuracy: number; tally: OrgAuditTally; sampled: number },
): Promise<boolean> {
  const file = path.join(stateDir(root), "org", "state", "audit-history.jsonl");
  const existing = await readTextIfExists(file);
  if (existing !== null) {
    for (const line of existing.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) continue;
        if (
          parsed.date === row.date &&
          Number(parsed.sampled) === row.sampled &&
          Number(parsed.accuracy) === row.accuracy
        ) {
          return false;
        }
      } catch {
        continue;
      }
    }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
  return true;
}

async function deliverFindings(
  root: string,
  date: string,
  findings: OrgAuditFinding[],
  deliverMessage: DeliverMessage,
): Promise<number> {
  let count = 0;
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index]!;
    await deliverMessage({
      id: `audit-${date}-${index + 1}`,
      from: "audit",
      type: "NOTIFY",
      to: finding.agent,
      subject: `Audit ${finding.verdict}: ${finding.file}${finding.line === null ? "" : `:${finding.line}`}`,
      body: auditNotifyBody(finding),
      refs: [finding.file],
      overwrite: true,
    }, { rootDir: root, now: date });
    count += 1;
  }
  return count;
}

function auditNotifyBody(finding: OrgAuditFinding): string {
  return [
    `Verdict: ${finding.verdict}`,
    "",
    `Claim: ${finding.claim}`,
    "",
    `File: ${finding.file}${finding.line === null ? "" : `:${finding.line}`}`,
    "",
    `Note: ${finding.note}`,
    "",
  ].join("\n");
}

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
