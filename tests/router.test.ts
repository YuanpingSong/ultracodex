import { describe, expect, test } from "vitest";
import {
  createExecutorRegistry,
  createExecutors,
  executorDegradationWarnings,
  pickExecutor,
  validateCapabilityDescriptor,
} from "../src/executor/router.js";
import { DEFAULT_CONFIG } from "../src/constants.js";
import type {
  CapabilityDescriptor,
  Executor,
  RouteRule,
  UltracodexConfig,
} from "../src/types.js";
import { ZERO_USAGE } from "../src/types.js";

const CAPABILITIES: CapabilityDescriptor = {
  schema: "prompt-only",
  resume: false,
  interrupt: "kill-only",
  usage: "final",
  activity: false,
  sandbox: [],
};

function stub(backend: string): Executor {
  return {
    backend,
    capabilities: CAPABILITIES,
    run: async () => ({ ok: true, text: backend, usage: ZERO_USAGE }),
  };
}

function cfgWithRoute(route: RouteRule[]): UltracodexConfig {
  return { ...DEFAULT_CONFIG, route };
}

describe("pickExecutor", () => {
  const executors: Record<string, Executor> = {
    codex: stub("codex"),
    claude: stub("claude"),
    opencode: stub("opencode"),
  };

  test("routes by label, first match wins", () => {
    const config = cfgWithRoute([
      { pattern: "critique*", backend: "claude" },
      { pattern: "*", backend: "codex" },
    ]);
    expect(pickExecutor(executors, config, "critique: draft 1", null).backend).toBe("claude");
    expect(pickExecutor(executors, config, "writer", null).backend).toBe("codex");
  });

  test("falls back to phase matching when no label rule matches", () => {
    const config = cfgWithRoute([{ pattern: "Verify*", backend: "claude" }]);
    expect(pickExecutor(executors, config, "agent-7", "Verify results").backend).toBe("claude");
  });

  test("defaults to codex when nothing matches", () => {
    const config = cfgWithRoute([{ pattern: "special", backend: "claude" }]);
    expect(pickExecutor(executors, config, "agent-7", null).backend).toBe("codex");
  });

  test("unknown backend → throws with the backend name and label", () => {
    const config = cfgWithRoute([{ pattern: "*", backend: "gemini" }]);
    expect(() => pickExecutor(executors, config, "writer", null)).toThrow(
      /unknown backend "gemini".*writer|writer.*unknown backend "gemini"/,
    );
  });
});

describe("createExecutors", () => {
  test("returns codex + claude + opencode executors wired to config", () => {
    const { executors, warnings } = createExecutors(DEFAULT_CONFIG);
    expect(Object.keys(executors).sort()).toEqual(["claude", "codex", "opencode"]);
    expect(executors["codex"]!.backend).toBe("codex");
    expect(executors["claude"]!.backend).toBe("claude");
    expect(executors["opencode"]!.backend).toBe("opencode");
    expect(executors["codex"]!.capabilities.schema).toBe("wire");
    expect(executors["claude"]!.capabilities.schema).toBe("prompt-only");
    expect(executors["opencode"]!.capabilities).toEqual({
      schema: "wire",
      resume: true,
      interrupt: "graceful",
      usage: "per-turn",
      activity: true,
      sandbox: [],
    });
    expect(typeof executors["codex"]!.run).toBe("function");
    expect(typeof executors["claude"]!.run).toBe("function");
    expect(typeof executors["opencode"]!.run).toBe("function");
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/backend "claude" cannot honor profile "Explore" sandbox="read-only"/),
        expect.stringMatching(/backend "claude" cannot honor profile "Plan" sandbox="read-only"/),
        expect.stringMatching(/backend "opencode" cannot honor profile "Explore" sandbox="read-only"/),
        expect.stringMatching(/backend "opencode" cannot honor profile "Plan" sandbox="read-only"/),
      ]),
    );
  });

  test("createExecutors output feeds pickExecutor", () => {
    const { executors } = createExecutors(DEFAULT_CONFIG);
    // DEFAULT_CONFIG routes everything to codex
    expect(pickExecutor(executors, DEFAULT_CONFIG, "anything", "Any phase").backend).toBe("codex");
    expect(
      pickExecutor(
        executors,
        { ...DEFAULT_CONFIG, route: [{ pattern: "*", backend: "opencode" }] },
        "anything",
        "Any phase",
      ).backend,
    ).toBe("opencode");
  });

  test("validates capability descriptors and rejects duplicate backend keys", () => {
    expect(() => validateCapabilityDescriptor(stub("ok"))).not.toThrow();
    expect(() =>
      validateCapabilityDescriptor({
        ...stub("bad"),
        capabilities: { ...CAPABILITIES, usage: "streaming" as never },
      }),
    ).toThrow(/usage must/);
    expect(() => createExecutorRegistry([stub("same"), stub("same")])).toThrow(/duplicate/);
  });

  test("computes degradation warnings for unsupported profiles and usage blind spots", () => {
    const none = { ...stub("none"), capabilities: { ...CAPABILITIES, usage: "none" as const } };
    const warnings = executorDegradationWarnings(
      { none },
      { Strict: { sandbox: "sealed", networkAccess: false } },
      true,
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/cannot honor profile "Strict" sandbox="sealed"/),
        expect.stringMatching(/cannot honor profile "Strict" networkAccess=false/),
        expect.stringMatching(/declares no usage reporting/),
      ]),
    );
  });
});
