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
  const { stdout } = await git(wtPath, ["status", "--porcelain"]);
  if (stdout.trim() !== "") return { kept: true };
  await git(projectDir, ["worktree", "remove", "--force", wtPath]);
  await git(projectDir, ["worktree", "prune"]);
  return { kept: false };
}
