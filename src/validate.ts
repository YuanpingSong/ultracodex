import { parse } from "acorn";
import { FANOUT_ITEM_CAP } from "./constants.js";
import { ScriptError, parseMeta } from "./loader.js";
import type { WorkflowMeta } from "./types.js";

export interface ValidationIssue {
  severity: "error" | "warn";
  message: string;
  line?: number;
}

interface Node {
  type: string;
  loc?: { start: { line: number } };
  [k: string]: unknown;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof (child as Node).type === "string") walk(child as Node, visit);
      }
    } else if (value && typeof (value as Node).type === "string") {
      walk(value as Node, visit);
    }
  }
}

function isIdent(n: unknown, name: string): boolean {
  const node = n as Node | null | undefined;
  return !!node && node.type === "Identifier" && node["name"] === name;
}

function isMemberOf(n: Node, obj: string, prop: string): boolean {
  return (
    n.type === "MemberExpression" &&
    n["computed"] !== true &&
    isIdent(n["object"], obj) &&
    isIdent(n["property"], prop)
  );
}

function isMemberCall(n: Node, obj: string, prop: string): boolean {
  if (n.type !== "CallExpression") return false;
  const callee = n["callee"] as Node | undefined;
  return !!callee && isMemberOf(callee, obj, prop);
}

function stringLiteral(n: Node | undefined): string | null {
  if (!n) return null;
  if (n.type === "Literal" && typeof n["value"] === "string") return n["value"];
  if (n.type === "TemplateLiteral") {
    const t = n as unknown as { quasis: Array<{ value: { cooked: string } }>; expressions: Node[] };
    if (t.expressions.length === 0) return t.quasis[0]?.value.cooked ?? "";
  }
  return null;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

function issue(severity: "error" | "warn", message: string, line?: number): ValidationIssue {
  return line === undefined ? { severity, message } : { severity, message, line };
}

const LOOP_TYPES = new Set(["WhileStatement", "DoWhileStatement", "ForStatement"]);

export function validateWorkflowScript(
  source: string,
  opts?: { strict?: boolean },
): ValidationIssue[] {
  const strict = opts?.strict ?? false;
  const issues: ValidationIssue[] = [];

  let program: Node;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
      allowReturnOutsideFunction: true,
    }) as unknown as Node;
  } catch (e) {
    const err = e as { message?: string; loc?: { line?: number } };
    issues.push(
      issue(
        "error",
        `script failed to parse as plain-JS ESM: ${err.message ?? String(e)}`,
        err.loc?.line,
      ),
    );
    return issues;
  }

  let meta: WorkflowMeta | null = null;
  let metaLine: number | undefined;
  try {
    const parsed = parseMeta(source);
    meta = parsed.meta;
    metaLine = lineAt(source, parsed.metaStart);
  } catch (e) {
    if (!(e instanceof ScriptError)) throw e;
    issues.push(issue("error", e.message, e.line));
  }

  const impureSeverity = strict ? "error" : "warn";
  const phaseCalls: Array<{ title: string; line?: number }> = [];
  const budgetLoops: Array<{ line?: number }> = [];
  let budgetTotalSeen = false;

  walk(program, (n) => {
    const line = n.loc?.start.line;
    if (isMemberCall(n, "Date", "now")) {
      issues.push(issue(impureSeverity, "Date.now() is banned upstream (resume determinism)", line));
    }
    if (isMemberCall(n, "Math", "random")) {
      issues.push(issue(impureSeverity, "Math.random() is banned upstream (resume determinism)", line));
    }
    if (
      n.type === "NewExpression" &&
      isIdent(n["callee"], "Date") &&
      (n["arguments"] as Node[]).length === 0
    ) {
      issues.push(
        issue(impureSeverity, "new Date() with no arguments is banned upstream (resume determinism)", line),
      );
    }
    if (n.type === "CallExpression" && isIdent(n["callee"], "phase")) {
      const title = stringLiteral((n["arguments"] as Node[])[0]);
      if (title !== null) phaseCalls.push(line === undefined ? { title } : { title, line });
    }
    if (isMemberOf(n, "budget", "total")) budgetTotalSeen = true;
    if (LOOP_TYPES.has(n.type) && n["test"]) {
      let usesRemaining = false;
      walk(n["test"] as Node, (t) => {
        if (isMemberCall(t, "budget", "remaining")) usesRemaining = true;
      });
      if (usesRemaining) budgetLoops.push(line === undefined ? {} : { line });
    }
    if (
      n.type === "CallExpression" &&
      (isIdent(n["callee"], "parallel") || isIdent(n["callee"], "pipeline"))
    ) {
      const first = (n["arguments"] as Node[])[0];
      if (first?.type === "ArrayExpression") {
        const count = (first["elements"] as unknown[]).length;
        if (count > FANOUT_ITEM_CAP) {
          const fn = (n["callee"] as { name: string }).name;
          issues.push(
            issue(
              "warn",
              `${fn}() called with a literal array of ${count} items (fan-out cap is ${FANOUT_ITEM_CAP})`,
              line,
            ),
          );
        }
      }
    }
  });

  if (meta?.phases) {
    const called = new Set(phaseCalls.map((p) => p.title));
    for (const ph of meta.phases) {
      if (!called.has(ph.title)) {
        issues.push(
          issue("warn", `meta.phases title "${ph.title}" has no matching phase("${ph.title}") call`, metaLine),
        );
      }
    }
    const titles = new Set(meta.phases.map((p) => p.title));
    for (const call of phaseCalls) {
      if (!titles.has(call.title)) {
        issues.push(issue("warn", `phase("${call.title}") does not match any meta.phases title`, call.line));
      }
    }
  }

  if (!budgetTotalSeen) {
    for (const loop of budgetLoops) {
      issues.push(
        issue(
          "warn",
          "loop condition uses budget.remaining() but the script never references budget.total; guard budget loops with budget.total",
          loop.line,
        ),
      );
    }
  }

  return issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}
