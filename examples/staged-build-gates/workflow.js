// Build a multi-module project in dependency-ordered waves with gate agents.
//
// The project is fully specified up front by a written module-API contract
// (docs/module-contracts.md in the target repo). Builders within a wave run in
// parallel and self-verify ONLY their own files — sibling modules may not
// exist yet, so a global typecheck is banned until the wave's gate. After each
// parallel wave, a single gate agent runs the full typecheck + test suite and
// reconciles cross-module drift, with the contract doc as the arbiter of which
// side is wrong. A final integrator iterates build + tests + an end-to-end
// smoke of the real binary until the whole sequence passes twice in a row.
//
// Run it:   ultracodex run examples/staged-build-gates/workflow.js \
//             --args '{"projectDir": "/abs/path/to/project"}' --watch
//
// Expected skeleton in projectDir (committed BEFORE this workflow runs):
//   docs/module-contracts.md — exact exports/signatures/errors per module
//   docs/design-notes.md     — design rationale
//   src/types.ts             — shared types (frozen; no builder may edit)
//   package.json, tsconfig.json — toolchain (frozen)
export const meta = {
  name: 'staged-build-gates',
  description: 'Implement a contracted multi-module project in dependency-ordered waves with typecheck/test gate agents between waves and a final integrator',
  whenToUse: 'When a build is too large for one agent, the modules form a dependency DAG, and a written API contract lets independent builders work in parallel.',
  phases: [
    { title: 'Wave1', detail: 'leaf modules: parser, store, config' },
    { title: 'Gate1', detail: 'cross-module typecheck + test reconciliation' },
    { title: 'Wave2', detail: 'query engine, renderer, linter, importers' },
    { title: 'Gate2', detail: 'cross-module typecheck + test reconciliation' },
    { title: 'Wave3', detail: 'CLI entry point wiring everything' },
    { title: 'Integrate', detail: 'full build + test suite + end-to-end smoke' },
  ],
}

if (!args || !args.projectDir) {
  throw new Error('pass --args \'{"projectDir": "/abs/path/to/project"}\' — the repo skeleton (contract doc, shared types, toolchain) must already exist there')
}
const ROOT = args.projectDir

const COMMON = `You are one of several agents building a structured-notes CLI in ${ROOT} (a TypeScript ESM project, Node 20+, npm).

MANDATORY FIRST READS (in this order):
1. ${ROOT}/docs/module-contracts.md — your EXACT export contract. Implement signatures exactly as written for YOUR modules. Read the other modules' sections too so you call them correctly.
2. ${ROOT}/src/types.ts — shared types (already written; do NOT modify).
3. ${ROOT}/docs/design-notes.md — design rationale (read the sections relevant to your modules).

RULES:
- ESM + NodeNext: every relative import needs the .js suffix (import ... from "./types.js").
- Write ONLY the files assigned to you. Never edit src/types.ts, package.json, tsconfig.json, or another agent's files. Never run git commit.
- Sibling modules may not exist yet — do NOT run the full "npm run typecheck". Verify YOUR work with your own tests only: npx vitest run tests/<your-test-file> (vitest transpiles per-file, so missing siblings won't break you unless you import them).
- Write real tests that exercise behavior (temp dirs via fs.mkdtempSync(path.join(os.tmpdir(), ...)), no mocks of Node builtins). Tests must pass before you return.
- Code style: terse, no decorative comments, small functions. Handle errors as the contract specifies.

RETURN (raw data): { files: [...], testsPassed: true|false, testCommand: "...", deviations: "none or details", notes: "important implementation decisions in 1-3 sentences" }`

