import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CLAUDE_CONFIG } from "../../src/constants.js";
import { ClaudeExecutor } from "../../src/executor/claude.js";
import { executorDegradationWarnings } from "../../src/executor/router.js";
import type { AgentProfileConfig, ClaudeBackendConfig, Usage } from "../../src/types.js";
import type { ExecutorRequest } from "../../src/executor/contract.js";
import { registerExecutorKit, type ExecutorKitHarness, type ExecutorKitStage } from "./kit.js";

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fake-claude", "claude");
const PROFILE_MARKER = "KIT_CLAUDE_PROFILE_PREAMBLE";

const PROFILES: Record<string, AgentProfileConfig> = {
  KitProfile: { sandbox: "read-only", preamble: PROFILE_MARKER },
};

const UNSUPPORTED_PROFILES: Record<string, AgentProfileConfig> = {
  UnsupportedKit: { sandbox: "sealed" },
};

const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
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

function cfg(overrides: Partial<ClaudeBackendConfig> = {}): ClaudeBackendConfig {
  return { ...DEFAULT_CLAUDE_CONFIG, binary: FAKE_CLAUDE, ...overrides };
}

function makeExecutor(overrides?: Partial<ClaudeBackendConfig>): ClaudeExecutor {
  return new ClaudeExecutor(cfg(overrides), PROFILES);
}

function request(h: ExecutorKitHarness, label: string, prompt: string, schema?: Record<string, unknown>): ExecutorRequest {
  const req: ExecutorRequest = { prompt, cwd: h.tmpDir(), label };
  if (schema) req.schema = schema;
  return req;
}

function cleanupPidFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const pid = Number(fs.readFileSync(filePath, "utf8"));
  if (pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
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

function withFakeEnv(
  h: ExecutorKitHarness,
  stage: ExecutorKitStage,
  vars: Record<string, string> = {},
): ExecutorKitStage {
  return withEnv(
    {
      FAKE_CLAUDE_INVOCATIONS: path.join(h.tmpDir("ultracodex-kit-claude-log-"), "invocations.jsonl"),
      ...vars,
    },
    stage,
  );
}

function repairAlwaysInvalid(h: ExecutorKitHarness): ExecutorKitStage {
  return withFakeEnv(h, {
    request: request(h, "retry-exhaustion", "compute [[nosession]] [[always-invalid]]", ANSWER_SCHEMA),
    errorPattern: /schema validation failed.*no JSON object or array found/s,
  });
}

function harnessFailure(h: ExecutorKitHarness): ExecutorKitStage {
  return withFakeEnv(h, {
    request: request(h, "harness-failure", "[[fail:harness boom]]"),
    errorPattern: /harness boom/,
  });
}

function abortHang(h: ExecutorKitHarness): ExecutorKitStage {
  const pidFile = path.join(h.tmpDir("ultracodex-kit-claude-pids-"), "child.pid");
  return withFakeEnv(
    h,
    {
      request: request(h, "abort-hang", "[[hang]]"),
      abortAfterMs: 100,
      orphanPidFile: pidFile,
      errorPattern: /interrupted/,
      cleanup: () => cleanupPidFile(pidFile),
    },
    { FAKE_CLAUDE_ORPHAN_CHILD: "1", FAKE_CLAUDE_CHILD_PID_FILE: pidFile },
  );
}

function midTurnCrash(h: ExecutorKitHarness): ExecutorKitStage {
  return withFakeEnv(h, {
    request: request(h, "mid-turn-crash", "[[crash-mid-call]]"),
    errorPattern: /crashed mid-call|without valid JSON output/,
  });
}

registerExecutorKit({
  name: "claude",
  makeExecutor,
  stagers: {
    textSuccess: (h) =>
      withFakeEnv(h, {
        request: request(h, "text-success", "[[reply:hello from claude]]"),
        expectedText: "hello from claude",
      }),
    schemaOptional: (h) =>
      withFakeEnv(h, {
        request: request(h, "schema-optional", '[[reply:{"done":true}]]', OPTIONAL_SCHEMA),
        expectedObject: { done: true },
      }),
    schemaMapFallback: (h) =>
      withFakeEnv(h, {
        request: request(h, "schema-map", '[[reply:{"counts":{"x":1,"y":2}}]]', MAP_SCHEMA),
        expectedObject: { counts: { x: 1, y: 2 } },
      }),
    repairInvalidThenValid: (h) =>
      withFakeEnv(h, {
        request: request(h, "schema-repair", "compute [[invalid-first]]", ANSWER_SCHEMA),
        expectedObject: { answer: "42" },
      }),
    repairAlwaysInvalid,
    harnessFailure,
    abortHang,
    midTurnCrash,
    usageTicks: (h) =>
      withFakeEnv(h, {
        request: request(h, "usage", "[[usage:150,15,0]] [[reply:metered]]"),
        expectedText: "metered",
        expectedUsage: METERED_USAGE,
      }),
    sessionId: (h) =>
      withFakeEnv(h, {
        request: request(h, "session-id", "[[reply:threaded]]"),
        expectedText: "threaded",
      }),
    profileApplication: (h) =>
      withFakeEnv(h, {
        request: {
          ...request(h, "profile", `[[expect-prompt:${PROFILE_MARKER}]] [[reply:profiled]]`),
          agentProfile: "KitProfile",
        },
        expectedText: "profiled",
        warnings: () => executorDegradationWarnings({ claude: makeExecutor() }, UNSUPPORTED_PROFILES, false),
        expectedWarnings: [/backend "claude" cannot honor profile "UnsupportedKit" sandbox="sealed"/],
      }),
    failures: [
      { name: "schema retry exhaustion", stage: repairAlwaysInvalid },
      { name: "harness failure", stage: harnessFailure },
      { name: "abort hang", stage: abortHang },
      { name: "mid-turn crash", stage: midTurnCrash },
      {
        name: "garbage stdout",
        stage: (h) =>
          withFakeEnv(h, {
            request: request(h, "garbage-stdout", "[[garbage]]"),
            errorPattern: /without valid JSON output/,
          }),
      },
      {
        name: "empty stderr exit",
        stage: (h) =>
          withFakeEnv(h, {
            request: request(h, "empty-stderr", "[[empty-error:stderr boom]]"),
            errorPattern: /stderr boom/,
          }),
      },
      {
        name: "missing result",
        stage: (h) =>
          withFakeEnv(h, {
            request: request(h, "missing-result", "[[missing-result]]"),
            errorPattern: /claude call failed.*success/,
          }),
      },
      {
        name: "bad subtype",
        stage: (h) =>
          withFakeEnv(h, {
            request: request(h, "bad-subtype", "[[bad-subtype:rate_limited]]"),
            errorPattern: /rate_limited/,
          }),
      },
      {
        name: "spawn failure",
        stage: (h) =>
          withFakeEnv(h, {
            executor: makeExecutor({ binary: "/nonexistent/definitely-not-claude" }),
            request: request(h, "spawn-failure", "[[reply:unreachable]]"),
            errorPattern: /failed to spawn|ENOENT/,
          }),
      },
    ],
  },
});
