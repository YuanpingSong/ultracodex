// Live probe of `codex app-server` — captures real wire traffic to
// fixtures/appserver/probe-capture.jsonl for executor design + fake-codex fixture.
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";

const OUT = path.resolve("fixtures/appserver/probe-capture.jsonl");
const log = fs.createWriteStream(OUT, { flags: "w" });
const record = (dir, msg) => log.write(JSON.stringify({ dir, msg }) + "\n");

const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (d) => process.stderr.write(`[stderr] ${d}`));

let nextId = 1;
const pending = new Map();
const notifications = [];

function request(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  record("out", msg);
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 90_000);
  });
}

function notify(method, params) {
  const msg = { jsonrpc: "2.0", method, params };
  record("out", msg);
  child.stdin.write(JSON.stringify(msg) + "\n");
}

const turnDone = { resolve: null };

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { record("in-unparsed", line); return; }
  record("in", msg);
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)) : p.resolve(msg.result);
    }
    return;
  }
  if (msg.method) {
    notifications.push(msg.method);
    console.log(`  <- ${msg.method}`);
    if (msg.method === "turn/completed" && turnDone.resolve) turnDone.resolve(msg.params);
    // server->client REQUESTS (approvals etc.) — auto-decline to keep probe moving
    if (msg.id !== undefined) {
      const resp = { jsonrpc: "2.0", id: msg.id, result: { decision: "denied" } };
      record("out", resp);
      child.stdin.write(JSON.stringify(resp) + "\n");
    }
  }
});

const waitTurn = () => new Promise((r) => { turnDone.resolve = r; });

try {
  const init = await request("initialize", {
    clientInfo: { name: "ultracodex", title: "ultracodex probe", version: "0.0.0" },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
      optOutNotificationMethods: [
        "item/agentMessage/delta",
        "item/reasoning/summaryTextDelta",
        "item/reasoning/summaryPartAdded",
        "item/reasoning/textDelta",
      ],
    },
  });
  console.log("initialize ok:", JSON.stringify(init).slice(0, 200));
  notify("initialized", {});

  const account = await request("account/read", { refreshToken: false });
  console.log("account:", JSON.stringify(account).slice(0, 300));

  const models = await request("model/list", {});
  console.log("models:", JSON.stringify(models).slice(0, 2000));

  const thread = await request("thread/start", {
    cwd: "/tmp",
    approvalPolicy: "never",
    sandbox: "read-only",
    ephemeral: true,
  });
  const threadId = thread.thread?.id ?? thread.threadId;
  console.log("threadId:", threadId);

  // Turn 1: plain text
  let done = waitTurn();
  await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly the word: hello", text_elements: [] }],
    effort: "low",
  });
  let turn = await done;
  console.log("turn1 completed:", JSON.stringify(turn).slice(0, 600));

  // Turn 2: structured output
  done = waitTurn();
  await request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Return a JSON object with your favorite color and a number 1-10.", text_elements: [] }],
    effort: "low",
    outputSchema: {
      type: "object",
      properties: { color: { type: "string" }, n: { type: "number" } },
      required: ["color", "n"],
      additionalProperties: false,
    },
  });
  turn = await done;
  console.log("turn2 completed:", JSON.stringify(turn).slice(0, 600));

  console.log("\nNotification methods seen:", [...new Set(notifications)].join(", "));
} catch (e) {
  console.error("PROBE FAILED:", e.message);
} finally {
  child.kill("SIGTERM");
  log.end();
  setTimeout(() => process.exit(0), 500);
}
