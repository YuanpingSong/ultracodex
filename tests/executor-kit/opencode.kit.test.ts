import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OPENCODE_CONFIG } from "../../src/constants.js";
import { OpencodeExecutor } from "../../src/executor/opencode.js";
import { executorDegradationWarnings } from "../../src/executor/router.js";
import type { AgentProfileConfig, OpencodeBackendConfig, Usage } from "../../src/types.js";
import type { ExecutorRequest } from "../../src/executor/contract.js";
import { registerExecutorKit, type ExecutorKitHarness, type ExecutorKitStage } from "./kit.js";

const FAKE_OPENCODE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fake-opencode", "opencode");
const PROFILE_MARKER = "KIT_OPENCODE_PROFILE_PREAMBLE";

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

function cfg(overrides: Partial<OpencodeBackendConfig> = {}): OpencodeBackendConfig {
  return { ...DEFAULT_OPENCODE_CONFIG, binary: FAKE_OPENCODE, ...overrides };
}

function makeExecutor(overrides?: Partial<OpencodeBackendConfig>): OpencodeExecutor {
  return new OpencodeExecutor(cfg(overrides), PROFILES);
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

function withFakeEnv(
  h: ExecutorKitHarness,
  stage: ExecutorKitStage,
  vars: Record<string, string> = {},
): ExecutorKitStage {
  return withEnv(
    {
      FAKE_OPENCODE_INVOCATIONS: path.join(h.tmpDir("ultracodex-kit-opencode-log-"), "invocations.jsonl"),
      FAKE_OPENCODE_STDIO_HTTP: "1",
      ...vars,
    },
    stage,
  );
}

function writePidWrapper(h: ExecutorKitHarness, pidFile: string): string {
  const wrapper = path.join(h.tmpDir("ultracodex-kit-opencode-wrapper-"), "opencode");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nprintf "%s" "$$" > "$FAKE_OPENCODE_PID_FILE"\nexec ${JSON.stringify(FAKE_OPENCODE)} "$@"\n`,
  );
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

function repairAlwaysInvalid(h: ExecutorKitHarness): ExecutorKitStage {
  return withFakeEnv(h, {
    request: request(h, "retry-exhaustion", '[[always-invalid]] [[structured:{"a":1}]]', NUMBER_SCHEMA),
    errorPattern: /schema validation failed.*required property 'a'/s,
  });
}

function harnessFailure(h: ExecutorKitHarness): ExecutorKitStage {
  return withFakeEnv(h, {
    request: request(h, "harness-failure", "[[api-error]]"),
    errorPattern: /APIError: Fake API error/,
  });
}

function abortHang(h: ExecutorKitHarness): ExecutorKitStage {
  const pidFile = path.join(h.tmpDir("ultracodex-kit-opencode-pids-"), "child.pid");
  return withFakeEnv(
    h,
    {
      executor: new OpencodeExecutor(cfg({ binary: writePidWrapper(h, pidFile) }), PROFILES),
      request: request(h, "abort-hang", "[[hang]]"),
      abortAfterMs: 100,
      orphanPidFile: pidFile,
      errorPattern: /interrupted/,
    },
    { FAKE_OPENCODE_PID_FILE: pidFile },
  );
}

function midTurnCrash(h: ExecutorKitHarness): ExecutorKitStage {
  return withFakeEnv(h, {
    request: request(h, "mid-turn-crash", "[[crash-mid-turn]]"),
    errorPattern: /opencode serve exited/,
  });
}

function announceTimeout(h: ExecutorKitHarness): ExecutorKitStage {
  const bin = path.join(h.tmpDir("ultracodex-kit-opencode-stall-"), "opencode");
  fs.writeFileSync(bin, "#!/bin/sh\nsleep 30\n");
  fs.chmodSync(bin, 0o755);
  return withEnv(
    { ULTRACODEX_OPENCODE_START_TIMEOUT_MS: "100" },
    {
      executor: makeExecutor({ binary: bin }),
      request: request(h, "announce-timeout", "[[reply:never]]"),
      errorPattern: /OpencodeStartupTimeout/,
    },
  );
}

registerExecutorKit({
  name: "opencode",
  makeExecutor,
  stagers: {
    textSuccess: (h) =>
      withFakeEnv(h, {
        request: request(h, "text-success", "[[reply:hello from opencode]]"),
        expectedText: "hello from opencode",
      }),
    schemaOptional: (h) =>
      withFakeEnv(h, {
        request: request(h, "schema-optional", '[[structured:{"done":true}]]', OPTIONAL_SCHEMA),
        expectedObject: { done: true },
      }),
    schemaMapFallback: (h) =>
      withFakeEnv(h, {
        request: request(h, "schema-map", '[[structured:{"counts":{"x":1,"y":2}}]]', MAP_SCHEMA),
        expectedObject: { counts: { x: 1, y: 2 } },
      }),
    repairInvalidThenValid: (h) =>
      withFakeEnv(h, {
        request: request(
          h,
          "schema-repair",
          '[[invalid-first]] [[structured:{"a":1}]] [[structured2:{"a":2}]]',
          NUMBER_SCHEMA,
        ),
        expectedObject: { a: 2 },
      }),
    repairAlwaysInvalid,
    harnessFailure,
    abortHang,
    midTurnCrash,
    usageTicks: (h) =>
      withFakeEnv(h, {
        request: request(h, "usage", "[[usage:150,15]] [[reply:metered]]"),
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
          ...request(h, "profile", `[[expect-system:${PROFILE_MARKER}]] [[reply:profiled]]`),
          agentProfile: "KitProfile",
        },
        expectedText: "profiled",
        warnings: () => executorDegradationWarnings({ opencode: makeExecutor() }, UNSUPPORTED_PROFILES, false),
        expectedWarnings: [/backend "opencode" cannot honor profile "UnsupportedKit" sandbox="sealed"/],
      }),
    wireSchemaRejection: (h) =>
      withFakeEnv(h, {
        executor: makeExecutor({ schemaRetries: 0 }),
        request: request(h, "wire-rejection", '[[wire-reject]] [[structured:{"a":4}]]', NUMBER_SCHEMA),
        expectedObject: { a: 4 },
      }),
    failures: [
      { name: "schema retry exhaustion", stage: repairAlwaysInvalid },
      { name: "harness failure", stage: harnessFailure },
      { name: "abort hang", stage: abortHang },
      { name: "mid-turn crash", stage: midTurnCrash },
      { name: "announce timeout", stage: announceTimeout },
      {
        name: "garbage body",
        stage: (h) =>
          withFakeEnv(h, {
            request: request(h, "garbage", "[[garbage]]"),
            errorPattern: /invalid JSON response body/,
          }),
      },
      {
        name: "spawn failure",
        stage: (h) => ({
          executor: makeExecutor({ binary: "/nonexistent/definitely-not-opencode" }),
          request: request(h, "spawn-failure", "[[reply:unreachable]]"),
          errorPattern: /ENOENT|spawn/,
        }),
      },
    ],
  },
});
