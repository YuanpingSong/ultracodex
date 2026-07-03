import { AppServerClient } from "../appserver/client.js";
import { runTurn, type TurnResult } from "../appserver/turn.js";
import { assemblePrompt } from "./prompt.js";
import { createValidator, strictify, strictifyForWire } from "./schema.js";
import { addUsage, ZERO_USAGE } from "../types.js";
import type {
  AgentProfileConfig,
  CodexBackendConfig,
  Executor,
  ExecutorContext,
  ExecutorRequest,
  ExecutorResult,
  Usage,
} from "../types.js";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A stalled app-server must never hang the workflow: bound thread/start. */
const THREAD_START_TIMEOUT_MS = 30_000;

/** Reject with "interrupted" as soon as `signal` aborts (the promise itself keeps its own timeout). */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The abandoned request may still reject later (e.g. when the client
    // exits); swallow it so it cannot become an unhandled rejection.
    promise.catch(() => {});
    return Promise.reject(new Error("interrupted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("interrupted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function repairPrompt(errors: string, originalPrompt: string): string {
  return [
    `Your previous reply was not valid JSON for the required schema. Errors: ${errors}. Respond with ONLY the corrected JSON object.`,
    `<task>\n${originalPrompt}\n</task>`,
  ].join("\n\n");
}

export class CodexExecutor implements Executor {
  readonly backend = "codex";

  constructor(
    private readonly cfg: CodexBackendConfig,
    private readonly profiles: Record<string, AgentProfileConfig>,
  ) {}

  async run(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult> {
    try {
      return await this.execute(req, ctx);
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  }

  private async execute(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult> {
    const profile = req.agentProfile ? this.profiles[req.agentProfile] : undefined;
    const model = req.model ? (this.cfg.modelMap[req.model] ?? req.model) : this.cfg.defaultModel;
    const effort = req.effort
      ? (this.cfg.effortMap[req.effort] ?? req.effort)
      : this.cfg.defaultEffort;
    // Two schema forms (observed live: OpenAI strict mode 400s unless every
    // object node has required=all keys + additionalProperties:false):
    // - wireSchema: strict-compliant form for turn/start outputSchema, or null
    //   when the authored schema can't be expressed strictly (then the
    //   prompt-inlined contract + ajv repair loop carries it alone).
    // - validation/prompt use the AUTHORED schema — upstream semantics
    //   (optional properties stay optional) are judged as written.
    const wireSchema = req.schema ? strictifyForWire(req.schema) : null;
    const validate = req.schema ? createValidator(strictify(req.schema)) : null;
    const prompt = assemblePrompt({
      prompt: req.prompt,
      schema: req.schema ? strictify(req.schema) : undefined,
      profilePreamble: profile?.preamble,
    });

    let client: AppServerClient;
    try {
      client = await AppServerClient.start({
        binary: this.cfg.binary,
        cwd: req.cwd,
        // Pin the service tier (default "standard") so a user-level
        // service_tier = "fast" in ~/.codex/config.toml can't silently
        // burn increased usage on every agent.
        extraArgs: [
          ...(this.cfg.serviceTier ? ["-c", `service_tier="${this.cfg.serviceTier}"`] : []),
          ...this.cfg.extraArgs,
        ],
      });
    } catch (err) {
      return { ok: false, error: `failed to start codex app-server: ${message(err)}` };
    }

    let threadId: string | undefined;
    let total: Usage = ZERO_USAGE;
    try {
      const started = await withAbort(
        client.request<{ thread: { id: string } }>(
          "thread/start",
          {
            cwd: req.cwd,
            approvalPolicy: "never",
            sandbox: profile?.sandbox ?? this.cfg.sandbox,
            ephemeral: false,
          },
          { timeoutMs: THREAD_START_TIMEOUT_MS },
        ),
        ctx.signal,
      );
      threadId = started.thread.id;
      if (ctx.onThread) ctx.onThread(threadId);

      const turn = async (turnPrompt: string): Promise<TurnResult> => {
        const before = total;
        const result = await runTurn({
          client,
          threadId: threadId!,
          prompt: turnPrompt,
          model,
          effort,
          outputSchema: wireSchema,
          signal: ctx.signal,
          onActivity: (ev) => ctx.onActivity(ev),
          onUsage: (u) => ctx.onUsage(addUsage(before, u)),
        });
        total = addUsage(before, result.usage);
        return result;
      };

      const fail = (result: TurnResult): ExecutorResult =>
        result.status === "interrupted"
          ? { ok: false, error: "interrupted", usage: total, threadId }
          : { ok: false, error: result.error ?? "codex turn failed", usage: total, threadId };

      let result = await turn(prompt);
      if (result.status !== "completed") return fail(result);
      if (!validate) return { ok: true, text: result.finalText ?? "", usage: total, threadId };

      let verdict = validate(result.finalText ?? "");
      for (let attempt = 0; !verdict.ok && attempt < this.cfg.schemaRetries; attempt++) {
        result = await turn(repairPrompt(verdict.errors, req.prompt));
        if (result.status !== "completed") return fail(result);
        verdict = validate(result.finalText ?? "");
      }
      if (!verdict.ok) {
        return {
          ok: false,
          error: `schema validation failed after ${this.cfg.schemaRetries} repair attempt(s): ${verdict.errors}`,
          usage: total,
          threadId,
        };
      }
      return { ok: true, object: verdict.object, usage: total, threadId };
    } finally {
      await client.close().catch(() => {});
    }
  }
}
