import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * Static skills ship as files under the package's skills/ directory — the
 * same layout a Claude Code plugin install exposes — so the repo checkout,
 * the npm tarball, and a plugin install all carry identical content:
 *  - ultracodex: how to RUN workflows through this CLI (verbatim-relay contract).
 *  - agent-script-authoring: how to WRITE workflow scripts (model-agnostic).
 *  - org-creation: how to DESIGN and scaffold a generic filesystem org.
 */
const STATIC_SKILLS = ["ultracodex", "agent-script-authoring", "org-creation"] as const;

export function packageRootDir(): string {
  // src/skills.ts and dist/skills.js both sit one level below the package
  // root, in the repo checkout and the installed npm layout alike.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function packageSkillsDir(): string {
  return path.join(packageRootDir(), "skills");
}

export function syncSkills(projectDir: string): { written: string[] } {
  const written: string[] = [];

  const sourceDir = packageSkillsDir();
  for (const name of STATIC_SKILLS) {
    const source = path.join(sourceDir, name, "SKILL.md");
    let content: string;
    try {
      content = fs.readFileSync(source, "utf8");
    } catch {
      throw new Error(`packaged skill missing: ${source} — broken install; reinstall ultracodex`);
    }
    const destDir = path.join(projectDir, ".claude", "skills", name);
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, "SKILL.md");
    fs.writeFileSync(dest, content);
    written.push(dest);
  }

  const workflowsDir = path.join(projectDir, STATE_DIR_NAME, WORKFLOWS_DIR_NAME);
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
