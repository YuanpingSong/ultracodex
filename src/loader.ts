import { parse } from "acorn";
import vm from "node:vm";
import type { WorkflowGlobals, WorkflowMeta } from "./types.js";

export class ScriptError extends Error {
  line?: number;
  constructor(message: string, line?: number) {
    super(message);
    this.name = "ScriptError";
    if (line !== undefined) this.line = line;
  }
}

export interface LoadedScript {
  meta: WorkflowMeta;
  /** Compiled body — call with the injected globals. Return value = workflow result. */
  body: (globals: WorkflowGlobals) => Promise<unknown>;
  source: string;
}

// ---------------------------------------------------------------------------
// parseMeta — static evaluation of the pure `export const meta = {...}` literal
// ---------------------------------------------------------------------------

interface Node {
  type: string;
  start: number;
  end: number;
  loc?: { start: { line: number } };
  [k: string]: unknown;
}

function lineOf(node: Node): number | undefined {
  return node.loc?.start.line;
}

function evalPure(node: Node): unknown {
  switch (node.type) {
    case "Literal":
      return (node as { value?: unknown }).value;
    case "TemplateLiteral": {
      const t = node as unknown as { quasis: Array<{ value: { cooked: string } }>; expressions: Node[] };
      if (t.expressions.length > 0) {
        throw new ScriptError("meta: template literal interpolation is not allowed", lineOf(node));
      }
      return t.quasis[0]?.value.cooked ?? "";
    }
    case "UnaryExpression": {
      const u = node as unknown as { operator: string; argument: Node };
      if (u.operator !== "+" && u.operator !== "-") {
        throw new ScriptError(`meta: unary operator "${u.operator}" is not allowed`, lineOf(node));
      }
      const v = evalPure(u.argument) as number;
      return u.operator === "-" ? -v : +v;
    }
    case "ArrayExpression": {
      const a = node as unknown as { elements: Array<Node | null> };
      return a.elements.map((el) => {
        if (el === null) return null;
        if (el.type === "SpreadElement") {
          throw new ScriptError("meta: spread is not allowed", lineOf(el));
        }
        return evalPure(el);
      });
    }
    case "ObjectExpression": {
      const o = node as unknown as { properties: Node[] };
      const out: Record<string, unknown> = {};
      for (const prop of o.properties) {
        if (prop.type !== "Property") {
          throw new ScriptError("meta: spread is not allowed", lineOf(prop));
        }
        const p = prop as unknown as { key: Node; value: Node; computed: boolean; kind: string };
        if (p.computed || p.kind !== "init") {
          throw new ScriptError("meta: only plain literal properties are allowed", lineOf(prop));
        }
        let key: string;
        if (p.key.type === "Identifier") key = (p.key as unknown as { name: string }).name;
        else if (p.key.type === "Literal") key = String((p.key as unknown as { value: unknown }).value);
        else throw new ScriptError("meta: unsupported property key", lineOf(prop));
        out[key] = evalPure(p.value);
      }
      return out;
    }
    default:
      throw new ScriptError(`meta must be a pure literal (found ${node.type})`, lineOf(node));
  }
}

