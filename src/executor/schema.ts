import { Ajv, type ErrorObject } from "ajv";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-clone `schema`, then harden every object node for codex structured output.
 *
 * Decision (dual-runnability over aggressive strictness):
 * - `additionalProperties: false` is added ONLY where the schema left it
 *   unspecified (codex needs closed objects to keep the model on-schema). An
 *   explicit boolean is preserved, and a map-style sub-schema
 *   (`additionalProperties: { ... }`) is preserved AND recursed into —
 *   clobbering it would make map objects unsatisfiable except `{}`.
 * - `required` is left exactly as authored. Upstream Claude Code validates the
 *   user's schema as written (optional properties stay optional), so promoting
 *   every property to required would force agents to fabricate values and
 *   diverge from upstream semantics.
 */
export function strictify(schema: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(schema);
  strictifyNode(clone);
  return clone;
}

function strictifyNode(node: unknown): void {
  if (Array.isArray(node)) {
    for (const entry of node) strictifyNode(entry);
    return;
  }
  if (!isRecord(node)) return;
  const props = isRecord(node.properties) ? node.properties : null;
  if (node.type === "object" || props) {
    if (node.additionalProperties === undefined) {
      node.additionalProperties = false;
    } else {
      strictifyNode(node.additionalProperties); // sub-schema recursed; booleans no-op
    }
  }
  if (props) for (const value of Object.values(props)) strictifyNode(value);
  if (node.items !== undefined) strictifyNode(node.items);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[key])) strictifyNode(node[key]);
  }
  for (const key of ["$defs", "definitions"] as const) {
    const defs = node[key];
    if (isRecord(defs)) for (const value of Object.values(defs)) strictifyNode(value);
  }
}

/**
 * Produce the schema sent as `outputSchema` over the wire, or null when the
 * schema cannot be expressed in OpenAI strict structured-output form.
 *
 * OpenAI strict mode REQUIRES on every object node: `required` listing EVERY
 * key in `properties`, and `additionalProperties: false` (a map-style
 * sub-schema is not strict-representable). Sending anything looser fails the
 * whole turn with 400 invalid_json_schema — observed live 2026-07-02.
 * Semantic optionality is preserved by validating the model's reply against
 * the AUTHORED schema (createValidator), never this wire form.
 */
export function strictifyForWire(
  schema: Record<string, unknown>,
): Record<string, unknown> | null {
  const clone = structuredClone(schema);
  return wireNode(clone) ? clone : null;
}

function wireNode(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(wireNode);
  if (!isRecord(node)) return true;
  const props = isRecord(node.properties) ? node.properties : null;
  if (node.type === "object" || props) {
    // map-style objects (additionalProperties sub-schema, or open objects with
    // no enumerable properties) cannot be made strict — caller omits outputSchema
    if (isRecord(node.additionalProperties)) return false;
    if (!props) return false;
    node.additionalProperties = false;
    node.required = Object.keys(props);
  }
  if (props) {
    for (const value of Object.values(props)) if (!wireNode(value)) return false;
  }
  if (node.items !== undefined && !wireNode(node.items)) return false;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const list = node[key];
    if (Array.isArray(list) && !list.every(wireNode)) return false;
  }
  for (const key of ["$defs", "definitions"] as const) {
    const defs = node[key];
    if (isRecord(defs)) {
      for (const value of Object.values(defs)) if (!wireNode(value)) return false;
    }
  }
  return true;
}

export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "<structured_output_contract>",
    "Respond ONLY with a single JSON object valid against this JSON Schema (no markdown fences, no commentary):",
    JSON.stringify(schema),
    "</structured_output_contract>",
  ].join("\n");
}

/** Return the JSON substring in `text`: whole-string parse first, else the first balanced {...} or [...] block that parses. */
export function extractJson(text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {}
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = scanBalanced(text, i);
    if (end === -1) continue;
    const candidate = text.slice(i, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("no JSON object or array found in text");
}

function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

export function createValidator(
  schema: Record<string, unknown>,
): (text: string) => { ok: true; object: unknown } | { ok: false; errors: string } {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return (text) => {
    let object: unknown;
    try {
      object = JSON.parse(extractJson(text));
    } catch (err) {
      return { ok: false, errors: err instanceof Error ? err.message : String(err) };
    }
    if (validate(object)) return { ok: true, object };
    return { ok: false, errors: formatAjvErrors(validate.errors) };
  };
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "does not match schema";
  return errors
    .map((e) => {
      const where = e.instancePath || "(root)";
      const params = e.params && Object.keys(e.params).length > 0 ? ` ${JSON.stringify(e.params)}` : "";
      return `${where} ${e.message ?? "invalid"}${params}`;
    })
    .join("; ");
}
