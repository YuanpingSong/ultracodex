import fs from "node:fs";
import path from "node:path";
import { WORKFLOWS_DIR_NAME } from "./constants.js";
import { stateDir } from "./rundir.js";
import { packageRootDir } from "./skills.js";

/** Resolve a script path or a saved workflow name to an absolute script path. */
export function resolveScript(projectDir: string, ref: string): string {
  const asPath = path.resolve(projectDir, ref);
  try {
    if (fs.statSync(asPath).isFile()) return asPath;
  } catch {
    // not a file path
  }
  const saved = path.join(stateDir(projectDir), WORKFLOWS_DIR_NAME, `${ref}.js`);
  try {
    if (fs.statSync(saved).isFile()) return saved;
  } catch {
    // not a saved workflow either
  }
  const builtin = path.join(packageRootDir(), WORKFLOWS_DIR_NAME, `${ref}.js`);
  try {
    if (fs.statSync(builtin).isFile()) return builtin;
  } catch {
    // not a packaged workflow either
  }
  throw new Error(
    `cannot resolve script "${ref}": tried path ${asPath}, saved workflow ${saved}, and packaged workflow ${builtin}`,
  );
}
