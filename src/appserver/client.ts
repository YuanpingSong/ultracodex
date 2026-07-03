import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export interface AppServerClientOptions {
  binary: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class RpcError extends Error {
  code?: number;
  data?: unknown;
}

interface Pending {
  method: string;
  timer: NodeJS.Timeout | null;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const OPT_OUT_NOTIFICATION_METHODS = [
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
];

const CLOSE_GRACE_MS = 2_000;

export class AppServerClient {
  readonly exited: Promise<number | null>;

  private proc: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private handlers = new Set<(method: string, params: unknown) => void>();
  private closed = false;
  private exitedFlag = false;
  private stderrBuf = "";
  private resolveExited!: (code: number | null) => void;

  private constructor(proc: ChildProcess) {
    this.proc = proc;
    this.exited = new Promise((resolve) => {
      this.resolveExited = resolve;
    });
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-4_000);
    });
    proc.stdin?.on("error", () => {});
    proc.on("error", () => this.handleExit(null));
    proc.on("exit", (code) => this.handleExit(code ?? null));
    if (proc.stdout) {
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => this.handleLine(line));
    }
  }

  static async start(opts: AppServerClientOptions): Promise<AppServerClient> {
    const proc = spawn(opts.binary, ["app-server"], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const client = new AppServerClient(proc);
    try {
      await client.request(
        "initialize",
        {
          clientInfo: { name: "ultracodex", title: "ultracodex", version: "0.1.0" },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: OPT_OUT_NOTIFICATION_METHODS,
          },
        },
        { timeoutMs: 10_000 },
      );
      client.notify("initialized", {});
    } catch (err) {
      client.kill();
      throw err;
    }
    return client;
  }

  get pid(): number | null {
    return this.proc.pid ?? null;
  }

  request<T = unknown>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (this.closed || this.exitedFlag) {
      return Promise.reject(new RpcError(`app-server client is closed (${method})`));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      if (opts?.timeoutMs) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new RpcError(`${method} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, { method, timer, resolve: resolve as (v: unknown) => void, reject });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(err instanceof Error ? err : new RpcError(String(err)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed || this.exitedFlag) return;
    try {
      this.send({ jsonrpc: "2.0", method, params });
    } catch {}
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      if (!this.exitedFlag) {
        try {
          this.proc.stdin?.end();
        } catch {}
        const timer = setTimeout(() => this.killTree("SIGKILL"), CLOSE_GRACE_MS);
        timer.unref?.();
        await this.exited;
        clearTimeout(timer);
        return;
      }
    }
    await this.exited;
  }

  kill(): void {
    this.killTree("SIGKILL");
  }

  private killTree(sig: NodeJS.Signals): void {
    const pid = this.proc.pid;
    if (pid == null || this.exitedFlag) return;
    try {
      process.kill(-pid, sig); // detached spawn -> own process group
    } catch {
      try {
        this.proc.kill(sig);
      } catch {}
    }
  }

  private send(msg: unknown): void {
    const stdin = this.proc.stdin;
    if (!stdin || !stdin.writable) throw new RpcError("app-server stdin is not writable");
    stdin.write(JSON.stringify(msg) + "\n");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method) {
      // Server -> client request (approval asks): deny automatically, surface too.
      try {
        this.send({ jsonrpc: "2.0", id: msg.id, result: { decision: "denied" } });
      } catch {}
      this.dispatch(msg.method, msg.params);
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        const err = new RpcError(msg.error.message ?? `${pending.method} failed`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        pending.reject(err);
      } else {
        pending.resolve(msg.result ?? {});
      }
      return;
    }
    if (msg.method) this.dispatch(msg.method, msg.params);
  }

  private dispatch(method: string, params: unknown): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(method, params);
      } catch {}
    }
  }

  private handleExit(code: number | null): void {
    if (this.exitedFlag) return;
    this.exitedFlag = true;
    const stderrTail = this.stderrBuf.trim().split("\n").slice(-5).join("\n");
    const err = new RpcError(`codex app-server exited (code ${code})${stderrTail ? `: ${stderrTail}` : ""}`);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
    this.resolveExited(code);
  }
}
