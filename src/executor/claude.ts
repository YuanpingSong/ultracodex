import { spawn } from "node:child_process";
import type {
  AgentProfileConfig,
  ClaudeBackendConfig,
  Executor,
  ExecutorContext,
  ExecutorRequest,
  ExecutorResult,
  Usage,
} from "../types.js";
import { ZERO_USAGE, addUsage } from "../types.js";
import { assemblePrompt } from "./prompt.js";
import { createValidator, strictify } from "./schema.js";

interface CliOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  interrupted: boolean;
  spawnError: string | null;
}

function runCli(
  binary: string,
  args: string[],
  stdinText: string,
  cwd: string,
  signal: AbortSignal,
): Promise<CliOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    let settled = false;
    const child = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const onAbort = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };
    const done = (o: CliOutcome) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(o);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (stderr += d));
    child.on("error", (err) =>
      done({ stdout, stderr, code: null, interrupted, spawnError: err.message }),
    );
    child.on("close", (code) =>
      done({ stdout, stderr, code, interrupted, spawnError: null }),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(stdinText);
  });
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mapUsage(raw: unknown): Usage {
  const u = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const inputTokens = num(u["input_tokens"]);
  const outputTokens = num(u["output_tokens"]);
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: num(u["cache_read_input_tokens"]),
    outputTokens,
    reasoningOutputTokens: 0,
  };
}

interface Envelope {
  ok: boolean;
  text: string | null;
  sessionId: string | null;
  usage: Usage;
  error: string | null;
}

function parseEnvelope(out: CliOutcome): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout.trim());
  } catch {
    const detail =
      out.stderr.trim().slice(0, 200) || out.stdout.trim().slice(0, 200) || "no output";
    return {
      ok: false,
      text: null,
      sessionId: null,
      usage: ZERO_USAGE,
      error: `claude exited (code ${out.code}) without valid JSON output: ${detail}`,
    };
  }
  const env = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const sessionId = typeof env["session_id"] === "string" ? env["session_id"] : null;
  const usage = mapUsage(env["usage"]);
  const subtype = typeof env["subtype"] === "string" ? env["subtype"] : null;
  const text = typeof env["result"] === "string" ? env["result"] : null;
  const failed =
    env["is_error"] === true || text === null || (subtype !== null && subtype !== "success");
  if (failed) {
    const detail = text ?? (typeof env["error"] === "string" ? env["error"] : null);
    return {
      ok: false,
      text: null,
      sessionId,
      usage,
      error: `claude call failed (subtype: ${subtype ?? "unknown"})${
        detail ? `: ${detail.slice(0, 200)}` : ""
      }`,
    };
  }
  return { ok: true, text, sessionId, usage, error: null };
}

function repairInstruction(errors: string): string {
  return `Your previous reply was not valid JSON for the required schema. Errors: ${errors}. Respond with ONLY the corrected JSON object.`;
}

type CallResult = { failed: string; text?: undefined } | { failed: null; text: string };

export class ClaudeExecutor implements Executor {
  readonly backend = "claude";

  constructor(
    private readonly cfg: ClaudeBackendConfig,
    private readonly profiles: Record<string, AgentProfileConfig>,
  ) {}

  async run(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult> {
    const model = req.model
      ? (this.cfg.modelMap[req.model] ?? req.model)
      : this.cfg.defaultModel;
    const schema = req.schema ? strictify(req.schema) : null;
    const rawValidate = schema ? createValidator(schema) : null;
    const validate = rawValidate
      ? (text: string) => {
          try {
            return rawValidate(text);
          } catch (err) {
            return {
              ok: false as const,
              errors: err instanceof Error ? err.message : String(err),
            };
          }
        }
      : null;
    const profile = req.agentProfile ? this.profiles[req.agentProfile] : undefined;
    const prompt = assemblePrompt({
      prompt: req.prompt,
      ...(schema ? { schema } : {}),
      ...(profile?.preamble ? { profilePreamble: profile.preamble } : {}),
    });
    const baseArgs = ["-p", "--output-format", "json", ...(model ? ["--model", model] : [])];

    let usage: Usage = ZERO_USAGE;
    let sessionId: string | null = null;

    const fail = (error: string): ExecutorResult => ({
      ok: false,
      error,
      usage,
      ...(sessionId ? { threadId: sessionId } : {}),
    });

    const call = async (args: string[], stdinText: string): Promise<CallResult> => {
      if (ctx.signal.aborted) return { failed: "interrupted" };
      ctx.onActivity({ kind: "status", text: "claude -p running" });
      const out = await runCli(this.cfg.binary, args, stdinText, req.cwd, ctx.signal);
      if (out.interrupted || ctx.signal.aborted) return { failed: "interrupted" };
      if (out.spawnError !== null)
        return { failed: `failed to spawn ${this.cfg.binary}: ${out.spawnError}` };
      const env = parseEnvelope(out);
      usage = addUsage(usage, env.usage);
      ctx.onUsage(usage);
      if (env.sessionId && sessionId === null) {
        sessionId = env.sessionId;
        ctx.onThread?.(env.sessionId);
      }
      if (!env.ok || env.text === null) return { failed: env.error ?? "claude call failed" };
      return { failed: null, text: env.text };
    };

    const first = await call(baseArgs, prompt);
    if (first.failed !== null) return fail(first.failed);
    if (!validate)
      return { ok: true, text: first.text, usage, ...(sessionId ? { threadId: sessionId } : {}) };

    let text = first.text;
    let verdict = validate(text);
    for (let attempt = 0; !verdict.ok && attempt < this.cfg.schemaRetries; attempt++) {
      const repair = repairInstruction(verdict.errors);
      const res = sessionId
        ? await call([...baseArgs, "--resume", sessionId], repair)
        : await call(baseArgs, `${prompt}\n\n${repair}`);
      if (res.failed !== null) return fail(res.failed);
      text = res.text;
      verdict = validate(text);
    }
    if (!verdict.ok)
      return fail(
        `schema validation failed after ${this.cfg.schemaRetries} repair attempt(s): ${verdict.errors}`,
      );
    return {
      ok: true,
      object: verdict.object,
      usage,
      ...(sessionId ? { threadId: sessionId } : {}),
    };
  }
}
