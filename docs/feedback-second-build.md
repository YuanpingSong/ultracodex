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

## Observations (not yet confirmed as issues)

- Consumer codex accounts rate-limit under fan-out; §10 prescribes
  per-backend backoff on 429 which is not yet implemented in the executor.
  Watch for it during the build stages.
