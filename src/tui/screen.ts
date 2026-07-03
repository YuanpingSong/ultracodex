/**
 * Alternate screen buffer control (the vim/htop full-screen mechanism).
 * The TUI enters the alt screen on mount and MUST restore the primary
 * buffer on any exit path — including crashes — or the user's terminal is
 * left blank. A process exit hook provides the last-resort restore.
 */

const ENTER = "\x1b[?1049h\x1b[H";
const LEAVE = "\x1b[?1049l";

let active = false;
let exitHookInstalled = false;

export function enterAltScreen(): void {
  if (active || !process.stdout.isTTY) return;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", () => {
      if (active) process.stdout.write(LEAVE);
    });
  }
  process.stdout.write(ENTER);
  active = true;
}

export function leaveAltScreen(): void {
  if (!active) return;
  process.stdout.write(LEAVE);
  active = false;
}

/** Hand the primary screen to a blocking child (e.g. $EDITOR), then return. */
export function suspendAltScreen<T>(fn: () => T): T {
  const wasActive = active;
  if (wasActive) leaveAltScreen();
  try {
    return fn();
  } finally {
    if (wasActive) enterAltScreen();
  }
}
