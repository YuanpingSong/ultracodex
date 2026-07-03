import type { AppServerClient } from "./client.js";
import type { ActivityEvent, Usage } from "../types.js";
import { ZERO_USAGE, addUsage } from "../types.js";
import { INFER_COMPLETION_MS, INTERRUPT_GRACE_MS, VERIFICATION_COMMAND_RE } from "../constants.js";

export interface RunTurnOptions {
  client: AppServerClient;
  threadId: string;
  prompt: string;
  model: string | null;
  effort: string | null;
  outputSchema?: Record<string, unknown> | null;
  signal: AbortSignal;
  onActivity(ev: ActivityEvent): void;
  onUsage(usage: Usage): void;
}

export interface TurnResult {
  status: "completed" | "interrupted" | "failed";
  finalText: string | null;
  turnId: string | null;
  usage: Usage;
  error: string | null;
}

type Params = Record<string, any>;

function shorten(text: unknown, limit = 96): string {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function describeItem(item: Params, lifecycle: "started" | "completed"): ActivityEvent | null {
  switch (item.type) {
    case "commandExecution": {
      const phase = VERIFICATION_COMMAND_RE.test(String(item.command ?? "")) ? "verifying" : "running";
      const text =
        lifecycle === "started"
          ? `Running command: ${shorten(item.command)}`
          : `Command ${item.status ?? "completed"}: ${shorten(item.command)} (exit ${item.exitCode ?? "?"})`;
      return { kind: "exec", text, phase };
    }
    case "fileChange": {
      const text =
        lifecycle === "started"
          ? `Applying ${item.changes?.length ?? 0} file change(s).`
          : `File changes ${item.status ?? "completed"}.`;
      return { kind: "patch", text };
    }
    case "mcpToolCall":
      return {
        kind: "tool",
        text: lifecycle === "started" ? `Calling ${item.server}/${item.tool}.` : `Tool ${item.server}/${item.tool} ${item.status}.`,
      };
    case "dynamicToolCall":
      return {
        kind: "tool",
        text: lifecycle === "started" ? `Running tool: ${item.tool}.` : `Tool ${item.tool} ${item.status}.`,
      };
    case "collabAgentToolCall":
      return {
        kind: "tool",
        text: lifecycle === "started" ? `Starting collab tool: ${item.tool}.` : `Collab tool ${item.tool} ${item.status}.`,
      };
    case "webSearch":
      return { kind: "search", text: `Searching: ${shorten(item.query)}` };
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const first = summary
        .map((s: unknown) => (typeof s === "string" ? s : shorten((s as Params)?.text ?? "")))
        .find((s: string) => s.trim());
      return first ? { kind: "reasoning", text: shorten(first) } : null;
    }
    case "userMessage":
      return null;
    case "agentMessage":
      return lifecycle === "completed" && item.text ? { kind: "status", text: `Assistant message: ${shorten(item.text)}` } : null;
    default:
      return lifecycle === "started" ? { kind: "status", text: shorten(item.type ?? "item") } : null;
  }
}

function subUsage(a: Usage, b: Usage): Usage {
  return {
    totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    cachedInputTokens: Math.max(0, a.cachedInputTokens - b.cachedInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    reasoningOutputTokens: Math.max(0, a.reasoningOutputTokens - b.reasoningOutputTokens),
  };
}

function toUsage(raw: Params | null | undefined): Usage | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    totalTokens: Number(raw.totalTokens) || 0,
    inputTokens: Number(raw.inputTokens) || 0,
    cachedInputTokens: Number(raw.cachedInputTokens) || 0,
    outputTokens: Number(raw.outputTokens) || 0,
    reasoningOutputTokens: Number(raw.reasoningOutputTokens) || 0,
  };
}

