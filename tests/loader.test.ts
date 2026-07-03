import { describe, expect, it } from "vitest";
import { ScriptError, loadScript, parseMeta } from "../src/loader.js";
import type { WorkflowGlobals } from "../src/types.js";

function makeGlobals(overrides?: Partial<WorkflowGlobals>): WorkflowGlobals {
  return {
    agent: async () => null,
    parallel: async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
    pipeline: async (items) => items,
    phase: () => {},
    log: () => {},
    args: undefined,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    workflow: async () => null,
    ...overrides,
  };
}

const META = `export const meta = { name: "t", description: "d" };\n`;

describe("parseMeta", () => {
  it("parses a minimal meta", () => {
    const { meta, metaStart, metaEnd } = parseMeta(META);
    expect(meta).toEqual({ name: "t", description: "d" });
    expect(metaStart).toBe(0);
    expect(META.slice(metaStart, metaEnd)).toBe(META.trimEnd());
  });

  it("parses optional fields and nested phases", () => {
    const src = `export const meta = {
  name: "wf",
  description: "does stuff",
  whenToUse: "when needed",
  phases: [{ title: "Draft" }, { title: "Critique", detail: "adversarial", model: "opus" }],
};\nreturn 1;\n`;
    const { meta } = parseMeta(src);
    expect(meta.whenToUse).toBe("when needed");
    expect(meta.phases).toEqual([
      { title: "Draft" },
      { title: "Critique", detail: "adversarial", model: "opus" },
    ]);
  });

  it("accepts template literals without interpolation", () => {
    const src = "export const meta = { name: `my-name`, description: `my desc` };";
    const { meta } = parseMeta(src);
    expect(meta.name).toBe("my-name");
    expect(meta.description).toBe("my desc");
  });

  it("statically evaluates unary +/- and null/boolean literals", () => {
    const src = `export const meta = { name: "t", description: "d", weight: -3, bonus: +2, flag: true, nothing: null };`;
    expect(() => parseMeta(src)).not.toThrow();
  });

  it("returns byte offsets that cover exactly the meta statement", () => {
    const src = `export const meta = { name: "w", description: "d" };\nconst x = 1;\nreturn x;\n`;
    const { metaStart, metaEnd } = parseMeta(src);
    expect(src.slice(metaStart, metaEnd)).toBe(`export const meta = { name: "w", description: "d" };`);
  });

  it("parses despite top-level return in the body", () => {
    const { meta } = parseMeta(META + "return 42;\n");
    expect(meta.name).toBe("t");
  });
});

describe("parseMeta rejections", () => {
  it("rejects empty source", () => {
    expect(() => parseMeta("")).toThrow(ScriptError);
  });

  it("rejects a script whose first statement is not the meta export", () => {
    expect(() => parseMeta("const x = 1;\n")).toThrow(ScriptError);
    expect(() => parseMeta(`export let meta = { name: "x", description: "y" };`)).toThrow(ScriptError);
    expect(() => parseMeta(`export const other = { name: "x", description: "y" };`)).toThrow(ScriptError);
  });

  it("rejects spread in the meta object", () => {
    const src = `export const meta = { name: "x", description: "y", ...extra };\n`;
    expect(() => parseMeta(src)).toThrow(/spread/);
  });

  it("rejects spread in a meta array", () => {
    const src = `export const meta = { name: "x", description: "y", phases: [...more] };\n`;
    expect(() => parseMeta(src)).toThrow(/spread/);
  });

  it("rejects function calls in meta", () => {
    const src = `export const meta = { name: makeName(), description: "y" };\n`;
    expect(() => parseMeta(src)).toThrow(/CallExpression/);
  });

  it("rejects identifier references in meta", () => {
    const src = `export const meta = { name: NAME, description: "y" };\n`;
    expect(() => parseMeta(src)).toThrow(/Identifier/);
  });

  it("rejects member access in meta", () => {
    const src = `export const meta = { name: pkg.name, description: "y" };\n`;
    expect(() => parseMeta(src)).toThrow(ScriptError);
  });

  it("rejects template literals with interpolation", () => {
    const src = "export const meta = { name: `a${1}`, description: 'y' };\n";
    expect(() => parseMeta(src)).toThrow(/interpolation/);
  });

  it("rejects missing name / missing description / empty name", () => {
    expect(() => parseMeta(`export const meta = { description: "y" };`)).toThrow(/meta\.name/);
    expect(() => parseMeta(`export const meta = { name: "x" };`)).toThrow(/meta\.description/);
    expect(() => parseMeta(`export const meta = { name: "", description: "y" };`)).toThrow(/meta\.name/);
    expect(() => parseMeta(`export const meta = { name: 3, description: "y" };`)).toThrow(/meta\.name/);
  });

  it("rejects non-object meta", () => {
    expect(() => parseMeta(`export const meta = "nope";`)).toThrow(/object literal/);
  });

  it("attaches the source line to ScriptError for impure nodes", () => {
    const src = `export const meta = {\n  name: "x",\n  description: y(),\n};\n`;
    let err: ScriptError | undefined;
    try {
      parseMeta(src);
    } catch (e) {
      err = e as ScriptError;
    }
    expect(err).toBeInstanceOf(ScriptError);
    expect(err?.line).toBe(3);
  });
});

