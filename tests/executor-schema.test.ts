import { describe, it, expect } from "vitest";
import {
  createValidator,
  extractJson,
  schemaInstruction,
  strictify,
  strictifyForWire,
} from "../src/executor/schema.js";
import { assemblePrompt } from "../src/executor/prompt.js";
import { RETURN_VALUE_CONTRACT } from "../src/constants.js";

describe("strictifyForWire", () => {
  it("promotes every property to required and closes objects (OpenAI strict mode)", () => {
    const wire = strictifyForWire({
      type: "object",
      properties: { a: { type: "number" }, b: { type: "string" } },
      required: ["a"],
    });
    expect(wire).not.toBeNull();
    expect((wire as Record<string, unknown>).required).toEqual(["a", "b"]);
    expect((wire as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it("recurses into nested objects and arrays", () => {
    const wire = strictifyForWire({
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object", properties: { x: { type: "number" } } } },
      },
    }) as Record<string, unknown>;
    const items = (wire.properties as Record<string, Record<string, unknown>>).items;
    const inner = items.items as Record<string, unknown>;
    expect(inner.required).toEqual(["x"]);
    expect(inner.additionalProperties).toBe(false);
  });

  it("returns null for map-style additionalProperties (not strict-representable)", () => {
    expect(
      strictifyForWire({
        type: "object",
        properties: { m: { type: "object", additionalProperties: { type: "number" } } },
        required: ["m"],
      }),
    ).toBeNull();
  });

  it("returns null for open objects with no enumerable properties", () => {
    expect(strictifyForWire({ type: "object" })).toBeNull();
  });

  it("does not mutate its input", () => {
    const input = { type: "object", properties: { a: { type: "number" } } };
    const snapshot = structuredClone(input);
    strictifyForWire(input);
    expect(input).toEqual(snapshot);
  });
});

describe("strictify", () => {
  it("closes nested objects, array items, anyOf/oneOf/allOf and $defs/definitions", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        items: { type: "array", items: { type: "object", properties: { id: { type: "number" } } } },
        pick: {
          anyOf: [
            { type: "object", properties: { x: { type: "string" }, y: { type: "string" } } },
            { type: "string" },
          ],
        },
        one: { oneOf: [{ type: "object", properties: { q: { type: "number" } } }] },
        all: { allOf: [{ type: "object", properties: { r: { type: "number" } } }] },
        linked: { $ref: "#/$defs/thing" },
      },
      $defs: {
        thing: {
          type: "object",
          properties: { deep: { type: "object", properties: { z: { type: "boolean" } } } },
        },
      },
      definitions: {
        legacy: { type: "object", properties: { w: { type: "string" } } },
      },
    };
    const out = strictify(schema) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.items.items.additionalProperties).toBe(false);
    expect(out.properties.pick.anyOf[0].additionalProperties).toBe(false);
    expect(out.properties.pick.anyOf[1].additionalProperties).toBeUndefined();
    expect(out.properties.one.oneOf[0].additionalProperties).toBe(false);
    expect(out.properties.all.allOf[0].additionalProperties).toBe(false);
    expect(out.$defs.thing.additionalProperties).toBe(false);
    expect(out.$defs.thing.properties.deep.additionalProperties).toBe(false);
    expect(out.definitions.legacy.additionalProperties).toBe(false);
  });

  it("leaves `required` exactly as authored (optional properties stay optional)", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a"],
    };
    const out = strictify(schema) as any;
    expect(out.required).toEqual(["a"]);
    const validate = createValidator(out);
    expect(validate('{"a": 1}')).toEqual({ ok: true, object: { a: 1 } }); // b optional, as authored
    const missing = validate('{"b": 2}');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors).toMatch(/required/);
  });

  it("does not invent a `required` list when the schema has none", () => {
    const out = strictify({ type: "object", properties: { a: { type: "number" } } }) as any;
    expect(out.required).toBeUndefined();
  });

  it("preserves a map-style additionalProperties sub-schema and recurses into it", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "object",
          additionalProperties: { type: "object", properties: { v: { type: "number" } } },
        },
      },
      required: ["tags"],
    };
    const out = strictify(schema) as any;
    const ap = out.properties.tags.additionalProperties;
    expect(typeof ap).toBe("object");
    expect(ap.additionalProperties).toBe(false); // recursed into the sub-schema
    const validate = createValidator(out);
    expect(validate('{"tags": {"anyKey": {"v": 1}, "other": {}}}').ok).toBe(true);
    expect(validate('{"tags": {"anyKey": {"v": 1, "extra": 2}}}').ok).toBe(false);
  });

  it("preserves an explicit additionalProperties boolean", () => {
    const open = strictify({ type: "object", properties: { a: { type: "number" } }, additionalProperties: true }) as any;
    expect(open.additionalProperties).toBe(true);
    const closed = strictify({ type: "object", additionalProperties: false }) as any;
    expect(closed.additionalProperties).toBe(false);
  });

  it("treats bare `properties` (no explicit type) as an object node", () => {
    const schema = { properties: { a: { type: "string" } } };
    const out = strictify(schema) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.required).toBeUndefined();
  });

  it("never mutates the input schema", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "object", properties: { b: { type: "string" } } },
        list: { type: "array", items: { type: "object", properties: { c: { type: "number" } } } },
      },
    };
    const snapshot = structuredClone(schema);
    const out = strictify(schema);
    expect(schema).toEqual(snapshot);
    expect(out).not.toBe(schema);
    expect((out as any).properties.a).not.toBe(schema.properties.a);
    expect(out).not.toEqual(schema);
  });
});

