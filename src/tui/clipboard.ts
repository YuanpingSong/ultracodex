import { spawnSync } from "node:child_process";
import { suspendAltScreen } from "./screen.js";

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

/**
 * Shell-style split of an $EDITOR value into command + args, honoring
 * single/double quotes and backslash escapes ("code --wait",
 * `"/opt/My Editor/bin" -n`, `emacsclient -c -a ''`).
 */
export function parseEditorCommand(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false; // saw a quote in the current token (so '' is a real token)
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < raw.length) cur += raw[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      quoted = true;
    } else if (ch === "\\" && i + 1 < raw.length) {
      cur += raw[++i];
    } else if (/\s/.test(ch)) {
      if (cur !== "" || quoted) out.push(cur);
      cur = "";
      quoted = false;
    } else {
      cur += ch;
    }
  }
  if (cur !== "" || quoted) out.push(cur);
  return out;
}

function reportEditorFailure(editor: string, detail: string): void {
  // The TUI renders via Ink with console patching active, so console.error
  // lines appear above the UI instead of corrupting the frame — this is the
  // visible channel for "your $EDITOR did not launch".
  console.error(`ultracodex: failed to open $EDITOR (${editor}): ${detail}`);
}

export function openInEditor(filePath: string): boolean {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const parts = parseEditorCommand(editor);
  const cmd = parts[0];
  if (cmd === undefined || cmd === "") {
    reportEditorFailure(editor, "empty editor command");
    return false;
  }
  // Hand the terminal over: Ink keeps stdin in raw mode for its own key
  // handling; a full-screen editor expects cooked mode and owns the tty while
  // the (blocking) spawnSync runs. Restore raw mode afterwards so Ink's input
  // keeps working.
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY === true && stdin.isRaw;
  try {
    if (wasRaw) stdin.setRawMode(false);
    const r = suspendAltScreen(() => spawnSync(cmd, [...parts.slice(1), filePath], { stdio: "inherit" }));
    if (r.error) {
      reportEditorFailure(editor, r.error.message);
      return false;
    }
    return r.status === 0;
  } catch (e) {
    reportEditorFailure(editor, (e as Error).message);
    return false;
  } finally {
    if (wasRaw) stdin.setRawMode(true);
  }
}
