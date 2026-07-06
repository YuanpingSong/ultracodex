# Installing the skills

ultracodex ships two static skills in the package's `skills/` directory — one source of truth serving every surface below:

- **`ultracodex`** — the run contract: author the script exactly as for Claude Code's Workflow tool, execute with `ultracodex run <file> --json`, relay the result verbatim.
- **`agent-script-authoring`** — the writer-oriented format skill: one self-contained document (~4.7k tokens) that teaches any capable model to author Agent Scripts. Battle-tested via the ADR-0003 parity program (GPT-5.5 at parity 7/7 first try; a 31B open model at parity after one strengthening round).

## Claude Code

Per project — one command installs both static skills plus one relay skill per saved workflow:

```bash
ultracodex sync-skills
```

Or install the repo as a **plugin** — same two skills plus the examples gallery, no CLI required, with progressive disclosure (~250 always-on tokens; full skill text loads only on invoke):

```bash
claude plugin marketplace add YuanpingSong/ultracodex
claude plugin install ultracodex@ultracodex
```

## Codex

The Codex CLI consumes the same plugin marketplace natively:

```bash
codex plugin marketplace add https://github.com/YuanpingSong/ultracodex
codex plugin add ultracodex@ultracodex
```

## opencode

opencode discovers Claude-compatible skill paths (`.claude/skills/`) natively, so per-project `ultracodex sync-skills` covers opencode too, with the same on-demand loading. For a global install instead:

```bash
mkdir -p ~/.config/opencode/skills && cp -r "$(npm root -g)/ultracodex/skills/." ~/.config/opencode/skills/
```

## Any other agent (raw API call, anything that takes a prompt)

Prepend the authoring skill file to the prompt, state the problem, ask for a `workflow.js`. Then gate the result mechanically:

```bash
ultracodex validate --strict workflow.js   # must print: ok: no issues
```

## Prompting without any skill installed

Two variants, depending on the session's context:

**Option A — schema-native** (the session has the Workflow tool, e.g. ultracode mode; the model already knows the format as that tool's schema):

> Author the workflow exactly as you would for the Workflow tool — same script, byte for byte — but instead of invoking the tool, save it to a file and run `ultracodex run <file> --json --budget 300k`. Relay the result JSON verbatim; if the run fails, report the failure.

**Option B — teach from the authoring skill** (plain sessions, headless `claude -p`, other agents entirely): as Option A, but point at `skills/agent-script-authoring/SKILL.md` — "author it per the agent-script-authoring skill" — and state the task. This is the tested path: codex and opencode agents given only that file plus a problem statement authored scripts comparable to Claude-written references. The spec (`docs/agent_script_spec.md`) is the engine-implementer document; the skill is the writer document.

## Saved workflows as skills

Drop scripts in `.ultracodex/workflows/<name>.js` and they become runnable by name (`ultracodex run <name>`) and visible in the TUI launcher (bare `ultracodex`). Re-running `ultracodex sync-skills` then generates a Claude Code skill per workflow, so the driving model can trigger your saved workflows by name without being asked — the fully-automatic tier of the same integration.