// Wave 1: leaf modules — they depend on src/types.ts and nothing else, so all
// three can be written at once. `model` is an advisory tier: routine modules
// are pinned to a cheaper tier; hard ones omit it and take the engine default
// (the strongest tier configured for the session).
const BUILDERS_W1 = [
  {
    key: 'parser',
    prompt: `${COMMON}

YOUR ASSIGNMENT — the record parser (the format grammar; everything downstream trusts it). Files:
- src/parser.ts
- tests/parser.test.ts

Follow docs/module-contracts.md section "src/parser.ts" exactly. Key requirements:
- parseRecords(source): line-oriented format — "key: value" fields, records separated by blank lines, "#" comment lines ignored. Throw ParseError (with .line, 1-based) on malformed lines, duplicate keys within a record, or an unterminated multi-line value.
- Multi-line values: a field whose value is exactly "|" collects the subsequent indented lines verbatim (common indent stripped) until the first non-indented line.
- serializeRecords(records): exact inverse — parseRecords(serializeRecords(x)) deep-equals x for every valid input. CRLF input is normalized to LF on parse.
Tests: round-trip property on hand-built records covering every field shape; each error case asserts the .line number; comment/blank-line tolerance; CRLF normalization; multi-line values containing "#" and "key:"-looking lines (they are verbatim, not fields).`,
    hard: true,
  },
  {
    key: 'store',
    prompt: `${COMMON}

YOUR ASSIGNMENT — the append-only record store. Files:
- src/store.ts
- tests/store.test.ts

Follow docs/module-contracts.md section "src/store.ts". Key requirements:
- openStore(dir): creates <dir>/records.jsonl on first open; one JSON object per line; keep a single append fd for the store's lifetime; close() releases it.
- append(record) assigns a monotonically increasing integer id (stable across reopen — derive the next id by scanning on open). scan(filter?) yields records in insertion order, skipping tombstoned ids. remove(id) appends a tombstone line, never rewrites in place. compact() rewrites the file dropping tombstones and returns {kept, dropped}.
- Crash tolerance: a trailing partial line (torn write) is skipped with a warning on the returned store, never a crash.
Tests: temp dirs; round-trip incl. unicode values; tombstone then compact; torn-final-line tolerance (truncate the file mid-line by hand and reopen); ids stable across close+reopen.`,
    model: 'sonnet',
  },
  {
    key: 'config',
    prompt: `${COMMON}

YOUR ASSIGNMENT — layered config loading. Files:
- src/config.ts
- tests/config.test.ts

Follow docs/module-contracts.md section "src/config.ts". Key requirements:
- loadConfig(projectDir, opts?): deep-merge order DEFAULTS (from the contract) ← <home>/.notes/config.json ← <projectDir>/.notes/config.json. Make the home path injectable for tests: opts.homeDir — an ALLOWED contract extension (document it in deviations).
- Unknown keys are collected into a warnings array on the returned object, never a throw. Missing/unreadable files are treated as empty, never a throw.
- Output settings (color, format, page width) accept both snake_case and camelCase JSON keys, normalized to camelCase in the result.
Tests: pure defaults when no files exist; project file overrides home file field-wise (deep, not whole-object replacement); unknown-key warnings; snake_case normalization; malformed JSON file → warning + defaults.`,
    model: 'sonnet',
  },
]

// Wave 2: everything that imports the wave-1 leaves. These builders may import
// parser/store/config freely — those modules exist and are green — but still
// no global typecheck: their own siblings in THIS wave are being written
// concurrently.
const BUILDERS_W2 = [
  {
    key: 'query',
    prompt: `${COMMON}

YOUR ASSIGNMENT — the query engine (the subtle one: grammar, precedence, comparison semantics). Files:
- src/query.ts
- tests/query.test.ts

These wave-1 modules EXIST and are tested — import and use them per their contracts: src/parser.ts, src/store.ts (openStore/scan).
Key requirements:
- compileQuery(expr): the tiny filter language from the contract — field comparisons (=, !=, ~ substring, < and > numeric-or-date), and/or/not with parentheses, quoted strings with escapes. Throw QueryError with a caret-annotated message (the expr, a newline, spaces, "^") on syntax errors.
- runQuery(store, query, opts): yields matching records; opts.sort {field, dir}, opts.limit. Sort is stable; records missing the sort field order last.
- Comparison semantics: < and > compare chronologically when BOTH sides parse as ISO dates, numerically when both parse as numbers, else lexically — exactly as the contract specifies (this is the classic drift point between query and lint; read that contract section twice).
Tests: each operator positive+negative; precedence (not > and > or) with and without parentheses; caret position on syntax errors; stable sort + missing-field ordering; limit; date-vs-number-vs-string comparison edge cases.`,
    hard: true,
  },
  {
    key: 'render',
    prompt: `${COMMON}

YOUR ASSIGNMENT — output rendering. Files:
- src/render.ts
- tests/render.test.ts

Wave-1 config exists (loadConfig — color/format/width settings). Key requirements:
- renderRecords(records, opts): three formats per the contract — "plain" (one line per record), "table" (unicode box drawing, columns sized to content, cell truncation with an ellipsis at opts.width), "json" (stable key order, 2-space indent).
- ANSI color only when opts.color is true. Do NOT read process.env in this module — the contract puts NO_COLOR/--no-color resolution in the CLI layer; render is env-free and takes opts.color from the caller.
Tests: exact-string assertions per format on a small fixture; width truncation; zero ANSI escapes anywhere when color:false; stable json key order across differently-ordered inputs.`,
    model: 'sonnet',
  },
  {
    key: 'lint',
    prompt: `${COMMON}

YOUR ASSIGNMENT — the input linter. Files:
- src/lint.ts
- tests/lint.test.ts

Wave-1 parser exists — import { parseRecords, ParseError } from "./parser.js"; do not re-implement parsing.
Key requirements:
- lintFile(source): hard errors come from the parser (catch ParseError → an error-severity finding, same line number); then warn on: duplicate record titles, fields outside the contract's known-field list, date-typed fields that do not parse as ISO dates, records with no body. Findings are {severity, line, message}, 1-based lines, sorted by line then severity.
- Date parsing must match the query engine's rule in the contract (shared semantics section) — do not invent a different one.
Tests: each rule positive+negative on small source strings; a parse error suppresses per-record warns for the broken record only; sort order; clean file → empty findings.`,
    model: 'sonnet',
  },
  {
    key: 'importers',
    prompt: `${COMMON}

YOUR ASSIGNMENT — foreign-format importers. Files:
- src/import.ts
- tests/import.test.ts

Wave-1 modules exist: parser (serializeRecords), store (openStore/append).
Key requirements:
- importCsv(source, mapping) and importMarkdown(source): normalize to the shared record type per the contract. Malformed rows/sections are collected into {skipped: [{line, reason}]} on the result, never a throw.
- importInto(store, records): appends all, returns {added, ids}; the contract's dedupe key (title + created date) makes re-import of the same file a no-op — assert that.
Tests: CSV quoting/escaping edge cases (embedded commas, quotes, newlines); markdown heading→title and body mapping; skipped-row reporting with line numbers; idempotent re-import.`,
    model: 'sonnet',
  },
]

