// The whole release ritual as one command:  pnpm release <patch|minor|major|x.y.z>
//
//   1. clean tree + on main
//   2. pnpm release:check   (build + hermetic suite + LIVE haiku gate + archive)
//   3. npm version <bump>   (bumps package.json, commits, tags vX.Y.Z)
//   4. push main + tag      (tag triggers .github/workflows/release.yml →
//                            npm publish via trusted publishing/OIDC, provenance)
//   5. gh release create    (release notes generated from commits)
//   6. poll the registry until the new version is live (verifies the OIDC flow)
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bump = process.argv[2];
if (!bump || !/^(patch|minor|major|\d+\.\d+\.\d+)$/.test(bump)) {
  console.error("usage: pnpm release <patch|minor|major|x.y.z>");
  process.exit(1);
}
const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: "inherit" });
};
const out = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();

// 1. preconditions
if (out("git status --porcelain") !== "") {
  console.error("✖ working tree not clean — commit or stash first");
  process.exit(1);
}
if (out("git branch --show-current") !== "main") {
  console.error("✖ releases ship from main");
  process.exit(1);
}

// 2. the gate (live)
run("pnpm release:check");

// 3. bump + tag
run(`npm version ${bump} -m "release: v%s"`);
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

// 4. push (tag push triggers the publish workflow)
run("git push origin main --follow-tags");

// 5. GitHub release
run(`gh release create v${version} --verify-tag --title "ultracodex ${version}" --generate-notes`);

// 6. verify trusted publishing actually landed it on the registry
console.log(`\nℹ waiting for ultracodex@${version} on the npm registry (OIDC publish via Actions)…`);
const deadline = Date.now() + 8 * 60 * 1000;
let live = false;
while (Date.now() < deadline) {
  const probe = spawnSync("npm", ["view", `ultracodex@${version}`, "version"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() === version) {
    live = true;
    break;
  }
  process.stdout.write(".");
  execSync("sleep 15");
}
if (live) {
  console.log(`\n✔ ultracodex@${version} is live on npm (published by the release workflow).`);
} else {
  console.error(
    `\n✖ registry never showed ${version} — check the workflow: gh run list --workflow release.yml\n` +
      "  (if trusted publishing is misconfigured, fix it on npmjs.com → package → Trusted Publishers, then re-run the failed job)",
  );
  process.exit(1);
}
