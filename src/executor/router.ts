import { routeBackend } from "../config.js";
import type { AgentProfileConfig, UltracodexConfig } from "../types.js";
import type { Executor } from "./contract.js";
import { CodexExecutor } from "./codex.js";
import { ClaudeExecutor } from "./claude.js";
import { OpencodeExecutor } from "./opencode.js";

export interface ExecutorRegistry {
  executors: Record<string, Executor>;
  warnings: string[];
}

export interface CreateExecutorsOpts {
  budgetSet?: boolean;
}

function badCapability(backend: string, detail: string): never {
  throw new Error(`backend "${backend}" has malformed capability descriptor: ${detail}`);
}

export function validateCapabilityDescriptor(executor: Executor): void {
  const backend =
    typeof executor.backend === "string" && executor.backend ? executor.backend : "<unknown>";
  const raw = (executor as { capabilities?: unknown }).capabilities;
  if (raw === null || typeof raw !== "object") badCapability(backend, "missing descriptor");
  const cap = raw as Record<string, unknown>;
  if (cap["schema"] !== "wire" && cap["schema"] !== "prompt-only")
    badCapability(backend, 'schema must be "wire" or "prompt-only"');
  if (typeof cap["resume"] !== "boolean")
    badCapability(backend, "resume must be boolean");
  if (cap["interrupt"] !== "graceful" && cap["interrupt"] !== "kill-only")
    badCapability(backend, 'interrupt must be "graceful" or "kill-only"');
  if (cap["usage"] !== "per-turn" && cap["usage"] !== "final" && cap["usage"] !== "none")
    badCapability(backend, 'usage must be "per-turn", "final", or "none"');
  if (typeof cap["activity"] !== "boolean")
    badCapability(backend, "activity must be boolean");
  if (
    !Array.isArray(cap["sandbox"]) ||
    !cap["sandbox"].every((s) => typeof s === "string")
  )
    badCapability(backend, "sandbox must be a string array");
}

export function createExecutorRegistry(
  executors: readonly Executor[],
): Record<string, Executor> {
  const registry: Record<string, Executor> = {};
  for (const executor of executors) {
    if (typeof executor.backend !== "string" || executor.backend.length === 0) {
      throw new Error("executor backend must be a non-empty string");
    }
    validateCapabilityDescriptor(executor);
    if (registry[executor.backend]) {
      throw new Error(`duplicate executor backend "${executor.backend}"`);
    }
    registry[executor.backend] = executor;
  }
  return registry;
}

function honorsNetworkAccess(executor: Executor): boolean {
  return executor.capabilities.sandbox.length > 0;
}

export function executorDegradationWarnings(
  executors: Record<string, Executor>,
  profiles: Record<string, AgentProfileConfig>,
  budgetSet: boolean,
): string[] {
  const warnings: string[] = [];
  for (const executor of Object.values(executors)) {
    for (const [profile, cfg] of Object.entries(profiles)) {
      if (
        cfg.sandbox !== undefined &&
        !executor.capabilities.sandbox.includes(cfg.sandbox)
      ) {
        warnings.push(
          `backend "${executor.backend}" cannot honor profile "${profile}" sandbox="${cfg.sandbox}"; passing through without sandbox enforcement`,
        );
      }
      if (cfg.networkAccess !== undefined && !honorsNetworkAccess(executor)) {
        warnings.push(
          `backend "${executor.backend}" cannot honor profile "${profile}" networkAccess=${cfg.networkAccess}; passing through without network enforcement`,
        );
      }
    }
    if (budgetSet && executor.capabilities.usage === "none") {
      warnings.push(
        `backend "${executor.backend}" declares no usage reporting; --budget cannot meter output tokens for it`,
      );
    }
  }
  return warnings;
}

export function createExecutors(
  config: UltracodexConfig,
  opts: CreateExecutorsOpts = {},
): ExecutorRegistry {
  const executors = createExecutorRegistry([
    new CodexExecutor(config.codex, config.profiles),
    new ClaudeExecutor(config.claude, config.profiles),
    new OpencodeExecutor(config.opencode, config.profiles),
  ]);
  return {
    executors,
    warnings: executorDegradationWarnings(
      executors,
      config.profiles,
      opts.budgetSet ?? false,
    ),
  };
}

export function pickExecutor(
  executors: Record<string, Executor>,
  config: UltracodexConfig,
  label: string,
  phase: string | null,
): Executor {
  const backend = routeBackend(config, label, phase);
  const executor = executors[backend];
  if (!executor) {
    throw new Error(
      `route resolved agent "${label}" to unknown backend "${backend}" (available: ${Object.keys(executors).join(", ") || "none"})`,
    );
  }
  return executor;
}
