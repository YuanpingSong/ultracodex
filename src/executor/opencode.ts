import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { TextDecoder } from "node:util";
import { resolveOpencodeEffort, resolveOpencodeModel } from "../config.js";
import { INTERRUPT_GRACE_MS, SIGTERM_GRACE_MS } from "../constants.js";
import { addUsage, ZERO_USAGE } from "../types.js";
import { assemblePrompt } from "./prompt.js";
import { createValidator } from "./schema.js";
import type {
  CapabilityDescriptor,
  Executor,
  ExecutorContext,
  ExecutorRequest,
  ExecutorResult,
} from "./contract.js";
import type {
  AgentProfileConfig,
  OpencodeBackendConfig,
  Usage,
} from "../types.js";

const THREAD_START_TIMEOUT_MS = 30_000;
const ANNOUNCE_RE =
  /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/;
const DISABLED_READ_ONLY_TOOLS: Record<string, false> = {
  bash: false,
  edit: false,
  write: false,
  patch: false,
};

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface JsonResponse {
  status: number;
  text: string;
  json: unknown;
}

interface SseState {
  buffer: string;
  onEvent(event: unknown): void;
}

interface PendingRequest {
  resolve(value: JsonResponse): void;
  reject(err: unknown): void;
}

interface TurnResult {
  status: "completed" | "failed";
  text: string;
  structured?: unknown;
  usage: Usage;
  error?: string;
  errorName?: string;
}

interface OpencodeErrorInfo {
  name: string;
  message: string;
}

function message(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function err(name: string, detail: string): Error {
  const e = new Error(detail);
  e.name = name;
  return e;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function usageFromTokens(raw: unknown): Usage {
  const u = isRecord(raw) ? raw : {};
  const cache = isRecord(u["cache"]) ? u["cache"] : {};
  const inputTokens = num(u["input"]);
  const outputTokens = num(u["output"]);
  const reasoningOutputTokens = num(u["reasoning"]);
  return {
    totalTokens: num(u["total"]) || inputTokens + outputTokens + reasoningOutputTokens,
    inputTokens,
    cachedInputTokens: num(cache["read"]),
    outputTokens,
    reasoningOutputTokens,
  };
}

function maxUsage(a: Usage, b: Usage): Usage {
  return {
    totalTokens: Math.max(a.totalTokens, b.totalTokens),
    inputTokens: Math.max(a.inputTokens, b.inputTokens),
    cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
    outputTokens: Math.max(a.outputTokens, b.outputTokens),
    reasoningOutputTokens: Math.max(a.reasoningOutputTokens, b.reasoningOutputTokens),
  };
}

function sameUsage(a: Usage, b: Usage): boolean {
  return (
    a.totalTokens === b.totalTokens &&
    a.inputTokens === b.inputTokens &&
    a.cachedInputTokens === b.cachedInputTokens &&
    a.outputTokens === b.outputTokens &&
    a.reasoningOutputTokens === b.reasoningOutputTokens
  );
}

function parseJsonResponse(status: number, text: string): JsonResponse {
  try {
    return { status, text, json: JSON.parse(text) as unknown };
  } catch {
    throw err("OpencodeProtocolError", `invalid JSON response body: ${text.slice(0, 200)}`);
  }
}

function parseSse(state: SseState, chunk: string): void {
  state.buffer += chunk;
  let idx = state.buffer.indexOf("\n\n");
  while (idx !== -1) {
    const block = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 2);
    const lines = block.split("\n").filter((line) => line.startsWith("data: "));
    if (lines.length > 0) {
      try {
        state.onEvent(JSON.parse(lines.map((line) => line.slice(6)).join("\n")) as unknown);
      } catch {}
    }
    idx = state.buffer.indexOf("\n\n");
  }
}

function opencodeError(raw: unknown): OpencodeErrorInfo | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw["name"] === "string" ? raw["name"] : "UnknownError";
  const data = isRecord(raw["data"]) ? raw["data"] : {};
  const detail =
    typeof data["message"] === "string"
      ? data["message"]
      : JSON.stringify(raw).slice(0, 200);
  return { name, message: detail };
}

function errorText(info: OpencodeErrorInfo): string {
  return info.name === "MessageAbortedError"
    ? "interrupted"
    : `${info.name}: ${info.message}`;
}

