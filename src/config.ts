import { parse } from "smol-toml";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_CONFIG,
  DEFAULT_CODEX_CONFIG,
  DEFAULT_CLAUDE_CONFIG,
  STATE_DIR_NAME,
} from "./constants.js";
import type {
  UltracodexConfig,
  RouteRule,
  CodexBackendConfig,
  ClaudeBackendConfig,
  AgentProfileConfig,
} from "./types.js";

export interface LoadConfigOpts {
  globalDir?: string;
}

function readToml(filePath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null; // missing/unreadable file → treated as absent
  }
  try {
    return parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `invalid TOML in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function mergeCodexConfig(
  base: CodexBackendConfig,
  raw: Record<string, unknown>,
): CodexBackendConfig {
  const result: CodexBackendConfig = { ...base };
  if (typeof raw["binary"] === "string") result.binary = raw["binary"];
  if (typeof raw["sandbox"] === "string")
    result.sandbox = raw["sandbox"] as CodexBackendConfig["sandbox"];
  if (typeof raw["default_model"] === "string")
    result.defaultModel = raw["default_model"];
  if (typeof raw["default_effort"] === "string")
    result.defaultEffort = raw["default_effort"];
  if (typeof raw["service_tier"] === "string")
    result.serviceTier = raw["service_tier"];
  if (typeof raw["schema_retries"] === "number")
    result.schemaRetries = raw["schema_retries"];
  if (raw["model_map"] !== null && typeof raw["model_map"] === "object") {
    result.modelMap = {
      ...base.modelMap,
      ...(raw["model_map"] as Record<string, string>),
    };
  }
  if (raw["effort_map"] !== null && typeof raw["effort_map"] === "object") {
    result.effortMap = {
      ...base.effortMap,
      ...(raw["effort_map"] as Record<string, string>),
    };
  }
  return result;
}

function mergeClaudeConfig(
  base: ClaudeBackendConfig,
  raw: Record<string, unknown>,
): ClaudeBackendConfig {
  const result: ClaudeBackendConfig = { ...base };
  if (typeof raw["binary"] === "string") result.binary = raw["binary"];
  if (typeof raw["default_model"] === "string")
    result.defaultModel = raw["default_model"];
  if (typeof raw["schema_retries"] === "number")
    result.schemaRetries = raw["schema_retries"];
  if (raw["model_map"] !== null && typeof raw["model_map"] === "object") {
    result.modelMap = {
      ...base.modelMap,
      ...(raw["model_map"] as Record<string, string>),
    };
  }
  return result;
}

function parseRouteTable(raw: Record<string, unknown>): RouteRule[] {
  const rules: RouteRule[] = Object.entries(raw).map(([pattern, backend]) => ({
    pattern,
    backend: String(backend),
  }));
  const hasCatchAll = rules.some((r) => r.pattern === "*");
  if (!hasCatchAll) {
    rules.push({ pattern: "*", backend: "codex" });
  }
  return rules;
}

function applyToml(cfg: UltracodexConfig, raw: Record<string, unknown>): UltracodexConfig {
  let result = { ...cfg };

  // [route] — project table REPLACES default route entirely
  if (raw["route"] !== null && typeof raw["route"] === "object") {
    result = {
      ...result,
      route: parseRouteTable(raw["route"] as Record<string, unknown>),
    };
  }

  // [run]
  if (raw["run"] !== null && typeof raw["run"] === "object") {
    const run = raw["run"] as Record<string, unknown>;
    if (typeof run["concurrency"] === "number") {
      result = { ...result, concurrency: run["concurrency"] };
    }
  }

  // [backends.codex]
  const backends = raw["backends"];
  if (backends !== null && typeof backends === "object") {
    const b = backends as Record<string, unknown>;
    if (b["codex"] !== null && typeof b["codex"] === "object") {
      result = {
        ...result,
        codex: mergeCodexConfig(result.codex, b["codex"] as Record<string, unknown>),
      };
    }
    if (b["claude"] !== null && typeof b["claude"] === "object") {
      result = {
        ...result,
        claude: mergeClaudeConfig(result.claude, b["claude"] as Record<string, unknown>),
      };
    }
  }

  // [profiles.<name>]
  if (raw["profiles"] !== null && typeof raw["profiles"] === "object") {
    const profiles: Record<string, AgentProfileConfig> = { ...result.profiles };
    for (const [name, val] of Object.entries(raw["profiles"] as Record<string, unknown>)) {
      if (val !== null && typeof val === "object") {
        const v = val as Record<string, unknown>;
        const profile: AgentProfileConfig = {};
        if (typeof v["sandbox"] === "string") profile.sandbox = v["sandbox"];
        if (typeof v["preamble"] === "string") profile.preamble = v["preamble"];
        profiles[name] = profile;
      }
    }
    result = { ...result, profiles };
  }

  return result;
}

export function loadConfig(
  projectDir: string,
  opts?: LoadConfigOpts,
): UltracodexConfig {
  const globalDir =
    opts?.globalDir ?? path.join(os.homedir(), STATE_DIR_NAME);
  const globalConfig = readToml(path.join(globalDir, "config.toml"));
  const projectConfig = readToml(
    path.join(projectDir, STATE_DIR_NAME, "config.toml"),
  );

  let cfg: UltracodexConfig = {
    ...DEFAULT_CONFIG,
    codex: {
      ...DEFAULT_CODEX_CONFIG,
      modelMap: { ...DEFAULT_CODEX_CONFIG.modelMap },
      effortMap: { ...DEFAULT_CODEX_CONFIG.effortMap },
    },
    claude: {
      ...DEFAULT_CLAUDE_CONFIG,
      modelMap: { ...DEFAULT_CLAUDE_CONFIG.modelMap },
    },
    profiles: { ...DEFAULT_CONFIG.profiles },
    route: [...DEFAULT_CONFIG.route],
  };

  if (globalConfig) {
    cfg = applyToml(cfg, globalConfig);
  }
  if (projectConfig) {
    cfg = applyToml(cfg, projectConfig);
  }

  return cfg;
}

export function matchGlob(pattern: string, value: string): boolean {
  // Escape all regex special chars except '*', which becomes '.*'
  const regexStr =
    "^" +
    pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*") +
    "$";
  return new RegExp(regexStr).test(value);
}

export function routeBackend(
  config: UltracodexConfig,
  label: string,
  phase: string | null,
): string {
  // Label is matched first against every specific rule in order, then phase.
  // The "*" catch-all is the FINAL fallback after both passes — otherwise it
  // would always match the label and phase rules would be unreachable.
  const specific = config.route.filter((r) => r.pattern !== "*");
  for (const rule of specific) {
    if (matchGlob(rule.pattern, label)) return rule.backend;
  }
  if (phase !== null) {
    for (const rule of specific) {
      if (matchGlob(rule.pattern, phase)) return rule.backend;
    }
  }
  const catchAll = config.route.find((r) => r.pattern === "*");
  return catchAll ? catchAll.backend : "codex";
}
