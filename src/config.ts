import { parse } from "smol-toml";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_CONFIG,
  DEFAULT_CODEX_CONFIG,
  DEFAULT_CLAUDE_CONFIG,
  DEFAULT_OPENCODE_CONFIG,
  STATE_DIR_NAME,
} from "./constants.js";
import type {
  UltracodexConfig,
  RouteRule,
  CodexBackendConfig,
  ClaudeBackendConfig,
  OpencodeBackendConfig,
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
  if (Array.isArray(raw["extra_args"]) && raw["extra_args"].every((a) => typeof a === "string"))
    result.extraArgs = raw["extra_args"] as string[];
  if (typeof raw["network_access"] === "boolean")
    result.networkAccess = raw["network_access"];
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
  if (Array.isArray(raw["extra_args"]) && raw["extra_args"].every((a) => typeof a === "string"))
    result.extraArgs = raw["extra_args"] as string[];
  if (raw["model_map"] !== null && typeof raw["model_map"] === "object") {
    result.modelMap = {
      ...base.modelMap,
      ...(raw["model_map"] as Record<string, string>),
    };
  }
  return result;
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function opencodeConfigError(field: string, detail: string): never {
  throw new Error(`[backends.opencode].${field} ${detail}`);
}

function expectString(raw: Record<string, unknown>, key: string): string | undefined {
  if (!hasOwn(raw, key)) return undefined;
  const value = raw[key];
  if (typeof value !== "string") opencodeConfigError(key, "must be a string");
  if (value.length === 0) opencodeConfigError(key, "must not be empty");
  return value;
}

function expectStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
  if (!hasOwn(raw, key)) return undefined;
  const value = raw[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    opencodeConfigError(key, "must be an array of strings");
  return value;
}

function expectNonNegativeInteger(raw: Record<string, unknown>, key: string): number | undefined {
  if (!hasOwn(raw, key)) return undefined;
  const value = raw[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    opencodeConfigError(key, "must be a non-negative integer");
  return value;
}

function isProviderModel(value: string): boolean {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

function expectProviderModel(value: string, field: string): string {
  if (!isProviderModel(value))
    opencodeConfigError(field, "must be a provider/model string");
  return value;
}

function expectStringRecord(raw: Record<string, unknown>, key: string): Record<string, string> | undefined {
  if (!hasOwn(raw, key)) return undefined;
  const value = raw[key];
  if (!isTable(value)) opencodeConfigError(key, "must be a table of strings");
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") opencodeConfigError(`${key}.${k}`, "must be a string");
    if (v.length === 0) opencodeConfigError(`${key}.${k}`, "must not be empty");
    result[k] = v;
  }
  return result;
}

function mergeOpencodeConfig(
  base: OpencodeBackendConfig,
  raw: Record<string, unknown>,
): OpencodeBackendConfig {
  const result: OpencodeBackendConfig = { ...base };
  const binary = expectString(raw, "binary");
  if (binary !== undefined) result.binary = binary;
  const model = expectString(raw, "model");
  if (model !== undefined) result.model = expectProviderModel(model, "model");
  const schemaRetries = expectNonNegativeInteger(raw, "schema_retries");
  if (schemaRetries !== undefined) result.schemaRetries = schemaRetries;
  const extraArgs = expectStringArray(raw, "extra_args");
  if (extraArgs !== undefined) result.extraArgs = extraArgs;
  const modelMap = expectStringRecord(raw, "model_map");
  if (modelMap !== undefined) {
    for (const [tier, value] of Object.entries(modelMap)) {
      modelMap[tier] = expectProviderModel(value, `model_map.${tier}`);
    }
    result.modelMap = {
      ...base.modelMap,
      ...modelMap,
    };
  }
  const variantMap = expectStringRecord(raw, "variant_map");
  if (variantMap !== undefined) {
    result.variantMap = {
      ...base.variantMap,
      ...variantMap,
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
    if (b["opencode"] !== null && typeof b["opencode"] === "object") {
      result = {
        ...result,
        opencode: mergeOpencodeConfig(result.opencode, b["opencode"] as Record<string, unknown>),
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
        if (typeof v["network_access"] === "boolean") profile.networkAccess = v["network_access"];
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
    opencode: {
      ...DEFAULT_OPENCODE_CONFIG,
      modelMap: { ...DEFAULT_OPENCODE_CONFIG.modelMap },
      variantMap: { ...DEFAULT_OPENCODE_CONFIG.variantMap },
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

/**
 * Single source of truth for tier→model/effort resolution, shared by the
 * runtime (journaling: agent_start must record what will actually run) and
 * the executors (the actual call). Journal and reality cannot drift.
 */
export function resolveCodexModel(cfg: CodexBackendConfig, tier: string | undefined): string {
  return tier ? (cfg.modelMap[tier] ?? tier) : cfg.defaultModel;
}

export function resolveCodexEffort(cfg: CodexBackendConfig, effort: string | undefined): string | null {
  return effort ? (cfg.effortMap[effort] ?? effort) : cfg.defaultEffort;
}

export function resolveClaudeModel(cfg: ClaudeBackendConfig, tier: string | undefined): string {
  return tier ? (cfg.modelMap[tier] ?? tier) : cfg.defaultModel;
}

export function resolveOpencodeModel(cfg: OpencodeBackendConfig, tier: string | undefined): string {
  return tier ? (cfg.modelMap[tier] ?? tier) : cfg.model;
}

export function resolveOpencodeEffort(cfg: OpencodeBackendConfig, effort: string | undefined): string | null {
  return effort ? (cfg.variantMap[effort] ?? null) : null;
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