export function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const { client, threadId, signal } = opts;
  return new Promise<TurnResult>((resolve) => {
    let settled = false;
    let responseSeen = false;
    let turnId: string | null = null;
    let finalAnswerText: string | null = null;
    let lastAgentMessage: string | null = null;
    let finalAnswerSeen = false;
    let usage: Usage = ZERO_USAGE;
    /** Thread-cumulative usage before this turn (tokenUsage `total` minus the first `last` delta). */
    let usageBaseline: Usage | null = null;
    let inferTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;
    let aborted = false;
    const threadIds = new Set<string>([threadId]);
    const threadTurnIds = new Map<string, string>();
    const pendingCollabs = new Set<string>();
    const activeSubagentTurns = new Set<string>();
    const buffered: Array<{ method: string; params: Params }> = [];

    const settle = (status: TurnResult["status"], error: string | null) => {
      if (settled) return;
      settled = true;
      if (inferTimer) clearTimeout(inferTimer);
      if (graceTimer) clearTimeout(graceTimer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      resolve({ status, finalText: finalAnswerText ?? lastAgentMessage, turnId, usage, error });
    };

    const scheduleInferred = () => {
      if (settled || !finalAnswerSeen) return;
      if (pendingCollabs.size > 0 || activeSubagentTurns.size > 0) return;
      if (inferTimer) clearTimeout(inferTimer);
      inferTimer = setTimeout(() => {
        inferTimer = null;
        if (settled || !finalAnswerSeen) return;
        if (pendingCollabs.size > 0 || activeSubagentTurns.size > 0) return;
        settle("completed", null);
      }, INFER_COMPLETION_MS);
    };

    const belongsToTurn = (params: Params): boolean => {
      const msgThreadId: string | null = params?.threadId ?? params?.thread?.id ?? null;
      if (!msgThreadId || !threadIds.has(msgThreadId)) return false;
      const tracked = threadTurnIds.get(msgThreadId) ?? null;
      const msgTurnId: string | null = params?.turnId ?? params?.turn?.id ?? null;
      return tracked === null || msgTurnId === null || msgTurnId === tracked;
    };

    const recordItem = (item: Params, lifecycle: "started" | "completed", itemThreadId: string | null) => {
      if (item.type === "collabAgentToolCall") {
        if (itemThreadId === null || itemThreadId === threadId) {
          if (lifecycle === "started" || item.status === "inProgress") {
            pendingCollabs.add(item.id);
          } else if (lifecycle === "completed") {
            pendingCollabs.delete(item.id);
            scheduleInferred();
          }
        }
        for (const receiver of item.receiverThreadIds ?? []) {
          if (receiver) threadIds.add(receiver);
        }
      }
      if (item.type === "agentMessage" && item.text && (itemThreadId === null || itemThreadId === threadId)) {
        lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          finalAnswerText = item.text;
          finalAnswerSeen = true;
          scheduleInferred();
        }
      }
    };

    const completeTurn = (turn: Params) => {
      const status: string = turn?.status ?? "completed";
      if (status === "failed") {
        settle("failed", String(turn?.error?.message ?? "turn failed"));
      } else if (status === "interrupted") {
        settle("interrupted", null);
      } else {
        settle(aborted ? "interrupted" : "completed", null);
      }
    };

    const apply = (method: string, params: Params) => {
      switch (method) {
        case "thread/started":
          if (params?.thread?.id) threadIds.add(params.thread.id);
          break;
        case "turn/started": {
          const tid: string | null = params?.threadId ?? null;
          if (!tid) break;
          threadIds.add(tid);
          if (params?.turn?.id) threadTurnIds.set(tid, params.turn.id);
          if (tid !== threadId) activeSubagentTurns.add(tid);
          break;
        }
        case "item/started":
        case "item/completed": {
          const lifecycle = method === "item/started" ? "started" : "completed";
          const item: Params = params?.item ?? {};
          recordItem(item, lifecycle, params?.threadId ?? null);
          const activity = describeItem(item, lifecycle);
          if (activity) opts.onActivity(activity);
          break;
        }
        case "thread/tokenUsage/updated": {
          // `total` is thread-cumulative, `last` is the most recent model request
          // (probe-capture.jsonl). A multi-step turn produces several updates, so
          // the turn's usage is total-so-far minus the total at turn start
          // (equivalently: the sum of the `last` deltas seen during the turn).
          if (params?.threadId !== threadId) break;
          const last = toUsage(params?.tokenUsage?.last);
          const total = toUsage(params?.tokenUsage?.total);
          if (!last && !total) break;
          if (total) {
            if (usageBaseline === null) usageBaseline = subUsage(total, last ?? ZERO_USAGE);
            usage = subUsage(total, usageBaseline);
          } else if (last) {
            usage = addUsage(usage, last);
          }
          opts.onUsage(usage);
          break;
        }
        case "error": {
          // ErrorNotification: { error: TurnError, willRetry, threadId, turnId }.
          // codex retries transient errors itself (willRetry) — don't fail the turn.
          // Errors on subagent threads must not settle the MAIN turn either.
          const msg = String(params?.error?.message ?? "codex error");
          if (params?.willRetry) {
            opts.onActivity({ kind: "status", text: `codex error (retrying): ${shorten(msg)}` });
            break;
          }
          const errThreadId: string | null = params?.threadId ?? null;
          if (errThreadId !== null && errThreadId !== threadId) {
            opts.onActivity({ kind: "status", text: `subagent error: ${shorten(msg)}` });
            break;
          }
          settle("failed", msg);
          break;
        }
        case "turn/completed": {
          const tid: string | null = params?.threadId ?? null;
          if (tid !== threadId) {
            if (tid) activeSubagentTurns.delete(tid);
            scheduleInferred();
            break;
          }
          completeTurn(params?.turn ?? {});
          break;
        }
        default:
          break;
      }
    };

    const route = (method: string, params: Params) => {
      if (settled) return;
      if (method === "thread/started" || method === "thread/name/updated") {
        apply(method, params);
        return;
      }
      if (!belongsToTurn(params)) return;
      apply(method, params);
    };

    const onNotification = (method: string, params: unknown) => {
      if (settled) return;
      if (!responseSeen) {
        buffered.push({ method, params: (params ?? {}) as Params });
        return;
      }
      route(method, (params ?? {}) as Params);
    };
    const unsubscribe = client.onNotification(onNotification);

    const sendInterrupt = () => {
      client.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    };

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      if (!graceTimer) {
        graceTimer = setTimeout(() => settle("interrupted", null), INTERRUPT_GRACE_MS);
      }
      if (turnId) sendInterrupt();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    client.exited.then((code) => {
      if (!settled) settle("failed", `codex app-server exited (code ${code}) before turn completion`);
    });

    client
      .request<{ turn?: { id?: string; status?: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: opts.prompt, text_elements: [] }],
        model: opts.model,
        effort: opts.effort,
        outputSchema: opts.outputSchema ?? null,
      })
      .then((res) => {
        if (settled) return;
        responseSeen = true;
        turnId = res?.turn?.id ?? null;
        if (turnId) threadTurnIds.set(threadId, turnId);
        for (const msg of buffered.splice(0)) {
          if (settled) break;
          route(msg.method, msg.params);
        }
        if (settled) return;
        if (aborted) sendInterrupt();
        if (res?.turn?.status && res.turn.status !== "inProgress") {
          completeTurn(res.turn as Params);
        }
      })
      .catch((err: unknown) => {
        settle("failed", err instanceof Error ? err.message : String(err));
      });

    if (signal.aborted) onAbort();
  });
}