export function parseMeta(source: string): { meta: WorkflowMeta; metaStart: number; metaEnd: number } {
  let body: Node[];
  try {
    const program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowReturnOutsideFunction: true,
    }) as unknown as { body: Node[] };
    body = program.body;
  } catch (e) {
    const err = e as { message?: string; loc?: { line?: number } };
    throw new ScriptError(`script parse error: ${err.message ?? String(e)}`, err.loc?.line);
  }

  const first = body[0];
  if (!first) {
    throw new ScriptError("script is empty; first statement must be `export const meta = {...}`");
  }
  const bad = (): ScriptError =>
    new ScriptError("first statement must be `export const meta = {...}`", lineOf(first));

  if (first.type !== "ExportNamedDeclaration") throw bad();
  const decl = (first as unknown as { declaration: Node | null }).declaration;
  if (!decl || decl.type !== "VariableDeclaration") throw bad();
  if ((decl as unknown as { kind: string }).kind !== "const") throw bad();
  const declarator = (decl as unknown as { declarations: Node[] }).declarations[0];
  if (!declarator) throw bad();
  const { id, init } = declarator as unknown as { id: Node & { name?: string }; init: Node | null };
  if (id.type !== "Identifier" || id.name !== "meta" || !init) throw bad();
  if (init.type !== "ObjectExpression") {
    throw new ScriptError("meta must be an object literal", lineOf(init));
  }

  const raw = evalPure(init) as Record<string, unknown>;
  if (typeof raw["name"] !== "string" || raw["name"] === "") {
    throw new ScriptError("meta.name (non-empty string) is required", lineOf(init));
  }
  if (typeof raw["description"] !== "string" || raw["description"] === "") {
    throw new ScriptError("meta.description (non-empty string) is required", lineOf(init));
  }

  const meta: WorkflowMeta = { name: raw["name"], description: raw["description"] };
  if (typeof raw["whenToUse"] === "string") meta.whenToUse = raw["whenToUse"];
  if (Array.isArray(raw["phases"])) meta.phases = raw["phases"] as WorkflowMeta["phases"];
  return { meta, metaStart: first.start, metaEnd: first.end };
}

// ---------------------------------------------------------------------------
// loadScript
// ---------------------------------------------------------------------------

const WRAPPER_HEAD = "(async ({agent, parallel, pipeline, phase, log, args, budget, workflow}) => {\n";

const STRICT_SHIM = `{
  const RealDate = Date;
  class StrictDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        throw new Error("new Date() with no arguments is not allowed in workflow scripts (resume determinism)");
      }
      super(...args);
    }
  }
  Object.defineProperty(StrictDate, "name", { value: "Date" });
  StrictDate.now = () => {
    throw new Error("Date.now() is not allowed in workflow scripts (resume determinism)");
  };
  globalThis.Date = StrictDate;
  Math.random = () => {
    throw new Error("Math.random() is not allowed in workflow scripts (resume determinism)");
  };
}`;

function fmtConsoleArg(v: unknown): string {
  if (typeof v === "string") return v;
  const stack = (v as { stack?: unknown } | null)?.stack;
  if (v instanceof Error || typeof stack === "string") return String(stack ?? v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function makeContextObject(): Record<string, unknown> {
  const write = (...items: unknown[]): void => {
    process.stderr.write(items.map(fmtConsoleArg).join(" ") + "\n");
  };
  return {
    console: { log: write, error: write, warn: write, info: write, debug: write },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    TextEncoder,
    TextDecoder,
    structuredClone,
  };
}

export function loadScript(source: string, opts: { strict: boolean }): LoadedScript {
  const { meta, metaStart, metaEnd } = parseMeta(source);

  // Blank the meta statement (keep newlines) so body line/col match the source.
  const stripped =
    source.slice(0, metaStart) +
    source.slice(metaStart, metaEnd).replace(/[^\n\r]/g, " ") +
    source.slice(metaEnd);
  const wrapped = WRAPPER_HEAD + stripped + "\n})";

  let script: vm.Script;
  try {
    // lineOffset -1 compensates for the wrapper line: stack traces show source lines.
    script = new vm.Script(wrapped, { filename: "workflow.js", lineOffset: -1 });
  } catch (e) {
    const err = e as Error;
    const m = /workflow\.js:(\d+)/.exec(err.stack ?? "");
    throw new ScriptError(
      `script body failed to compile (must be plain JavaScript): ${err.message}`,
      m ? Number(m[1]) : undefined,
    );
  }

  const context = makeContextObject();
  const body = script.runInNewContext(context) as (globals: WorkflowGlobals) => Promise<unknown>;
  if (opts.strict) vm.runInContext(STRICT_SHIM, context);

  return { meta, body, source };
}
