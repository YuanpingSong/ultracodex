# Feedback from the-second-ultracodex clean-room build

Issues hit while dogfooding ultracodex as the build runner for a spec-only
rebuild (fable plans via `claude -p`, codex executes via ultracodex, fable
verifies). Each item is a candidate improvement to this repo.

## Open

1. **Claude backend has no permission/tool flags.** `ClaudeExecutor` spawns
   `claude -p --output-format json` bare. Headless claude cannot use tools
   (Read/Bash/…) without `--allowedTools` / `--permission-mode`, so any
   claude-routed agent that must read files or run commands silently degrades
   to context-free text prediction. Need `[backends.claude] extra_args = [...]`
   (or explicit `allowed_tools` config) plumbed into the spawn argv.

## Fixed in this repo during the second build

- **Fast-tier inheritance.** The operator's `~/.codex/config.toml` had
  `service_tier = "fast"` — every spawned app-server silently ran on the
  increased-usage fast tier. Added `[backends.codex] service_tier`
  (default `"standard"`, passed as `-c service_tier=...` on spawn) so fast
  mode is off unless explicitly configured.
- **Weak default model/effort.** Unpinned agents ran gpt-5.4 at codex's
  default (medium) effort. Defaults now gpt-5.5 + `default_effort = "xhigh"`
  (new config knob), matching "inherit the main-loop model" upstream
  semantics (gpt-5.5 is codex's own default).

## Observations (not yet confirmed as issues)

- Consumer codex accounts rate-limit under fan-out; §10 prescribes
  per-backend backoff on 429 which is not yet implemented in the executor.
  Watch for it during the build stages.