// Wave 3: the CLI is the roof — it imports every other module, so it can only
// be written truthfully once both gates have run.
const BUILDER_W3 = {
  key: 'cli',
  prompt: `${COMMON}

YOUR ASSIGNMENT — the CLI entry point (everything else already exists and is tested; read their contracts and import them). Files:
- src/cli.ts
- tests/cli.test.ts

Follow docs/module-contracts.md section "src/cli.ts". Everything is available: parser, store, config, query, render, lint, import.
Key requirements:
- Subcommands per the contract: add, ls (query expr + render), lint <file>, import <file> [--format csv|md], rm <id>, compact. Global flags: --dir (store location, default from config), --format, --no-color, --json.
- Structure for testability: export buildProgram() plus the small helpers (flag parsing, exit-code mapping), with a main guard (import.meta.url === pathToFileURL(process.argv[1]).href) so tests import functions instead of spawning a process.
- NO_COLOR / --no-color are resolved HERE and passed down as opts.color (render stays env-free per its contract).
- Exit codes: 0 ok, 1 command failure (query/lint errors, missing file), 2 usage error.
Tests: helper unit tests (flag parsing, exit-code mapping, --json output shape); plus ONE spawn test against dist/cli.js marked skip-if-not-built (fs.existsSync) so it only runs post-build during integration.
Return the standard summary object.`,
}

// The gate runs the checks the wave builders were banned from running. Its
// arbiter rule is the whole trick: when two modules disagree, the contract doc
// decides which one is wrong — never "whichever file is easier to change".
const GATE_PROMPT = (wave) => `${COMMON}

YOU ARE THE ${wave} INTEGRATION GATE. The wave's module builders just finished. Your job:
1. npm run typecheck — fix EVERY error. Cross-module mismatches: fix the CALLER to match docs/module-contracts.md; if a module deviated from the contract, fix the MODULE to match the contract. The contract doc is the arbiter — never resolve a disagreement by changing whichever side is more convenient. Imports of modules from FUTURE waves (files that don't exist yet): stubs are NOT allowed — verify the import is behind a lazy dynamic import per the contract, and report it.
2. npx vitest run — every test green. Fix real bugs; do not weaken assertions or delete tests. If a test is genuinely wrong (contradicts the contract doc), fix the test to match the contract and note it.
3. Keep changes minimal and surgical. No refactors, no renames, no new features. Never run git commit.
Return: { typecheckOk: true|false, testsOk: true|false, failuresFixed: ["..."], remainingIssues: ["..."], notes: "..." }`

