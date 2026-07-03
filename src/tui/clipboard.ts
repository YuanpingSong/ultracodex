import { spawnSync } from "node:child_process";

export function copyToClipboard(text: string): boolean {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : [
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
        ];
  for (const [cmd, args] of candidates) {
    try {
      const r = spawnSync(cmd, args, { input: text });
      if (r.status === 0) return true;
    } catch {
      // try next
    }
  }
  return false;
}

export function openInEditor(filePath: string): boolean {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  try {
    const r = spawnSync(editor, [filePath], { stdio: "inherit" });
    return r.status === 0;
  } catch {
    return false;
  }
}
