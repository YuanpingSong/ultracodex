import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildProgram, parseBudget, resolveScript } from "../src/cli.js";
import { fakeCodexPath } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function tmpProject(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ultracodex-cli-"));
  dirs.push(d);
  return d;
}

describe("parseBudget", () => {
  it("parses k/m suffixes and plain numbers", () => {
    expect(parseBudget("500k")).toBe(500_000);
    expect(parseBudget("1.5m")).toBe(1_500_000);
    expect(parseBudget("12345")).toBe(12_345);
    expect(parseBudget("2K")).toBe(2_000); // case-insensitive
    expect(parseBudget("0.25M")).toBe(250_000);
    expect(parseBudget(" 10k ")).toBe(10_000); // tolerant of whitespace
  });

  it("throws on garbage", () => {
    for (const bad of ["", "abc", "10x", "-5", "0", "k", "1..5m", "1e6"]) {
      expect(() => parseBudget(bad), `parseBudget(${JSON.stringify(bad)})`).toThrow(
        /invalid budget/,
      );
    }
  });
});

describe("resolveScript", () => {
  it("resolves a relative path against the project dir", () => {
    const projectDir = tmpProject();
    const file = path.join(projectDir, "my-script.js");
    fs.writeFileSync(file, "// script");
    expect(resolveScript(projectDir, "my-script.js")).toBe(file);
  });

  it("resolves an absolute path", () => {
    const projectDir = tmpProject();
    const other = tmpProject();
    const file = path.join(other, "elsewhere.js");
    fs.writeFileSync(file, "// script");
    expect(resolveScript(projectDir, file)).toBe(file);
  });

  it("resolves a saved workflow name to stateDir/workflows/<name>.js", () => {
    const projectDir = tmpProject();
    const wfDir = path.join(projectDir, ".ultracodex", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    const file = path.join(wfDir, "digest.js");
    fs.writeFileSync(file, "// wf");
    expect(resolveScript(projectDir, "digest")).toBe(file);
  });

  it("prefers a real file over a same-named saved workflow", () => {
    const projectDir = tmpProject();
    const wfDir = path.join(projectDir, ".ultracodex", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, "dup.js"), "// wf");
    const local = path.join(projectDir, "dup");
    fs.writeFileSync(local, "// local file");
    expect(resolveScript(projectDir, "dup")).toBe(local);
  });

  it("throws with both tried locations when nothing matches", () => {
    const projectDir = tmpProject();
    expect(() => resolveScript(projectDir, "ghost")).toThrow(/cannot resolve script "ghost"/);
    expect(() => resolveScript(projectDir, "ghost")).toThrow(/workflows/);
  });
});

describe("buildProgram", () => {
  it("registers the full command surface", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(
      expect.arrayContaining([
        "run",
        "ls",
        "show",
        "attach",
        "pause",
        "resume",
        "skip",
        "kill",
        "logs",
        "validate",
        "sync-skills",
        "doctor",
      ]),
    );
  });

  it("run command exposes the documented options", () => {
    const run = buildProgram().commands.find((c) => c.name() === "run")!;
    const flags = run.options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--args",
        "--budget",
        "--watch",
        "--detach",
        "--json",
        "--strict",
        "--concurrency",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Full-binary integration (only after `pnpm build`)
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCli = path.join(repoRoot, "dist", "cli.js");
const distRunner = path.join(repoRoot, "dist", "runner.js");
const distBuilt = fs.existsSync(distCli) && fs.existsSync(distRunner);

function execCli(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [distCli, ...args],
      { cwd, timeout: 25_000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

describe.skipIf(!distBuilt)("dist/cli.js (post-build integration)", () => {
  it("run --json spawns a detached runner and prints the result JSON", async () => {
    const projectDir = tmpProject();
    fs.mkdirSync(path.join(projectDir, ".ultracodex"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".ultracodex", "config.toml"),
      `[route]\n"*" = "codex"\n\n[backends.codex]\nbinary = ${JSON.stringify(fakeCodexPath())}\n`,
    );
    fs.writeFileSync(
      path.join(projectDir, "wf.js"),
      `export const meta = { name: 'cli-e2e', description: 'cli demo' }
const hi = await agent('greet [[reply:hi]]', { label: 'greeter' })
return { greeting: hi }
`,
    );
    const { stdout, stderr, code } = await execCli(["run", "wf.js", "--json"], projectDir);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ greeting: "hi" });
  }, 30_000);
});
