import { render, useApp } from "ink";
import { useState, type ReactElement } from "react";
import { HomeView } from "./HomeView.js";
import { RunView } from "./RunView.js";

type Route = { view: "home" } | { view: "run"; runDir: string };

/**
 * Interactive TUI entry. runDir given → attach to that run; else home/launcher.
 * Resolves when the user quits. Quitting NEVER kills runs — the runner owns itself.
 */
export function runTui(opts: { projectDir: string; runDir?: string }): Promise<void> {
  const instance = render(<App projectDir={opts.projectDir} initialRunDir={opts.runDir ?? null} />, {
    exitOnCtrlC: true,
  });
  return instance.waitUntilExit().then(() => undefined);
}

function App({ projectDir, initialRunDir }: { projectDir: string; initialRunDir: string | null }): ReactElement {
  const [route, setRoute] = useState<Route>(
    initialRunDir !== null ? { view: "run", runDir: initialRunDir } : { view: "home" },
  );
  const { exit } = useApp();
  if (route.view === "run") {
    return (
      <RunView
        projectDir={projectDir}
        runDir={route.runDir}
        onBack={() => setRoute({ view: "home" })}
        onQuit={() => exit()}
      />
    );
  }
  return (
    <HomeView projectDir={projectDir} onAttach={(runDir) => setRoute({ view: "run", runDir })} onQuit={() => exit()} />
  );
}
