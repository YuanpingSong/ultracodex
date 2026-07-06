import { Box, render, useApp } from "ink";
import { useState, type ReactElement } from "react";
import { HomeView } from "./HomeView.js";
import { RunView } from "./RunView.js";
import { useTerminalSize } from "./hooks.js";
import { enterAltScreen, leaveAltScreen } from "./screen.js";

type Route = { view: "home" } | { view: "run"; runDir: string };

/**
 * Interactive TUI entry. runDir given → attach to that run; else home/launcher.
 * Full-screen: renders in the alternate screen buffer and restores the
 * primary buffer (and the user's scrollback) on every exit path.
 * Resolves when the user quits. Quitting NEVER kills runs — the runner owns itself.
 */
export async function runTui(opts: { projectDir: string; runDir?: string }): Promise<void> {
  enterAltScreen();
  try {
    const instance = render(
      <App projectDir={opts.projectDir} initialRunDir={opts.runDir ?? null} />,
      { exitOnCtrlC: true },
    );
    await instance.waitUntilExit();
  } finally {
    leaveAltScreen();
  }
}

function App({ projectDir, initialRunDir }: { projectDir: string; initialRunDir: string | null }): ReactElement {
  const [route, setRoute] = useState<Route>(
    initialRunDir !== null ? { view: "run", runDir: initialRunDir } : { view: "home" },
  );
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const view =
    route.view === "run" ? (
      <RunView
        projectDir={projectDir}
        runDir={route.runDir}
        rows={rows}
        onBack={() => setRoute({ view: "home" })}
        onQuit={() => exit()}
      />
    ) : (
      <HomeView projectDir={projectDir} onAttach={(runDir) => setRoute({ view: "run", runDir })} onQuit={() => exit()} />
    );
  // Fixed full-terminal frame; views fill it (flexGrow roots + bottom-pinned
  // footers) so the app owns the whole screen like a proper coding-agent TUI.
  return (
    <Box width={columns} height={rows} flexDirection="column">
      {view}
    </Box>
  );
}
