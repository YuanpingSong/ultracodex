import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, matchGlob, routeBackend } from "../src/config.js";
import { DEFAULT_CONFIG, DEFAULT_CODEX_CONFIG, DEFAULT_CLAUDE_CONFIG } from "../src/constants.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "uc-config-test-"));
}

function writeToml(dir: string, content: string): void {
  const configDir = path.join(dir, ".ultracodex");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.toml"), content);
}

function makeGlobalDir(content: string): string {
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, "config.toml"), content);
  return dir;
}

// ---------------------------------------------------------------------------
// loadConfig — defaults
// ---------------------------------------------------------------------------

describe("loadConfig — defaults when no files", () => {
  it("returns default route, concurrency, codex and claude configs", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    const cfg = loadConfig(projectDir, { globalDir });

    expect(cfg.route).toEqual(DEFAULT_CONFIG.route);
    expect(cfg.concurrency).toBe(null);
    expect(cfg.codex.binary).toBe(DEFAULT_CODEX_CONFIG.binary);
    expect(cfg.codex.defaultModel).toBe(DEFAULT_CODEX_CONFIG.defaultModel);
    expect(cfg.codex.schemaRetries).toBe(DEFAULT_CODEX_CONFIG.schemaRetries);
    expect(cfg.codex.modelMap).toEqual(DEFAULT_CODEX_CONFIG.modelMap);
    expect(cfg.codex.effortMap).toEqual(DEFAULT_CODEX_CONFIG.effortMap);
    expect(cfg.claude.binary).toBe(DEFAULT_CLAUDE_CONFIG.binary);
    expect(cfg.claude.defaultModel).toBe(DEFAULT_CLAUDE_CONFIG.defaultModel);
    expect(cfg.profiles).toMatchObject(DEFAULT_CONFIG.profiles);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — global override
// ---------------------------------------------------------------------------

describe("loadConfig — global overrides", () => {
  it("applies concurrency from global config", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir("[run]\nconcurrency = 4");
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.concurrency).toBe(4);
  });

  it("applies binary override from global config", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir('[backends.codex]\nbinary = "my-codex"');
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.codex.binary).toBe("my-codex");
  });

  it("global [route] replaces the default route", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir('[route]\n"plan:*" = "claude"\n"*" = "codex"');
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.route).toEqual([
      { pattern: "plan:*", backend: "claude" },
      { pattern: "*", backend: "codex" },
    ]);
  });

  it("ignores unknown keys without error", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir(
      'nonsense = "x"\n[weird_table]\nfoo = 1\n[backends.codex]\nunknown_field = true',
    );
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.codex.binary).toBe(DEFAULT_CODEX_CONFIG.binary);
  });

  it("throws on malformed TOML with the file path in the message", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir("[route\nbroken");
    expect(() => loadConfig(projectDir, { globalDir })).toThrow(/config\.toml/);
  });

  it("mutating a loaded config does not leak into subsequent loads", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    const cfg1 = loadConfig(projectDir, { globalDir });
    cfg1.codex.modelMap["opus"] = "tampered";
    cfg1.route.push({ pattern: "x", backend: "y" });
    const cfg2 = loadConfig(projectDir, { globalDir });
    expect(cfg2.codex.modelMap["opus"]).toBe(DEFAULT_CODEX_CONFIG.modelMap["opus"]);
    expect(cfg2.route).toEqual(DEFAULT_CONFIG.route);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — project overrides
// ---------------------------------------------------------------------------

describe("loadConfig — project overrides", () => {
  it("project config overrides global config", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir("[run]\nconcurrency = 4");
    writeToml(projectDir, "[run]\nconcurrency = 12");
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.concurrency).toBe(12);
  });

  it("project backends.codex overrides snake_case fields", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    writeToml(
      projectDir,
      '[backends.codex]\nbinary = "mycodex"\ndefault_model = "gpt-5.5"\nschema_retries = 5\nsandbox = "read-only"',
    );
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.codex.binary).toBe("mycodex");
    expect(cfg.codex.defaultModel).toBe("gpt-5.5");
    expect(cfg.codex.schemaRetries).toBe(5);
    expect(cfg.codex.sandbox).toBe("read-only");
  });

  it("project backends.claude overrides snake_case fields", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    writeToml(
      projectDir,
      '[backends.claude]\nbinary = "myclaud"\ndefault_model = "opus"\nschema_retries = 2',
    );
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.claude.binary).toBe("myclaud");
    expect(cfg.claude.defaultModel).toBe("opus");
    expect(cfg.claude.schemaRetries).toBe(2);
  });

  it("profiles are added from project config", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    writeToml(
      projectDir,
      '[profiles.Critique]\nsandbox = "read-only"\npreamble = "Be critical."',
    );
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.profiles["Critique"]).toEqual({
      sandbox: "read-only",
      preamble: "Be critical.",
    });
    // Default profiles still present
    expect(cfg.profiles["Explore"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// loadConfig — snake_case model_map / effort_map per-key merge
// ---------------------------------------------------------------------------

describe("loadConfig — model_map and effort_map per-key merge", () => {
  it("merges model_map keys from global (not replace)", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir(
      '[backends.codex]\nmodel_map = { opus = "gpt-5.5-override" }',
    );
    const cfg = loadConfig(projectDir, { globalDir });
    // opus overridden, sonnet still default
    expect(cfg.codex.modelMap["opus"]).toBe("gpt-5.5-override");
    expect(cfg.codex.modelMap["sonnet"]).toBe(DEFAULT_CODEX_CONFIG.modelMap["sonnet"]);
  });

  it("project model_map merges over global model_map", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir(
      '[backends.codex]\nmodel_map = { opus = "gpt-global" }',
    );
    writeToml(projectDir, '[backends.codex]\nmodel_map = { sonnet = "gpt-project" }');
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.codex.modelMap["opus"]).toBe("gpt-global");
    expect(cfg.codex.modelMap["sonnet"]).toBe("gpt-project");
    // haiku still default
    expect(cfg.codex.modelMap["haiku"]).toBe(DEFAULT_CODEX_CONFIG.modelMap["haiku"]);
  });

  it("project effort_map keys merge over defaults", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    writeToml(projectDir, '[backends.codex]\neffort_map = { max = "high" }');
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.codex.effortMap["max"]).toBe("high");
    expect(cfg.codex.effortMap["low"]).toBe(DEFAULT_CODEX_CONFIG.effortMap["low"]);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — route table
// ---------------------------------------------------------------------------

describe("loadConfig — route table", () => {
  it("project route REPLACES default route entirely", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    writeToml(projectDir, '[route]\n"critique:*" = "claude"\n"*" = "codex"');
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.route).toEqual([
      { pattern: "critique:*", backend: "claude" },
      { pattern: "*", backend: "codex" },
    ]);
  });

  it("route without catch-all gets a trailing * fallback appended", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    writeToml(projectDir, '[route]\n"critique:*" = "claude"');
    const cfg = loadConfig(projectDir, { globalDir });
    const last = cfg.route[cfg.route.length - 1];
    expect(last).toEqual({ pattern: "*", backend: "codex" });
    // Original rule preserved
    expect(cfg.route[0]).toEqual({ pattern: "critique:*", backend: "claude" });
  });

  it("route preserves file order", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeTmpDir();
    writeToml(
      projectDir,
      '[route]\n"critique:*" = "claude"\n"plan:*" = "claude"\n"*" = "codex"',
    );
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.route.map((r) => r.pattern)).toEqual([
      "critique:*",
      "plan:*",
      "*",
    ]);
  });

  it("project route replaces global route entirely (not merged)", () => {
    const projectDir = makeTmpDir();
    const globalDir = makeGlobalDir('[route]\n"plan:*" = "claude"\n"*" = "claude"');
    writeToml(projectDir, '[route]\n"critique:*" = "claude"');
    const cfg = loadConfig(projectDir, { globalDir });
    expect(cfg.route).toEqual([
      { pattern: "critique:*", backend: "claude" },
      { pattern: "*", backend: "codex" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// matchGlob
// ---------------------------------------------------------------------------

describe("matchGlob", () => {
  it("'*' matches any string including empty", () => {
    expect(matchGlob("*", "")).toBe(true);
    expect(matchGlob("*", "anything")).toBe(true);
    expect(matchGlob("*", "critique:foo")).toBe(true);
  });

  it("exact pattern without wildcard matches only itself", () => {
    expect(matchGlob("foo", "foo")).toBe(true);
    expect(matchGlob("foo", "foobar")).toBe(false);
    expect(matchGlob("foo", "bar")).toBe(false);
  });

  it("'critique:*' matches critique:x but not critique alone", () => {
    expect(matchGlob("critique:*", "critique:x")).toBe(true);
    expect(matchGlob("critique:*", "critique:anything")).toBe(true);
    expect(matchGlob("critique:*", "critique:")).toBe(true); // empty after colon
    expect(matchGlob("critique:*", "critique")).toBe(false);
    expect(matchGlob("critique:*", "notcritique:x")).toBe(false);
  });

  it("wildcard in middle", () => {
    expect(matchGlob("a*b", "ab")).toBe(true);
    expect(matchGlob("a*b", "aXb")).toBe(true);
    expect(matchGlob("a*b", "aXYb")).toBe(true);
    expect(matchGlob("a*b", "a")).toBe(false);
    expect(matchGlob("a*b", "b")).toBe(false);
  });

  it("escapes regex special chars in pattern", () => {
    expect(matchGlob("a.b", "a.b")).toBe(true);
    expect(matchGlob("a.b", "axb")).toBe(false); // '.' is literal
    expect(matchGlob("a+b", "a+b")).toBe(true);
    expect(matchGlob("a+b", "ab")).toBe(false);
    expect(matchGlob("a?b", "a?b")).toBe(true);
    expect(matchGlob("a?b", "ab")).toBe(false); // '?' is literal, not optional
    expect(matchGlob("a(b)c", "a(b)c")).toBe(true);
    expect(matchGlob("a[b]c", "a[b]c")).toBe(true);
    expect(matchGlob("a$b^c", "a$b^c")).toBe(true);
  });

  it("case-sensitive", () => {
    expect(matchGlob("Foo", "foo")).toBe(false);
    expect(matchGlob("foo", "Foo")).toBe(false);
    expect(matchGlob("FOO", "FOO")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// routeBackend
// ---------------------------------------------------------------------------

describe("routeBackend", () => {
  it("returns 'codex' when only default route", () => {
    expect(routeBackend(DEFAULT_CONFIG, "anything", null)).toBe("codex");
  });

  it("label matched before phase (label wins even if phase matches earlier rule)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      route: [
        { pattern: "critique:*", backend: "claude" },
        { pattern: "Critique", backend: "special" },
        { pattern: "*", backend: "codex" },
      ],
    };
    // label "critique:foo" matches first rule
    expect(routeBackend(cfg, "critique:foo", "Critique")).toBe("claude");
  });

  it("label takes precedence; no label match falls through to phase", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      route: [
        { pattern: "critique:*", backend: "claude" },
        { pattern: "*", backend: "codex" },
      ],
    };
    // label "summarize" doesn't match "critique:*", matches "*"
    expect(routeBackend(cfg, "summarize", "Critique")).toBe("codex");
  });

  it("phase rules are reachable despite the '*' catch-all (catch-all is the final fallback)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      route: [
        { pattern: "Critique", backend: "claude" },
        { pattern: "*", backend: "codex" },
      ],
    };
    // label "summarize" doesn't match "Critique"; the "*" catch-all must NOT
    // swallow the label pass — the phase pass runs and "Critique" fires.
    expect(routeBackend(cfg, "summarize", "Critique")).toBe("claude");
    // no phase → both passes miss → catch-all fallback
    expect(routeBackend(cfg, "summarize", null)).toBe("codex");
    // phase matches nothing specific → catch-all fallback
    expect(routeBackend(cfg, "summarize", "Draft")).toBe("codex");
  });

  it("phase fallback used when no rule matches label (no catch-all before phase test)", () => {
    // Craft a route with no catch-all to force phase testing
    const cfg: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      route: [
        { pattern: "critique:*", backend: "claude" },
        // No "*" catch-all before phase test - but we always add one in parsing
        // So let's test the phase-matching branch by providing a config directly
        { pattern: "Critique", backend: "special-phase" },
      ],
    };
    // label "summarize" doesn't match "critique:*" or "Critique"
    // phase "Critique" matches second rule
    expect(routeBackend(cfg, "summarize", "Critique")).toBe("special-phase");
  });

  it("phase null → no phase matching attempted", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      route: [
        { pattern: "Critique", backend: "claude" },
        { pattern: "*", backend: "codex" },
      ],
    };
    expect(routeBackend(cfg, "summarize", null)).toBe("codex");
  });

  it("bare '*' in route catches everything via label", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      route: [{ pattern: "*", backend: "mybackend" }],
    };
    expect(routeBackend(cfg, "anything", "any-phase")).toBe("mybackend");
  });

  it("first matching rule wins (label ordering)", () => {
    const cfg = {
      ...DEFAULT_CONFIG,
      route: [
        { pattern: "critique:*", backend: "claude" },
        { pattern: "critique:important", backend: "codex" }, // would match but never reached
        { pattern: "*", backend: "codex" },
      ],
    };
    expect(routeBackend(cfg, "critique:important", null)).toBe("claude");
  });

  it("default 'codex' returned when no rules match at all", () => {
    const cfg: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      route: [{ pattern: "only-this", backend: "special" }],
    };
    expect(routeBackend(cfg, "other", null)).toBe("codex");
    expect(routeBackend(cfg, "other", "also-other")).toBe("codex");
  });
});