describe("loadScript round-trip", () => {
  it("compiles the body and returns its value", async () => {
    const loaded = loadScript(META + "return 42;\n", { strict: false });
    expect(loaded.meta.name).toBe("t");
    expect(loaded.source).toBe(META + "return 42;\n");
    expect(await loaded.body(makeGlobals())).toBe(42);
  });

  it("wires injected globals: agent/parallel/phase/log/args/budget/workflow/pipeline", async () => {
    const src =
      META +
      `phase("Draft");
log("starting");
const solo = await agent("solo prompt", { label: "one" });
const both = await parallel([() => agent("a"), () => agent("b")]);
const piped = await pipeline([1, 2]);
const child = await workflow("child", { deep: true });
return { solo, both, piped, child, total: budget.total, left: budget.remaining(), args };
`;
    const phases: string[] = [];
    const logs: string[] = [];
    const loaded = loadScript(src, { strict: false });
    const result = await loaded.body(
      makeGlobals({
        agent: async (prompt) => `echo:${prompt}`,
        phase: (t) => void phases.push(t),
        log: (m) => void logs.push(m),
        args: { key: "value" },
        workflow: async (name, a) => ({ name, a }),
      }),
    );
    expect(result).toEqual({
      solo: "echo:solo prompt",
      both: ["echo:a", "echo:b"],
      piped: [1, 2],
      child: { name: "child", a: { deep: true } },
      total: null,
      left: Infinity,
      args: { key: "value" },
    });
    expect(phases).toEqual(["Draft"]);
    expect(logs).toEqual(["starting"]);
  });

  it("supports top-level await", async () => {
    const src = META + `const x = await Promise.resolve(99);\nreturn x + 1;\n`;
    expect(await loadScript(src, { strict: false }).body(makeGlobals())).toBe(100);
  });

  it("supports top-level return without await", async () => {
    expect(await loadScript(META + `return "done";\n`, { strict: false }).body(makeGlobals())).toBe("done");
  });

  it("body without a return resolves undefined", async () => {
    expect(await loadScript(META + "const x = 1;\n", { strict: false }).body(makeGlobals())).toBeUndefined();
  });

  it("vm intrinsics (JSON, structuredClone, URL) are usable", async () => {
    const src =
      META +
      `const clone = structuredClone({ a: [1, 2] });
const u = new URL("https://example.com/p");
return JSON.stringify({ clone, host: u.host });
`;
    const result = await loadScript(src, { strict: false }).body(makeGlobals());
    expect(JSON.parse(result as string)).toEqual({ clone: { a: [1, 2] }, host: "example.com" });
  });

  it("console.log/error/warn forward to stderr", async () => {
    const src = META + `console.log("plain", { n: 1 });\nconsole.error("bad");\nconsole.warn("careful");\nreturn 0;\n`;
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as NodeJS.WriteStream).write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await loadScript(src, { strict: false }).body(makeGlobals());
    } finally {
      (process.stderr as NodeJS.WriteStream).write = original;
    }
    const out = chunks.join("");
    expect(out).toContain("plain {\"n\":1}");
    expect(out).toContain("bad");
    expect(out).toContain("careful");
  });
});

