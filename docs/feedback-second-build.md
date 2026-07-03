# Feedback from the-second-ultracodex clean-room build

Issues hit while dogfooding ultracodex as the build runner for a spec-only
rebuild (fable plans via `claude -p`, codex executes via ultracodex, fable
verifies). Each item is a candidate improvement to this repo.

## Open

(none — all confirmed items fixed)

## Fixed in this repo during the second build

- **Claude backend permission/tool flags.** `[backends.claude] extra_args`
  (and `[backends.codex] extra_args`) now append to every spawn. The claude
  default ships `--allowedTools Read Glob Grep`, so claude-routed judge
  agents can actually read the repo out of the box — the stage-2 review
  proved read-only judging works headlessly; command-running gates still
  belong on codex.

- **Wire schemas must be OpenAI-strict; fake-codex didn't enforce it.**
  Stage 1 of the rebuild failed instantly: all 11 agents got
  `400 invalid_json_schema` because the review pass had changed `strictify`
  to preserve the authored `required` — but OpenAI strict structured output
  demands `required` = every property key + `additionalProperties: false`
  on every object node. The dual-skeptic verification missed it because the
  repro ran against the fake, which accepted loose schemas. Fixes:
  (1) `strictifyForWire()` — strict-completed wire form, or omitted entirely
  when not strict-representable (map-style `additionalProperties`), while ajv
  keeps validating against the authored schema; (2) the fake now emulates
  the API's strict-schema validation and returns the real error shape, so
  this class of bug fails hermetically. Lesson: **fake fidelity is a spec
  concern — every live-API rejection class the executor relies on must be
  mirrored in the fixture.**

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