describe("extractJson", () => {
  it("returns the whole string when it parses as-is", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
    expect(extractJson('  {"a":1}\n')).toBe('  {"a":1}\n');
  });

  it("extracts from markdown fences", () => {
    const text = 'Here you go:\n```json\n{"a": 1, "b": [2, 3]}\n```\nHope that helps!';
    expect(JSON.parse(extractJson(text))).toEqual({ a: 1, b: [2, 3] });
  });

  it("extracts the first balanced object amid prose", () => {
    expect(extractJson('sure! {"x": {"y": 2}} trailing words')).toBe('{"x": {"y": 2}}');
  });

  it("extracts arrays too", () => {
    expect(extractJson("result: [1, 2, 3] done")).toBe("[1, 2, 3]");
  });

  it("respects braces and escapes inside strings", () => {
    const text = 'note {"a": "curly } and \\" quote", "b": "[["} end';
    expect(JSON.parse(extractJson(text))).toEqual({ a: 'curly } and " quote', b: "[[" });
  });

  it("skips a balanced-but-invalid block and finds a later valid one", () => {
    const text = 'bad { not json } then {"ok": true}';
    expect(extractJson(text)).toBe('{"ok": true}');
  });

  it("throws when no JSON is present", () => {
    expect(() => extractJson("no json here at all")).toThrow(/no JSON/);
  });
});

describe("createValidator", () => {
  const schema = strictify({
    type: "object",
    properties: { a: { type: "number" } },
  });

  it("accepts a valid object (with fences/prose tolerated)", () => {
    const validate = createValidator(schema);
    expect(validate('{"a": 1}')).toEqual({ ok: true, object: { a: 1 } });
    const fenced = validate('```json\n{"a": 2}\n```');
    expect(fenced).toEqual({ ok: true, object: { a: 2 } });
  });

  it("rejects wrong types with readable errors", () => {
    const validate = createValidator(schema);
    const res = validate('{"a": "nope"}');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toMatch(/number/);
  });

  it("rejects extra properties under the strictified schema", () => {
    const validate = createValidator(schema);
    const res = validate('{"a": 1, "extra": true}');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toMatch(/additional propert/i);
  });

  it("rejects non-JSON text with the extraction error", () => {
    const validate = createValidator(schema);
    const res = validate("not json");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toMatch(/no JSON/);
  });

  it("reports missing required keys", () => {
    const validate = createValidator(
      strictify({
        type: "object",
        properties: { a: { type: "number" }, b: { type: "string" } },
        required: ["a", "b"],
      }),
    );
    const res = validate("{}");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toMatch(/required/);
  });
});

describe("schemaInstruction", () => {
  it("wraps the inlined schema in a structured_output_contract block", () => {
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const text = schemaInstruction(schema);
    expect(text).toContain("<structured_output_contract>");
    expect(text).toContain("</structured_output_contract>");
    expect(text).toContain(JSON.stringify(schema));
    expect(text).toMatch(/ONLY with a single JSON object/);
  });
});

describe("assemblePrompt", () => {
  it("wraps the prompt in <task> and adds the plain-text output contract", () => {
    const out = assemblePrompt({ prompt: "do the thing" });
    expect(out).toContain("<task>\ndo the thing\n</task>");
    expect(out).toContain(RETURN_VALUE_CONTRACT);
    expect(out).toContain("<compact_output_contract>");
    expect(out).toContain("<default_follow_through_policy>");
    expect(out).not.toContain("<structured_output_contract>");
  });

  it("uses the schema instruction when a schema is given", () => {
    const schema = { type: "object", properties: { a: { type: "number" } } };
    const out = assemblePrompt({ prompt: "extract", schema });
    expect(out).toContain("<structured_output_contract>");
    expect(out).toContain(JSON.stringify(schema));
    expect(out).toContain(RETURN_VALUE_CONTRACT);
    expect(out).not.toContain("<compact_output_contract>");
  });

  it("prepends the profile preamble as its own paragraph", () => {
    const out = assemblePrompt({ prompt: "look around", profilePreamble: "You are read-only." });
    expect(out.startsWith("You are read-only.\n\n<task>")).toBe(true);
  });
});
