import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP("git", ["-C", cwd, ...args]);
}

export async function createWorktree(
  projectDir: string,
  runDir: string,
  n: number,
): Promise<string> {
  try {
    await git(projectDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `worktree isolation requires a git repository, but ${projectDir} is not a git repo (${detail.split("\n")[0]})`,
    );
  }
  const wtPath = path.resolve(runDir, "wt", String(n));
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  await git(projectDir, ["worktree", "add", "--detach", wtPath, "HEAD"]);
  return wtPath;
}

export async function cleanupWorktree(
  projectDir: string,
  wtPath: string,
): Promise<{ kept: boolean }> {
  // Upstream contract: worktree "auto-removed if unchanged". Changed means
  // uncommitted changes (dirty tree) OR commits the agent made on the detached
  // HEAD — a clean `status --porcelain` alone would destroy committed work.
  const { stdout } = await git(wtPath, ["status", "--porcelain"]);
  if (stdout.trim() !== "") return { kept: true };
  // (--all would include HEAD itself, making the count always 0)
  const { stdout: unreachable } = await git(wtPath, [
    "rev-list",
    "--count",
    "HEAD",
    "--not",
    "--branches",
    "--tags",
    "--remotes",
  ]);
  if (parseInt(unreachable.trim(), 10) > 0) return { kept: true };
  await git(projectDir, ["worktree", "remove", "--force", wtPath]);
  await git(projectDir, ["worktree", "prune"]);
  return { kept: false };
}
