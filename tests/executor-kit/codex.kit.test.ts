import path from "node:path";
import { DEFAULT_CODEX_CONFIG } from "../../src/constants.js";
import { CodexExecutor } from "../../src/executor/codex.js";
import { executorDegradationWarnings } from "../../src/executor/router.js";
import type { AgentProfileConfig, CodexBackendConfig, Usage } from "../../src/types.js";
import type { ExecutorRequest } from "../../src/executor/contract.js";
import { fakeCodexPath } from "../helpers.js";
import { registerExecutorKit, type ExecutorKitHarness, type ExecutorKitStage } from "./kit.js";

const PROFILE_MARKER = "KIT_PROFILE_PREAMBLE";

const PROFILES: Record<string, AgentProfileConfig> = {
  KitProfile: { sandbox: "read-only", preamble: PROFILE_MARKER },
};

const UNSUPPORTED_PROFILES: Record<string, AgentProfileConfig> = {
  UnsupportedKit: { sandbox: "sealed" },
};

const NUMBER_SCHEMA = {
  type: "object",
  properties: { a: { type: "number" } },
  required: ["a"],
};

const OPTIONAL_SCHEMA = {
  type: "object",
  properties: {
    done: { type: "boolean" },
    optionalNote: { type: "string" },
  },
  required: ["done"],
};

const MAP_SCHEMA = {
  type: "object",
  properties: {
    counts: { type: "object", additionalProperties: { type: "number" } },
  },
  required: ["counts"],
};

const METERED_USAGE: Usage = {
  totalTokens: 165,
  inputTokens: 150,
  cachedInputTokens: 0,
  outputTokens: 15,
  reasoningOutputTokens: 0,
};

function cfg(overrides: Partial<CodexBackendConfig> = {}): CodexBackendConfig {
  return { ...DEFAULT_CODEX_CONFIG, binary: fakeCodexPath(), ...overrides };
}

function makeExecutor(overrides?: Partial<CodexBackendConfig>): CodexExecutor {
  return new CodexExecutor(cfg(overrides), PROFILES);
}

function request(h: ExecutorKitHarness, label: string, prompt: string, schema?: Record<string, unknown>): ExecutorRequest {
  const req: ExecutorRequest = { prompt, cwd: h.tmpDir(), label };
  if (schema) req.schema = schema;
  return req;
}

function withEnv(vars: Record<string, string>, stage: ExecutorKitStage): ExecutorKitStage {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const cleanup = stage.cleanup;
  return {
    ...stage,
    cleanup: async () => {
      try {
        await cleanup?.();
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  };
}

function repairAlwaysInvalid(h: ExecutorKitHarness): ExecutorKitStage {
  return {
    request: request(h, "retry-exhaustion", '[[reply:{"a":"wrong"}]]', NUMBER_SCHEMA),
    errorPattern: /schema validation failed.*must be number/s,
  };
}

function harnessFailure(h: ExecutorKitHarness): ExecutorKitStage {
  return {
    request: request(h, "harness-failure", "[[fail:harness boom]]"),
    errorPattern: /harness boom/,
  };
}

function abortHang(h: ExecutorKitHarness): ExecutorKitStage {
  const pidFile = path.join(h.tmpDir("ultracodex-kit-codex-pids-"), "child.pid");
  return withEnv(
    { FAKE_CODEX_ORPHAN_CHILD: "1", FAKE_CODEX_CHILD_PID_FILE: pidFile },
    {
      request: request(h, "abort-hang", "[[slow:5000]] [[reply:too late]]"),
      abortAfterMs: 100,
      orphanPidFile: pidFile,
      errorPattern: /interrupted/,
    },
  );
}

function midTurnCrash(h: ExecutorKitHarness): ExecutorKitStage {
  return withEnv(
    { FAKE_CODEX_CRASH_MID_TURN: "1" },
    {
      request: request(h, "mid-turn-crash", "[[reply:never]]"),
      errorPattern: /app-server exited|before turn completion/,
    },
  );
}

function stalledThreadStart(h: ExecutorKitHarness): ExecutorKitStage {
  return withEnv(
    { FAKE_CODEX_STALL_THREAD_START: "1" },
    {
      request: request(h, "thread-start-stall", "[[reply:never]]"),
      abortAfterMs: 100,
      errorPattern: /interrupted/,
    },
  );
}

registerExecutorKit({
  name: "codex",
  makeExecutor,
  stagers: {
    textSuccess: (h) => ({
      request: request(h, "text-success", "[[reply:hello from codex]]"),
      expectedText: "hello from codex",
    }),
    schemaOptional: (h) => ({
      request: request(h, "schema-optional", '[[reply:{"done":true}]]', OPTIONAL_SCHEMA),
      expectedObject: { done: true },
    }),
    schemaMapFallback: (h) => ({
      request: request(h, "schema-map", '[[reply:{"counts":{"x":1,"y":2}}]]', MAP_SCHEMA),
      expectedObject: { counts: { x: 1, y: 2 } },
    }),
    repairInvalidThenValid: (h) => ({
      request: request(h, "schema-repair", '[[reply:not json]] [[reply2:{"a":2}]]', NUMBER_SCHEMA),
      expectedObject: { a: 2 },
    }),
    repairAlwaysInvalid,
    harnessFailure,
    abortHang,
    midTurnCrash,
    usageTicks: (h) => ({
      request: request(h, "usage", "[[midusage:50,5]] [[usage:100,10]] [[reply:metered]]"),
      expectedText: "metered",
      expectedUsage: METERED_USAGE,
    }),
    sessionId: (h) => ({
      request: request(h, "session-id", "[[reply:threaded]]"),
      expectedText: "threaded",
    }),
    profileApplication: (h) => ({
      request: {
        ...request(h, "profile", `[[expect-prompt:${PROFILE_MARKER}]] [[reply:profiled]]`),
        agentProfile: "KitProfile",
      },
      expectedText: "profiled",
      warnings: () => executorDegradationWarnings({ codex: makeExecutor() }, UNSUPPORTED_PROFILES, false),
      expectedWarnings: [/backend "codex" cannot honor profile "UnsupportedKit" sandbox="sealed"/],
    }),
    wireSchemaRejection: (h) => ({
      executor: makeExecutor({ schemaRetries: 0 }),
      request: request(
        h,
        "wire-rejection",
        '[[reject-output-schema]] [[reply:{"a":"wrong"}]] [[reply2:{"a":4}]]',
        NUMBER_SCHEMA,
      ),
      expectedObject: { a: 4 },
    }),
    failures: [
      { name: "schema retry exhaustion", stage: repairAlwaysInvalid },
      { name: "harness failure", stage: harnessFailure },
      { name: "abort hang", stage: abortHang },
      { name: "mid-turn crash", stage: midTurnCrash },
      { name: "stalled thread/start abort", stage: stalledThreadStart },
      {
        name: "spawn failure",
        stage: (h) => ({
          executor: makeExecutor({ binary: "/nonexistent/definitely-not-codex" }),
          request: request(h, "spawn-failure", "[[reply:unreachable]]"),
          errorPattern: /app-server/,
        }),
      },
    ],
  },
});
