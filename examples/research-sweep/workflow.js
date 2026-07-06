// Parallel read-only investigation: one probe agent per storage area, all
// running at once, each returning schema-validated findings with a per-item
// safety rating. The script deliberately does NO synthesis pass — the raw
// per-area findings are the deliverable, and a human does the deleting.
//
// The teaching core:
//   1. a shared guardrail string interpolated into EVERY prompt (read-only mandate)
//   2. per-area prompt tailoring around one common findings contract
//   3. a safety-rating enum so eight reports read as one review queue
//   4. flat fan-out + .filter(Boolean): a failed probe costs one area, not the run
//
// Run it:     ultracodex run examples/research-sweep/workflow.js --watch
// Add areas:  --args '{"areas":[{"area":"NAS","prompt":"Investigate /mnt/nas ..."}]}'
export const meta = {
  name: 'research-sweep',
  description: 'Read-only parallel deep-dive into disk usage across major storage areas; structured findings with safety ratings (no deletions)',
  phases: [
    { title: 'Probe', detail: 'one investigator per storage area, read-only du/find' },
  ],
}

// One findings contract for every area. The safety enum is the heart of it:
// it turns N free-text essays into one comparable, sortable review queue.
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'totalSize', 'summary', 'items'],
  properties: {
    area: { type: 'string' },
    totalSize: { type: 'string', description: 'human-readable total for this area, e.g. "42G"' },
    summary: { type: 'string', description: '2-4 sentence overview of what dominates this area' },
    items: {
      type: 'array',
      description: 'cleanup candidates and notable space consumers, largest first',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'size', 'kind', 'safety', 'reason'],
        properties: {
          path: { type: 'string', description: 'absolute path' },
          size: { type: 'string', description: 'human-readable size, e.g. "3.2G"' },
          kind: { type: 'string', description: 'e.g. cache, build-artifact, package-store, vm-image, media, download, app-data, backup, log, user-document' },
          safety: { type: 'string', enum: ['safe', 'likely-safe', 'review', 'keep'], description: 'safe=regenerable/disposable; likely-safe=probably fine but confirm; review=user must decide; keep=do not suggest deleting' },
          reason: { type: 'string', description: "why it is / isn't safe to delete and what regenerates it" },
        },
      },
    },
    notes: { type: 'string', description: 'optional extra observations, caveats, or things that need user input' },
  },
}

// The shared guardrail. Every probe prompt embeds this verbatim, so the
// read-only mandate lives in ONE place — not eight slightly different ones.
const RO = `STRICTLY READ-ONLY. Do NOT delete, move, or modify ANY file. Only run inspection commands (du, find, ls, ls -la, stat, df). Never run rm, mv, trash, or anything destructive.

Use efficient commands: \`du -h -d 2 -x <dir> 2>/dev/null | sort -hr | head -40\` to break down a tree, and \`find <dir> -type f -size +300M 2>/dev/null -exec ls -lh {} \\; | awk '{print $5, $9}' | sort -hr | head -40\` to find big files. Drill deeper (-d 3) into whatever dominates. Identify what is a regenerable cache/build-artifact vs irreplaceable user data. For each notable consumer return a structured item with a safety rating. Be concrete with real paths and sizes.`

phase('Probe')

