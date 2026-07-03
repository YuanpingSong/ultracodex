import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree, cleanupWorktree } from "../src/worktree.js";

const execFileP = promisify(execFile);

function git(cwd: string, args: string[]) {
  return execFileP("git", ["-C", cwd, ...args]);
}

async function initRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucwt-repo-"));
  await git(dir, ["init", "-q"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "hello\n");
  await git(dir, ["add", "."]);
  await git(dir, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-qm",
    "init",
  ]);
  return dir;
}

function tempRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ucwt-run-"));
}

async function worktreePaths(repo: string): Promise<string[]> {
  const { stdout } = await git(repo, ["worktree", "list", "--porcelain"]);
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => fs.realpathSync(l.slice("worktree ".length)));
}

describe("createWorktree", () => {
  test("adds a detached worktree at <runDir>/wt/<n> with the repo contents", async () => {
    const repo = await initRepo();
    const runDir = tempRunDir();

    const wt = await createWorktree(repo, runDir, 3);

    expect(wt).toBe(path.resolve(runDir, "wt", "3"));
    expect(fs.existsSync(wt)).toBe(true);
    expect(fs.readFileSync(path.join(wt, "file.txt"), "utf8")).toBe("hello\n");
    expect(await worktreePaths(repo)).toContain(fs.realpathSync(wt));
    // detached HEAD in the worktree
    await expect(
      git(wt, ["symbolic-ref", "-q", "HEAD"]),
    ).rejects.toThrow();
  });

  test("throws an informative error when projectDir is not a git repo", async () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ucwt-norepo-"));
    const runDir = tempRunDir();
    await expect(createWorktree(notRepo, runDir, 1)).rejects.toThrow(
      /not a git repo/i,
    );
    expect(fs.existsSync(path.join(runDir, "wt", "1"))).toBe(false);
  });
});

describe("cleanupWorktree", () => {
  test("removes a clean worktree and prunes it from the list", async () => {
    const repo = await initRepo();
    const runDir = tempRunDir();
    const wt = await createWorktree(repo, runDir, 1);
    const before = await worktreePaths(repo);
    expect(before).toContain(fs.realpathSync(wt));

    const res = await cleanupWorktree(repo, wt);

    expect(res).toEqual({ kept: false });
    expect(fs.existsSync(wt)).toBe(false);
    const after = await worktreePaths(repo);
    expect(after).toHaveLength(before.length - 1);
  });

  test("keeps a dirty worktree and reports kept: true", async () => {
    const repo = await initRepo();
    const runDir = tempRunDir();
    const wt = await createWorktree(repo, runDir, 2);
    fs.writeFileSync(path.join(wt, "scratch.txt"), "uncommitted\n");

    const res = await cleanupWorktree(repo, wt);

    expect(res).toEqual({ kept: true });
    expect(fs.existsSync(path.join(wt, "scratch.txt"))).toBe(true);
    expect(await worktreePaths(repo)).toContain(fs.realpathSync(wt));
  });

  test("treats modified tracked files as dirty too", async () => {
    const repo = await initRepo();
    const runDir = tempRunDir();
    const wt = await createWorktree(repo, runDir, 4);
    fs.writeFileSync(path.join(wt, "file.txt"), "modified\n");

    const res = await cleanupWorktree(repo, wt);
    expect(res).toEqual({ kept: true });
    expect(fs.existsSync(wt)).toBe(true);
  });
});
