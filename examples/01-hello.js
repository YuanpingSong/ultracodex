// The smallest useful Agent Script: one agent, one result.
// Run it:   ultracodex run examples/01-hello.js --watch
export const meta = {
  name: 'hello',
  description: 'One agent inspects the current directory and reports back',
}

// `agent()` sends a prompt to a coding agent (Codex by default) running in
// your project directory. Its final message is the return value — or null
// if the agent failed, so real scripts null-check.
const report = await agent(
  'List the files in the current directory and say in one sentence what this project appears to be.',
)

log('agent finished')          // narrator line, shows up in the TUI / --watch

// The body's return value becomes the run result (result.json, `show --json`).
return { report }