const INTEGRATE_PROMPT = `${COMMON}

YOU ARE THE FINAL INTEGRATOR. Everything is implemented and both gates have run. Deliver a working tool:
1. npm run typecheck && npm run build && npx vitest run — ALL green (fix what isn't; contract = docs/module-contracts.md; never weaken tests).
2. Verify the built binary: node dist/cli.js --help lists every subcommand; node dist/cli.js lint <a small sample file you write> runs without crashing.
3. HERMETIC END-TO-END SMOKE via the real CLI: in a fresh temp dir, write a small records file (a handful of records incl. one multi-line value, plus one deliberately malformed record in a second file for lint). Then drive node ${ROOT}/dist/cli.js with --dir pointing into the temp dir: import the good file; ls with a query expression and --json (assert stdout parses and matches the expected records); lint the bad file (assert the malformed record is reported with the right line and exit code 1); rm one id; compact; ls again (assert the removal stuck). Assert every exit code per the contract.
4. Fix every failure you hit at any step. Iterate until the WHOLE sequence (build, tests, smoke) passes twice in a row.
Return: { buildOk, testsOk, cliOk, smokeOk, fixes: ["..."], notes: "anything the next engineer must know" }`

// ---- Wave 1
phase('Wave1')
log('Wave 1: parser, store, config — leaf modules, fully parallel')
const SUMMARY = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    testsPassed: { type: 'boolean' },
    testCommand: { type: 'string' },
    deviations: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['files', 'testsPassed', 'deviations', 'notes'],
}
const w1 = await parallel(
  BUILDERS_W1.map((b) => () =>
    agent(b.prompt, {
      label: `build:${b.key}`,
      phase: 'Wave1',
      schema: SUMMARY,
      model: b.model, // advisory tier; undefined → engine default for the hard modules
    }).then((r) => ({ key: b.key, r })),
  ),
)
log(`Wave 1 done: ${w1.filter(Boolean).map((x) => `${x.key}:${x.r?.testsPassed ? 'green' : 'RED'}`).join(' ')}`)

phase('Gate1')
const GATE_SCHEMA = {
  type: 'object',
  properties: {
    typecheckOk: { type: 'boolean' },
    testsOk: { type: 'boolean' },
    failuresFixed: { type: 'array', items: { type: 'string' } },
    remainingIssues: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['typecheckOk', 'testsOk', 'remainingIssues'],
}
const g1 = await agent(GATE_PROMPT('WAVE-1'), { label: 'gate:wave1', phase: 'Gate1', schema: GATE_SCHEMA })
log(`Gate 1: typecheck=${g1?.typecheckOk} tests=${g1?.testsOk} remaining=${(g1?.remainingIssues ?? []).length}`)

// ---- Wave 2
phase('Wave2')
log('Wave 2: query engine, renderer, linter, importers — building on green leaves')
const w2 = await parallel(
  BUILDERS_W2.map((b) => () =>
    agent(b.prompt, {
      label: `build:${b.key}`,
      phase: 'Wave2',
      schema: SUMMARY,
      model: b.model,
    }).then((r) => ({ key: b.key, r })),
  ),
)
log(`Wave 2 done: ${w2.filter(Boolean).map((x) => `${x.key}:${x.r?.testsPassed ? 'green' : 'RED'}`).join(' ')}`)

phase('Gate2')
const g2 = await agent(GATE_PROMPT('WAVE-2'), { label: 'gate:wave2', phase: 'Gate2', schema: GATE_SCHEMA })
log(`Gate 2: typecheck=${g2?.typecheckOk} tests=${g2?.testsOk} remaining=${(g2?.remainingIssues ?? []).length}`)

// ---- Wave 3 (single builder — the CLI has no siblings to collide with)
phase('Wave3')
const w3 = await agent(BUILDER_W3.prompt, { label: 'build:cli', phase: 'Wave3', schema: SUMMARY })
log(`Wave 3 done: cli ${w3?.testsPassed ? 'green' : 'RED'}`)

// ---- Integrate
phase('Integrate')
const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    buildOk: { type: 'boolean' },
    testsOk: { type: 'boolean' },
    cliOk: { type: 'boolean' },
    smokeOk: { type: 'boolean' },
    fixes: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['buildOk', 'testsOk', 'cliOk', 'smokeOk', 'notes'],
}
const integration = await agent(INTEGRATE_PROMPT, { label: 'integrate', phase: 'Integrate', schema: INTEGRATE_SCHEMA })
log(`Integration: build=${integration?.buildOk} tests=${integration?.testsOk} cli=${integration?.cliOk} smoke=${integration?.smokeOk}`)

return {
  wave1: w1.filter(Boolean),
  gate1: g1,
  wave2: w2.filter(Boolean),
  gate2: g2,
  wave3: w3,
  integration,
}