describe("loadScript line numbers", () => {
  it("stack line matches the source line after meta stripping", async () => {
    const src = `${META}// line 2
// line 3
// line 4
throw new Error("boom");
`;
    const loaded = loadScript(src, { strict: false });
    const err = await loaded.body(makeGlobals()).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toBe("boom");
    expect(err?.stack).toMatch(/workflow\.js:5:/);
  });

  it("multi-line meta keeps body line numbers correct", async () => {
    const src = `export const meta = {
  name: "t",
  description: "d",
};
// line 5
// line 6
throw new Error("here");
`;
    const err = await loadScript(src, { strict: false })
      .body(makeGlobals())
      .then(
        () => null,
        (e: Error) => e,
      );
    expect(err?.message).toBe("here");
    expect(err?.stack).toMatch(/workflow\.js:7:/);
  });
});

describe("loadScript rejects non-plain-JS bodies", () => {
  it("TypeScript type annotation → ScriptError", () => {
    const src = META + "const x: number = 5;\nreturn x;\n";
    expect(() => loadScript(src, { strict: false })).toThrow(ScriptError);
  });

  it("TypeScript interface → ScriptError", () => {
    const src = META + "interface Foo { bar: string }\nreturn 1;\n";
    expect(() => loadScript(src, { strict: false })).toThrow(ScriptError);
  });

  it("import statements in the body → ScriptError", () => {
    const src = META + `import fs from "node:fs";\nreturn 1;\n`;
    expect(() => loadScript(src, { strict: false })).toThrow(ScriptError);
  });
});

describe("loadScript strict mode", () => {
  it("Date.now() throws", async () => {
    const loaded = loadScript(META + "return Date.now();\n", { strict: true });
    await expect(loaded.body(makeGlobals())).rejects.toThrow(
      "Date.now() is not allowed in workflow scripts (resume determinism)",
    );
  });

  it("Math.random() throws", async () => {
    const loaded = loadScript(META + "return Math.random();\n", { strict: true });
    await expect(loaded.body(makeGlobals())).rejects.toThrow(
      "Math.random() is not allowed in workflow scripts (resume determinism)",
    );
  });

  it("argless new Date() throws", async () => {
    const loaded = loadScript(META + "return new Date();\n", { strict: true });
    await expect(loaded.body(makeGlobals())).rejects.toThrow(
      "new Date() with no arguments is not allowed in workflow scripts (resume determinism)",
    );
  });

  it("new Date(ms) and new Date(iso) still work", async () => {
    const src = META + `return [new Date(0).getUTCFullYear(), new Date("2024-06-01T00:00:00Z").getUTCMonth()];\n`;
    const result = (await loadScript(src, { strict: true }).body(makeGlobals())) as number[];
    expect(result).toEqual([1970, 5]);
  });

  it("Date.parse and other Math members still work", async () => {
    const src = META + `return { parsed: Date.parse("2024-01-01T00:00:00Z"), max: Math.max(1, 2) };\n`;
    const result = (await loadScript(src, { strict: true }).body(makeGlobals())) as {
      parsed: number;
      max: number;
    };
    expect(result.parsed).toBe(1704067200000);
    expect(result.max).toBe(2);
  });
});

describe("loadScript non-strict mode leaves intrinsics alone", () => {
  it("Date.now(), Math.random(), argless new Date() all work", async () => {
    const src = META + `return [Date.now(), Math.random(), new Date().getTime()];\n`;
    const [now, rand, ctor] = (await loadScript(src, { strict: false }).body(makeGlobals())) as number[];
    expect(now).toBeGreaterThan(0);
    expect(rand).toBeGreaterThanOrEqual(0);
    expect(rand).toBeLessThan(1);
    expect(ctor).toBeGreaterThan(0);
  });
});

describe("loadScript context isolation", () => {
  it("require, process, and Buffer are not exposed", async () => {
    const src = META + `return [typeof require, typeof process, typeof Buffer];\n`;
    const result = await loadScript(src, { strict: false }).body(makeGlobals());
    expect(result).toEqual(["undefined", "undefined", "undefined"]);
  });
});

describe("ScriptError", () => {
  it("is an Error with name and optional line", () => {
    const e = new ScriptError("msg", 7);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ScriptError");
    expect(e.line).toBe(7);
    expect(new ScriptError("no line").line).toBeUndefined();
  });
});
