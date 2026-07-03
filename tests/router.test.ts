import { describe, expect, test } from "vitest";
import { createExecutors, pickExecutor } from "../src/executor/router.js";
import { DEFAULT_CONFIG } from "../src/constants.js";
import type { Executor, RouteRule, UltracodexConfig } from "../src/types.js";
import { ZERO_USAGE } from "../src/types.js";

function stub(backend: string): Executor {
  return { backend, run: async () => ({ ok: true, text: backend, usage: ZERO_USAGE }) };
}

function cfgWithRoute(route: RouteRule[]): UltracodexConfig {
  return { ...DEFAULT_CONFIG, route };
}

describe("pickExecutor", () => {
  const executors: Record<string, Executor> = { codex: stub("codex"), claude: stub("claude") };

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
  test("returns codex + claude executors wired to config", () => {
    const executors = createExecutors(DEFAULT_CONFIG);
    expect(Object.keys(executors).sort()).toEqual(["claude", "codex"]);
    expect(executors["codex"]!.backend).toBe("codex");
    expect(executors["claude"]!.backend).toBe("claude");
    expect(typeof executors["codex"]!.run).toBe("function");
    expect(typeof executors["claude"]!.run).toBe("function");
  });

  test("createExecutors output feeds pickExecutor", () => {
    const executors = createExecutors(DEFAULT_CONFIG);
    // DEFAULT_CONFIG routes everything to codex
    expect(pickExecutor(executors, DEFAULT_CONFIG, "anything", "Any phase").backend).toBe("codex");
  });
});
