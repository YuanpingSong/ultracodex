import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT_FILES = ["AGENTS.md", "BRIEF.md", "LOG.md"];
const GROUP_FILES = ["AGENTS.md", "BRIEF.md", "THESIS.md", "LOG.md"];
const ENTITY_FILES = ["AGENTS.md", "BRIEF.md", "IDENTITY.md", "THESIS.md", "LOG.md", "WATCHLIST.md"];

export interface AskResult {
  answer: string;
  sources: unknown[];
}

export interface AskOptions {
  rootDir?: string;
  root?: string;
  now?: string;
  execImpl?: ExecImpl;
}

type ExecImpl = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout?: string; stderr?: string; exitCode?: number; status?: number; result?: unknown }>;

export async function askAgent(agentPath: string, question: string, options: AskOptions = {}): Promise<AskResult> {
  if (!question || typeof question !== "string") throw new Error("question is required");
  const agentDir = resolveAgentDir(agentPath, options);
  const role = await detectRole(agentDir);
  const script = renderAskScript({
    question,
    role,
    agentPath: displayAgentPath(agentPath, role),
    agentLabel: labelFor(agentPath, role),
  });
  const run = await runGeneratedScript(agentDir, script, options.execImpl ?? defaultExecImpl);
  const result = normalizeAskResult(parseRunJson(run));
  await appendQaLog(agentDir, question, result, options.now);
  return result;
}

function resolveAgentDir(agentPath: string, options: AskOptions = {}): string {
  if (path.isAbsolute(String(agentPath || ""))) return path.resolve(agentPath || ".");
  const root = path.resolve(options.rootDir ?? options.root ?? process.cwd());
  return path.resolve(root, agentPath || ".");
}

export function renderAskScript(query: { question: string; role: string; agentPath: string; agentLabel: string }): string {
  return `export const meta = {
  name: 'runtime-ask',
  description: 'Answer a read-only query against one agent directory.',
  whenToUse: 'Runtime generated query script for org ask.',
  phases: [
    { title: 'Query', detail: 'Read-only answer with cited sources' },
  ],
}

const QUERY = ${JSON.stringify(query, null, 2)}

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    sources: {
      type: 'array',
      items: {},
    },
  },
  required: ['answer', 'sources'],
}

phase('Query')
log(\`Query for \${QUERY.agentPath}\`)

const result = await agent(queryPrompt(), {
  label: \`ask:\${QUERY.agentLabel}\`,
  phase: 'Query',
  schema: QUERY_SCHEMA,
  agentType: 'Explore',
})

return result

function queryPrompt() {
  return \`You are answering a read-only query for \${QUERY.agentPath}.
Read AGENTS.md and the relevant memory files in this directory.
Do not edit, create, delete, or move files.
Answer the user's question from this agent directory's evidence only.
Return an answer string and a sources array naming the files or refs used.

Question:
\${QUERY.question}\`
}
`;
}

export function parseRunJson(runResult: unknown): unknown {
  if (runResult && typeof runResult === "object" && "result" in runResult && (runResult as { result?: unknown }).result !== undefined) {
    return (runResult as { result: unknown }).result;
  }
  const stdout = typeof runResult === "string" ? runResult : (runResult as { stdout?: unknown } | null | undefined)?.stdout;
  if (stdout === undefined || stdout === null || String(stdout).trim() === "") throw new Error("ultracodex returned malformed JSON: empty stdout");
  const text = String(stdout).trim();
  try {
    return JSON.parse(text) as unknown;
  } catch (firstError) {
    const last = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
    if (last && last !== text) {
      try {
        return JSON.parse(last) as unknown;
      } catch {
        throw new Error(`ultracodex returned malformed JSON: ${(firstError as Error).message}`);
      }
    }
    throw new Error(`ultracodex returned malformed JSON: ${(firstError as Error).message}`);
  }
}

async function runGeneratedScript(agentDir: string, script: string, execImpl: ExecImpl): Promise<Awaited<ReturnType<ExecImpl>>> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "org-ask-"));
  const scriptPath = path.join(tmpDir, "ask.js");
  await writeFile(scriptPath, script, "utf8");
  try {
    const command = process.env.ULTRACODEX_BIN || "ultracodex";
    const result = await execImpl(command, ["run", scriptPath, "--json"], { cwd: agentDir });
    const code = result?.exitCode ?? result?.status ?? 0;
    if (code !== 0) {
      const stderr = result?.stderr ? `: ${String(result.stderr).trim()}` : "";
      throw new Error(`ultracodex run failed with exit ${code}${stderr}`);
    }
    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultExecImpl(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFile(command, args, { ...options, maxBuffer: 1024 * 1024 * 64 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    if (err && typeof err === "object") (err as Error).message = `ultracodex run failed: ${(err as Error).message}`;
    throw err;
  }
}

function normalizeAskResult(payload: unknown): AskResult {
  const result = unwrapResult(payload);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("ultracodex result must be an object");
  const row = result as Record<string, unknown>;
  if (typeof row.answer !== "string") throw new Error("ultracodex result missing string answer");
  if (!Array.isArray(row.sources)) throw new Error("ultracodex result sources must be an array");
  return { answer: row.answer, sources: row.sources };
}

function unwrapResult(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>;
    if (row.result && typeof row.result === "object") return unwrapResult(row.result);
    if (row.output && typeof row.output === "object") return unwrapResult(row.output);
  }
  return payload;
}

async function appendQaLog(agentDir: string, question: string, result: AskResult, now: string | undefined): Promise<void> {
  const stamp = now ?? new Date().toISOString();
  const block = [
    `## ${stamp}`,
    "",
    `Question: ${oneLine(question)}`,
    "",
    "Answer:",
    result.answer.trim() || "(empty)",
    "",
    "Sources:",
    formatSources(result.sources),
    "",
  ].join("\n");
  await appendFile(path.join(agentDir, "QA.log.md"), block, "utf8");
}

function formatSources(sources: unknown[]): string {
  if (!sources.length) return "- none";
  return sources.map((source) => `- ${formatSource(source)}`).join("\n");
}

function formatSource(source: unknown): string {
  if (typeof source === "string") return oneLine(source);
  if (source && typeof source === "object") return JSON.stringify(source);
  return oneLine(String(source));
}

function oneLine(value: unknown): string {
  return String(value).replace(/\s+/gu, " ").trim();
}

async function detectRole(agentDir: string): Promise<"root" | "group" | "entity"> {
  if (await hasFiles(agentDir, ENTITY_FILES)) return "entity";
  if (await hasFiles(agentDir, GROUP_FILES)) return "group";
  if (await hasFiles(agentDir, ROOT_FILES)) return "root";
  throw new Error(`${agentDir} is not a recognized agent directory`);
}

async function hasFiles(dir: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    if ((await pathKind(path.join(dir, file))) !== "file") return false;
  }
  return true;
}

async function pathKind(file: string): Promise<"file" | "dir" | "other" | "missing"> {
  try {
    const info = await stat(file);
    if (info.isFile()) return "file";
    if (info.isDirectory()) return "dir";
    return "other";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    throw err;
  }
}

async function safeReaddir(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw err;
  }
}

function displayAgentPath(agentPath: string, role: string): string {
  if (!agentPath || agentPath === ".") return role === "root" ? "root" : ".";
  return String(agentPath).split(path.sep).join("/");
}

function labelFor(agentPath: string, role: string): string {
  if (role === "root") return "root";
  const parts = String(agentPath || "").split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) || role;
}

export const internals = { safeReaddir };