function textFromParts(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  return raw
    .filter((part) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string")
    .map((part) => (part as Record<string, unknown>)["text"] as string)
    .join("");
}

function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw err("OpencodeConfigError", `model "${model}" must be in provider/model form`);
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

function startTimeoutMs(): number {
  const raw = Number(process.env.ULTRACODEX_OPENCODE_START_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : THREAD_START_TIMEOUT_MS;
}

function readOnlyish(profile: AgentProfileConfig | undefined): boolean {
  const sandbox = profile?.sandbox;
  return sandbox !== undefined && sandbox !== "workspace-write" && sandbox !== "danger-full-access";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ kind: "fulfilled"; value: T } | { kind: "rejected"; error: unknown } | { kind: "timed-out" }> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise.then(
        (value): { kind: "fulfilled"; value: T } => ({ kind: "fulfilled", value }),
        (error): { kind: "rejected"; error: unknown } => ({ kind: "rejected", error }),
      ),
      new Promise<{ kind: "timed-out" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timed-out" }), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(err("MessageAbortedError", "interrupted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(err("MessageAbortedError", "interrupted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

class StdioTransport {
  private seq = 0;
  private pending = new Map<number, PendingRequest>();
  private streams = new Map<number, SseState>();

  constructor(private readonly child: ChildProcess) {}

  request(method: string, path: string, body?: unknown): Promise<JsonResponse> {
    const id = ++this.seq;
    this.write({ kind: "request", id, method, path, body });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  openEvents(path: string, onEvent: (event: unknown) => void): () => Promise<void> {
    const id = ++this.seq;
    this.streams.set(id, { buffer: "", onEvent });
    this.write({ kind: "request", id, method: "GET", path });
    return async () => {
      this.streams.delete(id);
      this.write({ kind: "close", id });
      await sleep(0);
    };
  }

  handleLine(line: string): void {
    if (!line.startsWith("{")) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (!isRecord(msg)) return;
    const id = typeof msg["id"] === "number" ? msg["id"] : null;
    if (id === null) return;
    if (msg["kind"] === "response") {
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      if (waiter) {
        const status = typeof msg["status"] === "number" ? msg["status"] : 0;
        try {
          waiter.resolve(parseJsonResponse(status, String(msg["body"] ?? "")));
        } catch (error) {
          waiter.reject(error);
        }
      }
      return;
    }
    if (msg["kind"] === "chunk") {
      const stream = this.streams.get(id);
      if (stream) parseSse(stream, String(msg["chunk"] ?? ""));
    }
  }

  closeAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.streams.clear();
  }

  private write(value: unknown): void {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw err("OpencodeProtocolError", "stdio transport is closed");
    stdin.write(`${JSON.stringify(value)}\n`);
  }
}

class OpencodeServe {
  private stderrText = "";
  private stdoutBuffer = "";
  private stdio: StdioTransport | null = null;
  private eventClose: (() => Promise<void>) | null = null;
  private readonly closedPromise: Promise<ExitInfo>;
  private closed = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly baseUrl: string | null,
  ) {
    this.closedPromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.closed = true;
        this.stdio?.closeAll(
          err(
            "OpencodeProcessError",
            `opencode serve exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`,
          ),
        );
        resolve({ code, signal });
      });
    });
  }

  static start(args: {
    binary: string;
    cwd: string;
    extraArgs: string[];
    signal: AbortSignal;
  }): Promise<OpencodeServe> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      const child = spawn(
        args.binary,
        ["serve", "--port", "0", "--hostname", "127.0.0.1", ...args.extraArgs],
        { cwd: args.cwd, stdio: ["pipe", "pipe", "pipe"] },
      );
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          child.kill("SIGTERM");
        } catch {}
        reject(error);
      };
      const succeed = (url: string, port: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        const serve = new OpencodeServe(child, port === 0 ? null : url);
        if (port === 0) serve.stdio = new StdioTransport(child);
        serve.stderrText = stderr;
        serve.stdoutBuffer = stdout;
        child.stdout?.on("data", (chunk: Buffer | string) => serve.onStdout(String(chunk)));
        child.stderr?.on("data", (chunk: Buffer | string) => {
          serve.stderrText += String(chunk);
        });
        resolve(serve);
      };
      const onAbort = () => fail(err("MessageAbortedError", "interrupted"));
      const timer = setTimeout(() => {
        fail(
          err(
            "OpencodeStartupTimeout",
            `opencode serve did not announce a listening port within ${startTimeoutMs()}ms`,
          ),
        );
      }, startTimeoutMs());
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        args.signal.removeEventListener("abort", onAbort);
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        child.removeListener("error", onError);
        child.removeListener("close", onCloseBeforeAnnounce);
      };
      const onStdout = (chunk: Buffer | string) => {
        stdout += String(chunk);
        let idx = stdout.indexOf("\n");
        while (idx !== -1) {
          const line = stdout.slice(0, idx);
          const match = line.match(ANNOUNCE_RE);
          if (match) {
            const port = Number(match[1]);
            succeed(`http://127.0.0.1:${port}`, port);
            return;
          }
          stdout = stdout.slice(idx + 1);
          idx = stdout.indexOf("\n");
        }
      };
      const onStderr = (chunk: Buffer | string) => {
        stderr += String(chunk);
      };
      const onError = (error: Error) => fail(error);
      const onCloseBeforeAnnounce = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(
          err(
            "OpencodeProcessError",
            `opencode serve exited before announcing a port (code ${code ?? "null"}${
              signal ? `, signal ${signal}` : ""
            }): ${stderr.trim().slice(0, 300) || "no stderr"}`,
          ),
        );
      };
      if (args.signal.aborted) onAbort();
      else args.signal.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("error", onError);
      child.once("close", onCloseBeforeAnnounce);
    });
  }

  request(method: string, path: string, body?: unknown): Promise<JsonResponse> {
    const request = this.stdio
      ? this.stdio.request(method, path, body)
      : this.fetchRequest(method, path, body);
    return Promise.race([
      request,
      this.closedPromise.then((exit) => {
        throw err(
          "OpencodeProcessError",
          `opencode serve exited (code ${exit.code ?? "null"}${
            exit.signal ? `, signal ${exit.signal}` : ""
          }): ${this.stderrText.trim().slice(0, 300) || "no stderr"}`,
        );
      }),
    ]);
  }

  async openEvents(onEvent: (event: unknown) => void): Promise<void> {
    if (this.stdio) {
      this.eventClose = this.stdio.openEvents("/event", onEvent);
      return;
    }
    const state: SseState = { buffer: "", onEvent };
    const decoder = new TextDecoder();
    const req = http.request(`${this.baseUrl}/event`, { method: "GET" }, (res) => {
      res.on("data", (chunk: Buffer) => {
        try {
          parseSse(state, decoder.decode(chunk, { stream: true }));
        } catch {}
      });
      res.on("error", () => {});
    });
    req.setTimeout(0);
    req.on("error", () => {});
    req.end();
    this.eventClose = async () => {
      req.destroy();
    };
  }

  async close(): Promise<void> {
    try {
      await this.eventClose?.();
    } catch {}
    if (this.closed) return;
    try {
      this.child.kill("SIGTERM");
    } catch {}
    const done = await settle(this.closedPromise, SIGTERM_GRACE_MS);
    if (done.kind === "timed-out") {
      try {
        this.child.kill("SIGKILL");
      } catch {}
      await settle(this.closedPromise, 1_000);
    }
  }

  private async fetchRequest(method: string, path: string, body?: unknown): Promise<JsonResponse> {
    // node:http with a generous FINITE timeout. Global fetch (undici)
    // enforces 300s and killed long provider turns; no timeout at all
    // produced indefinite hangs on turns that never return. Default 30min,
    // overridable for pathological providers.
    const timeoutMs = Number(process.env.ULTRACODEX_OPENCODE_TURN_TIMEOUT_MS) || 1_800_000;
    const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(`${this.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
      }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: data }));
        res.on("error", reject);
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(err("OpencodeProtocolError", `request timed out after ${timeoutMs}ms: ${path}`));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    if (status < 200 || status >= 300) {
      throw err("OpencodeProtocolError", `HTTP ${status} ${path}: ${text.slice(0, 200)}`);
    }
    return parseJsonResponse(status, text);
  }

  private onStdout(chunk: string): void {
    if (!this.stdio) return;
    this.stdoutBuffer += chunk;
    let idx = this.stdoutBuffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      this.stdio.handleLine(line);
      idx = this.stdoutBuffer.indexOf("\n");
    }
  }
}

function repairPrompt(errors: string, originalPrompt: string): string {
  return [
    `Your previous reply was not valid JSON for the required schema. Errors: ${errors}. Respond with ONLY the corrected JSON object.`,
    `<task>\n${originalPrompt}\n</task>`,
  ].join("\n\n");
}

function isWireSchemaRejection(result: TurnResult, formatSent: boolean): boolean {
  return (
    formatSent &&
    result.status === "failed" &&
    (result.errorName === "APIError" || result.errorName === "StructuredOutputError")
  );
}

function infoFromResponse(raw: unknown): { info: Record<string, unknown>; parts: unknown } {
  if (!isRecord(raw) || !isRecord(raw["info"])) {
    throw err("OpencodeProtocolError", "message response missing AssistantMessage info");
  }
  return { info: raw["info"], parts: raw["parts"] };
}

export class OpencodeExecutor implements Executor {
  readonly backend = "opencode";
  readonly capabilities: CapabilityDescriptor = {
    schema: "wire",
    resume: true,
    interrupt: "graceful",
    usage: "per-turn",
    activity: true,
    sandbox: [],
  };

  constructor(
    private readonly cfg: OpencodeBackendConfig,
    private readonly profiles: Record<string, AgentProfileConfig>,
  ) {}

  async run(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult> {
    try {
      return await this.execute(req, ctx);
    } catch (error) {
      return { ok: false, error: message(error) };
    }
  }

  private async execute(req: ExecutorRequest, ctx: ExecutorContext): Promise<ExecutorResult> {
    let serve: OpencodeServe | null = null;
    let threadId: string | undefined;
    let total = ZERO_USAGE;
    let liveBase = ZERO_USAGE;
    let lastEmitted = ZERO_USAGE;

    const fail = (error: string): ExecutorResult => ({
      ok: false,
      error,
      usage: total,
      ...(threadId ? { threadId } : {}),
    });

    const emitUsage = (usage: Usage) => {
      const next = maxUsage(lastEmitted, usage);
      if (!sameUsage(next, lastEmitted)) {
        lastEmitted = next;
        ctx.onUsage(next);
      } else if (sameUsage(next, ZERO_USAGE) && sameUsage(lastEmitted, ZERO_USAGE)) {
        ctx.onUsage(next);
      }
    };

    let lastActivity = Date.now();
    const onEvent = (event: unknown) => {
      if (!isRecord(event) || !isRecord(event["properties"])) return;
      lastActivity = Date.now();
      const type = event["type"];
      const properties = event["properties"];
      if (type === "message.part.delta" && typeof properties["delta"] === "string") {
        ctx.onActivity({ kind: "status", text: properties["delta"] });
        return;
      }
      if (type !== "message.updated" || !isRecord(properties["info"])) return;
      const tick = usageFromTokens(properties["info"]["tokens"]);
      emitUsage(addUsage(liveBase, tick));
    };

    try {
      const profile = req.agentProfile ? this.profiles[req.agentProfile] : undefined;
      const model = splitModel(resolveOpencodeModel(this.cfg, req.model));
      const variant = resolveOpencodeEffort(this.cfg, req.effort);
      const validate = req.schema ? createValidator(req.schema) : null;
      const firstPrompt = assemblePrompt({ prompt: req.prompt, schema: req.schema });
      let wireFormat = req.schema ? true : false;

      serve = await OpencodeServe.start({
        binary: this.cfg.binary,
        cwd: req.cwd,
        extraArgs: this.cfg.extraArgs,
        signal: ctx.signal,
      });
      await abortable(serve.openEvents(onEvent), ctx.signal);

      const session = await abortable(serve.request("POST", "/session", {}), ctx.signal);
      if (!isRecord(session.json) || typeof session.json["id"] !== "string") {
        return fail("OpencodeProtocolError: /session response missing id");
      }
      threadId = session.json["id"];
      ctx.onThread?.(threadId);

      const bodyFor = (prompt: string, format: boolean): Record<string, unknown> => {
        const body: Record<string, unknown> = {
          model,
          parts: [{ type: "text", text: prompt }],
        };
        if (variant !== null) body["variant"] = variant;
        if (profile?.preamble) body["system"] = profile.preamble;
        if (readOnlyish(profile)) body["tools"] = { ...DISABLED_READ_ONLY_TOOLS };
        if (format && req.schema) {
          body["format"] = { type: "json_schema", schema: req.schema };
        }
        return body;
      };

      const waitForMessage = async (request: Promise<JsonResponse>): Promise<JsonResponse | null> => {
        if (!ctx.signal.aborted) {
          let aborting = false;
          return await new Promise((resolve, reject) => {
            const finish = (value: JsonResponse | null) => {
              ctx.signal.removeEventListener("abort", onAbort);
              resolve(value);
            };
            const onAbort = () => {
              if (aborting) return;
              aborting = true;
              if (threadId) {
                const abortReq = serve!.request(
                  "POST",
                  `/session/${encodeURIComponent(threadId)}/abort`,
                  {},
                );
                void settle(abortReq, 1_000);
              }
              void settle(request, Math.max(100, INTERRUPT_GRACE_MS - 250)).then((outcome) => {
                if (outcome.kind === "fulfilled") finish(outcome.value);
                else {
                  request.catch(() => {});
                  finish(null);
                }
              });
            };
            ctx.signal.addEventListener("abort", onAbort, { once: true });
            request.then(
              (value) => finish(value),
              (error) => {
                ctx.signal.removeEventListener("abort", onAbort);
                if (ctx.signal.aborted) resolve(null);
                else reject(error);
              },
            );
          });
        }
        return null;
      };

      // Idle watchdog: an opencode/provider turn can stall server-side (the
      // POST holds open while no tokens or usage events arrive — observed as
      // multi-hour hangs). A turn that emits ZERO activity for IDLE_MS is
      // hung; abort it. A long-but-progressing turn resets the timer on every
      // event, so this never cuts a healthy turn. Default 10min (comfortably
      // longer than any single tool call, incl. a nested run).
      const idleMs = Number(process.env.ULTRACODEX_OPENCODE_IDLE_TIMEOUT_MS) || 600_000;
      const turn = async (prompt: string, format: boolean): Promise<TurnResult> => {
        if (ctx.signal.aborted) {
          return { status: "failed", text: "", usage: ZERO_USAGE, error: "interrupted", errorName: "MessageAbortedError" };
        }
        const before = total;
        liveBase = before;
        lastActivity = Date.now();
        let idleAborted = false;
        const idleTimer = setInterval(() => {
          if (Date.now() - lastActivity < idleMs) return;
          idleAborted = true;
          if (threadId) {
            void settle(
              serve!.request("POST", `/session/${encodeURIComponent(threadId)}/abort`, {}),
              1_000,
            );
          }
        }, Math.min(idleMs, 30_000));
        let response: JsonResponse | null;
        try {
          response = await waitForMessage(
            serve!.request(
              "POST",
              `/session/${encodeURIComponent(threadId!)}/message`,
              bodyFor(prompt, format),
            ),
          );
        } finally {
          clearInterval(idleTimer);
        }
        if (idleAborted) {
          return { status: "failed", text: "", usage: ZERO_USAGE, error: `opencode turn idle for ${Math.round(idleMs / 1000)}s (provider stall)`, errorName: "OpencodeIdleTimeout" };
        }
        if (response === null) {
          return { status: "failed", text: "", usage: ZERO_USAGE, error: "interrupted", errorName: "MessageAbortedError" };
        }
        const envelope = infoFromResponse(response.json);
        const usage = usageFromTokens(envelope.info["tokens"]);
        total = addUsage(before, usage);
        emitUsage(total);

        const rawError = opencodeError(envelope.info["error"]);
        if (rawError) {
          return {
            status: "failed",
            text: "",
            usage,
            error: errorText(rawError),
            errorName: rawError.name,
          };
        }
        const text = textFromParts(envelope.parts);
        if (Object.prototype.hasOwnProperty.call(envelope.info, "structured")) {
          return {
            status: "completed",
            text,
            structured: envelope.info["structured"],
            usage,
          };
        }
        return { status: "completed", text, usage };
      };

      const turnWithWireFallback = async (prompt: string): Promise<TurnResult> => {
        const format = wireFormat;
        let result = await turn(prompt, format);
        if (isWireSchemaRejection(result, format)) {
          wireFormat = false;
          result = await turn(prompt, false);
        }
        return result;
      };

      let result = await turnWithWireFallback(firstPrompt);
      if (result.status !== "completed") return fail(result.error ?? "opencode turn failed");
      if (!validate) {
        return { ok: true, text: result.text, usage: total, ...(threadId ? { threadId } : {}) };
      }

      let validationText =
        result.structured === undefined ? result.text : JSON.stringify(result.structured);
      let verdict = validate(validationText);
      for (let attempt = 0; !verdict.ok && attempt < this.cfg.schemaRetries; attempt++) {
        const repair = assemblePrompt({
          prompt: repairPrompt(verdict.errors, req.prompt),
          schema: req.schema,
        });
        result = await turnWithWireFallback(repair);
        if (result.status !== "completed") return fail(result.error ?? "opencode turn failed");
        validationText =
          result.structured === undefined ? result.text : JSON.stringify(result.structured);
        verdict = validate(validationText);
      }
      if (!verdict.ok) {
        return fail(
          `schema validation failed after ${this.cfg.schemaRetries} repair attempt(s): ${verdict.errors}`,
        );
      }
      return {
        ok: true,
        object: verdict.object,
        usage: total,
        ...(threadId ? { threadId } : {}),
      };
    } catch (error) {
      const mapped = error instanceof Error && error.name === "MessageAbortedError"
        ? "interrupted"
        : message(error);
      return fail(mapped);
    } finally {
      await serve?.close().catch(() => {});
    }
  }
}
