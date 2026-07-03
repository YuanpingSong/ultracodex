import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncSkills } from "../src/skills.js";

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-skills-"));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

function writeWorkflow(name: string, source: string): void {
  const dir = path.join(projectDir, ".ultracodex", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.js`), source);
}

const DIGEST = `export const meta = {
  name: "digest",
  description: "Summarize project docs into one overview.",
  whenToUse: "the user asks for a doc digest",
};
return await agent("go");
`;

const PLAIN = `export const meta = { name: "plain", description: "Does a plain thing." };
return 1;
`;

describe("syncSkills", () => {
  it("returns empty when there is no workflows dir", () => {
    expect(syncSkills(projectDir)).toEqual({ written: [] });
  });

  it("writes one SKILL.md per workflow with correct paths", () => {
    writeWorkflow("digest", DIGEST);
    writeWorkflow("plain", PLAIN);
    const { written } = syncSkills(projectDir);
    expect(written).toEqual([
      path.join(projectDir, ".claude", "skills", "ultracodex-digest", "SKILL.md"),
      path.join(projectDir, ".claude", "skills", "ultracodex-plain", "SKILL.md"),
    ]);
    for (const file of written) expect(fs.existsSync(file)).toBe(true);
  });

  it("frontmatter carries name and description with whenToUse appended", () => {
    writeWorkflow("digest", DIGEST);
    const { written } = syncSkills(projectDir);
    const content = fs.readFileSync(written[0]!, "utf8");
    expect(content.startsWith("---\n")).toBe(true);
    const frontmatter = content.split("---")[1]!;
    expect(frontmatter).toContain("name: ultracodex-digest\n");
    expect(frontmatter).toContain(
      "description: Summarize project docs into one overview. Use when: the user asks for a doc digest\n",
    );
  });

  it("frontmatter without whenToUse is just the description", () => {
    writeWorkflow("plain", PLAIN);
    const { written } = syncSkills(projectDir);
    const frontmatter = fs.readFileSync(written[0]!, "utf8").split("---")[1]!;
    expect(frontmatter).toContain("description: Does a plain thing.\n");
    expect(frontmatter).not.toContain("Use when:");
  });

  it("body instructs Bash execution of the run command and verbatim relay", () => {
    writeWorkflow("digest", DIGEST);
    const { written } = syncSkills(projectDir);
    const body = fs.readFileSync(written[0]!, "utf8");
    expect(body).toContain("Bash");
    expect(body).toContain("ultracodex run digest --args '<json>' --json");
    expect(body).toContain(
      "Relay the command's stdout verbatim. If the run failed, report the failure as-is and stop — do NOT substitute your own answer.",
    );
  });

  it("is idempotent: re-running overwrites stale content", () => {
    writeWorkflow("digest", DIGEST);
    const first = syncSkills(projectDir);
    fs.writeFileSync(first.written[0]!, "stale garbage");
    const second = syncSkills(projectDir);
    expect(second.written).toEqual(first.written);
    const content = fs.readFileSync(first.written[0]!, "utf8");
    expect(content).not.toContain("stale garbage");
    expect(content).toContain("name: ultracodex-digest");
  });

  it("skips non-js files and workflows whose meta fails to parse", () => {
    writeWorkflow("digest", DIGEST);
    writeWorkflow("broken", `const nope = 1;\n`);
    fs.writeFileSync(path.join(projectDir, ".ultracodex", "workflows", "notes.md"), "# not a workflow");
    const { written } = syncSkills(projectDir);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("ultracodex-digest");
  });

  it("collapses multi-line descriptions into one frontmatter line", () => {
    writeWorkflow(
      "multi",
      "export const meta = { name: 'multi', description: `line one\nline two`, whenToUse: 'x' };\nreturn 1;\n",
    );
    const { written } = syncSkills(projectDir);
    const frontmatter = fs.readFileSync(written[0]!, "utf8").split("---")[1]!;
    expect(frontmatter).toContain("description: line one line two Use when: x\n");
  });
});