// One target per major storage area. Same contract everywhere; the prompt
// tails differ because each area needs different domain judgment about what
// is disposable. Paths are deliberately platform-neutral (~ placeholders) —
// adjust for your machine, or append areas via args without editing this.
const TARGETS = [
  {
    area: 'Caches',
    label: 'probe:caches',
    prompt: `Investigate the user-level cache directories: ~/.cache plus your platform's per-app cache location (e.g. ~/Library/Caches on macOS). ${RO}
This is almost entirely regenerable. Break it down by subdirectory with sizes, and list the largest cached artifacts (downloaded model weights, headless-browser binaries, package archives). Almost everything here should be 'safe' or 'likely-safe'; flag anything that clearly took a very long time to download as 'likely-safe' with a note that it re-downloads on demand.`,
  },
  {
    area: 'PackageStores',
    label: 'probe:package-stores',
    prompt: `Investigate the package-manager and toolchain stores under ~ : the dot-directories kept by language package managers, version managers, SDKs, and build tools (registry caches, wrapper distributions, downloaded toolchain versions, emulator/VM images bundled with SDKs). ${RO}
Size each store precisely, then split it into the regenerable portion (artifact/registry caches, old toolchain versions) vs configuration and credentials. Mark package caches, superseded toolchain versions, and SDK emulator images as 'safe'/'likely-safe' and say exactly what regenerates them; mark configuration and credentials as 'keep'.`,
  },
  {
    area: 'BuildArtifacts',
    label: 'probe:build-artifacts',
    prompt: `Investigate the user's code/project directories (e.g. ~/code, ~/projects, ~/src — discover what actually exists). ${RO}
Within project trees, find regenerable artifacts: dependency directories (node_modules-style), build outputs (target/, build/, dist/), virtualenvs, bytecode caches. Run \`find <dir> -name node_modules -maxdepth 4 -type d 2>/dev/null -exec du -sh {} \\;\` style scans per artifact kind. Mark build artifacts and dependency directories as 'safe' (regenerable via install/build) and source code as 'keep'.`,
  },
  {
    area: 'ContainersAndVMs',
    label: 'probe:containers-vms',
    prompt: `Investigate container-runtime and virtual-machine storage: container image/layer stores, VM disk images (*.raw / *.qcow2 / *.img / *.vmdk), and sandboxed app-container data, wherever your platform keeps them. ${RO}
Virtual disks are often the single largest files on a developer machine. Report each disk image and image store with its real size. Stopped containers, dangling images, and old snapshots are 'likely-safe' — name the standard prune command a human could run, without running it. Disks backing VMs the user still uses are 'review'.`,
  },
  {
    area: 'Downloads',
    label: 'probe:downloads',
    prompt: `Investigate ~/Downloads. ${RO}
List every file/folder over ~100M and categorize: installers, archives, datasets, media, documents. Old installers and duplicate archives are typically 'likely-safe'. Sort by size and also note the oldest files (likely forgotten) — use ls -la to surface modification dates where helpful. Anything that looks like a user document is 'review'.`,
  },
  {
    area: 'AppData',
    label: 'probe:app-data',
    prompt: `Investigate application support data: your platform's per-app data directory (e.g. ~/Library/Application Support on macOS, ~/.local/share and ~/.config on Linux). ${RO}
Find the largest applications and split each into cache-like content (embedded-browser caches, downloaded models, update leftovers) vs real user state (profiles, databases, documents). Cache-like content is 'likely-safe'; anything holding user state is 'review' or 'keep' — when in doubt, 'keep'.`,
  },
  {
    area: 'MediaAndDocuments',
    label: 'probe:media-documents',
    prompt: `Investigate the personal-content areas: ~/Documents, ~/Pictures, ~/Movies or ~/Videos, ~/Music, ~/Desktop. ${RO}
Break each down by subfolder and surface everything over ~300M: recordings, exports, disk images, archives, apparent duplicate sets. Be conservative: personal media is irreplaceable, so default to 'review' for user content and 'keep' for anything that looks like a primary photo/media library; only obvious installers and duplicated archives are 'likely-safe'. Note any apparent duplicate sets.`,
  },
  {
    area: 'SystemWide',
    label: 'probe:system-wide',
    prompt: `Investigate reclaimable space OUTSIDE the home directory. ${RO}
Check: installed applications (largest first), system cache and log locations, temp directories, the OS package manager's download cache if present, the Trash (size it and list contents), other mounted volumes (\`df -h\`), and any snapshot/purgeable-space mechanism your filesystem offers (report it, don't reclaim it). Trash, package caches, temp, and logs are 'safe'/'likely-safe'; installed applications are 'review'.`,
  },
]

// Callers can append their own areas ({ area, prompt, label? }) via args —
// each one gets the same guardrail stapled on, no exceptions.
const EXTRA = Array.isArray(args?.areas) ? args.areas : []
const ALL = TARGETS.concat(EXTRA.map((t, i) => ({
  area: t.area ?? `Extra${i + 1}`,
  label: t.label ?? `probe:extra-${i + 1}`,
  prompt: `${t.prompt} ${RO}`,
})))

log(`fanning out ${ALL.length} read-only probes`)

const results = await parallel(
  ALL.map(t => () => agent(t.prompt, {
    label: t.label,
    phase: 'Probe',
    schema: FINDINGS_SCHEMA,
    // Belt to go with the RO-prompt braces: 'Explore' is the upstream
    // read-only agent profile. agentType values are engine-defined — an
    // engine without this profile runs its default subagent, same script.
    agentType: 'Explore',
  }))
)

// No silent drops: name exactly which probes came back empty.
const findings = results.filter(Boolean)
const failed = ALL.filter((t, i) => !results[i]).map(t => t.area)
if (failed.length) log(`no findings from: ${failed.join(', ')} (probe failed or was skipped)`)
log(`${findings.length}/${ALL.length} areas reported findings`)

// Deliberately no synthesis pass: the schema already makes the findings
// comparable, and a summarizer would only blur the sizes and safety calls
// the human reviewer needs verbatim. Return the raw structured results.
return findings
