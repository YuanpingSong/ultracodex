import fs from "node:fs";
import path from "node:path";
import { STATE_DIR_NAME, WORKFLOWS_DIR_NAME } from "./constants.js";
import { parseMeta } from "./loader.js";
import type { WorkflowMeta } from "./types.js";

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function skillDescription(meta: WorkflowMeta): string {
  const base = oneLine(meta.description);
  return meta.whenToUse ? `${base} Use when: ${oneLine(meta.whenToUse)}` : base;
}

function skillMarkdown(name: string, meta: WorkflowMeta): string {
  return `---
name: ultracodex-${name}
description: ${skillDescription(meta)}
---

Execute the "${name}" ultracodex workflow. The workflow does the work — do not attempt the task yourself.

1. Build the workflow arguments as a single JSON value from the user's request (omit \`--args\` when no arguments apply).
2. Run the workflow via the Bash tool and wait for the command to complete (it blocks until the run finishes and prints the result JSON):

\`\`\`bash
ultracodex run ${name} --args '<json>' --json
\`\`\`

3. Relay the command's stdout verbatim. If the run failed, report the failure as-is and stop — do NOT substitute your own answer.
`;
}

/**
 * The general-usage skill: teaches Claude the full ultracodex contract so
 * ad-hoc workflow requests need no CLI discovery, no CLAUDE.md setup, and no
 * warning-driven rewrites. Always emitted, even with zero saved workflows.
 */
const GENERAL_SKILL = `---
name: ultracodex
description: Author and run multi-agent Agent Script workflows on the OpenAI Codex CLI via the ultracodex runner. Use when the user asks to run a workflow with ultracodex, orchestrate parallel agents, fan-outs, pipelines, or actor-critic / builder-verifier loops, or to offload multi-agent execution from Claude to Codex.
---

ultracodex executes Claude Code Workflow-tool scripts unmodified, routing each \`agent()\` call to an OpenAI Codex session. This file is the complete contract — assume the \`ultracodex\` binary is installed and authenticated; do NOT explore the CLI with --help, inspect the repo, or run doctor first (only run \`ultracodex doctor\` if a command fails unexpectedly).

## Authoring

Write the script EXACTLY as you would for the Workflow tool — same format, byte for byte: \`export const meta = {name, description, phases?}\` as a pure literal, then a plain-JS async body over the injected globals \`agent\` / \`parallel\` / \`pipeline\` / \`phase\` / \`log\` / \`args\` / \`budget\` / \`workflow\`. Loops are ordinary JavaScript (null-check every agent result; guard unbounded loops on \`budget\`). No imports, no TypeScript. Save it to a file. If the Workflow tool schema is not in your context, learn the format from the package's docs/agent_script_spec.md.

## Running

\`\`\`bash
ultracodex run <file> --json [--budget 500k] [--args '<json>']
\`\`\`

- Blocks until the run completes; stdout is the result JSON (the script body's return value). Non-zero exit = the run failed.
- \`--budget\` is an output-token ceiling (integer, k/m suffixes).
- Model/backend routing lives in \`.ultracodex/config.toml\`, never in the script.
- Optional pre-check: \`ultracodex validate <file> --strict\`. Fix ERRORS; WARNINGS are non-blocking — do not rewrite a working script just to silence a warning.
- The human can watch live with \`ultracodex ls\` / \`attach <runId>\` — you do not need to poll.

## Results

Relay the run's stdout verbatim (then you may summarize it). If the run failed, report the failure as-is and stop — do NOT substitute your own answer for the workflow's work.
`;

export function syncSkills(projectDir: string): { written: string[] } {
  const workflowsDir = path.join(projectDir, STATE_DIR_NAME, WORKFLOWS_DIR_NAME);
  const written: string[] = [];

  const generalDir = path.join(projectDir, ".claude", "skills", "ultracodex");
  fs.mkdirSync(generalDir, { recursive: true });
  const generalFile = path.join(generalDir, "SKILL.md");
  fs.writeFileSync(generalFile, GENERAL_SKILL);
  written.push(generalFile);

  let entries: string[];
  try {
    entries = fs.readdirSync(workflowsDir);
  } catch {
    return { written };
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".js")) continue;
    const name = entry.slice(0, -".js".length);
    let meta: WorkflowMeta;
    try {
      meta = parseMeta(fs.readFileSync(path.join(workflowsDir, entry), "utf8")).meta;
    } catch {
      continue; // unloadable workflow → no skill (validate reports it)
    }
    const skillDir = path.join(projectDir, ".claude", "skills", `ultracodex-${name}`);
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillFile, skillMarkdown(name, meta));
    written.push(skillFile);
  }
  return { written };
}
