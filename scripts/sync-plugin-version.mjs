// Keeps .claude-plugin/plugin.json's version in lockstep with package.json.
// Runs via the npm "version" lifecycle hook, i.e. inside `npm version <bump>`
// (which `pnpm release` drives), before the release commit is created.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const pluginPath = path.join(ROOT, ".claude-plugin", "plugin.json");
const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8"));
plugin.version = pkg.version;
fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + "\n");
console.log(`plugin.json version → ${pkg.version}`);
