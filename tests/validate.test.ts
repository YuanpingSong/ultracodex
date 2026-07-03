import { describe, expect, it } from "vitest";
import { validateWorkflowScript, type ValidationIssue } from "../src/validate.js";

const META = `export const meta = { name: "t", description: "d" };\n`;

function find(issues: ValidationIssue[], re: RegExp): ValidationIssue | undefined {
  return issues.find((i) => re.test(i.message));
}

describe("validateWorkflowScript — errors", () => {
  it("clean minimal script → no issues", () => {
    expect(validateWorkflowScript(META + `return await agent("hi");\n`)).toEqual([]);
  });

  it("missing meta → error", () => {
    const issues = validateWorkflowScript(`const x = 1;\nreturn x;\n`);
    const err = find(issues, /export const meta/);
    expect(err?.severity).toBe("error");
  });

  it("impure meta → error with line", () => {
    const issues = validateWorkflowScript(
      `export const meta = {\n  name: "x",\n  description: makeDesc(),\n};\n`,
    );
    const err = find(issues, /pure literal|CallExpression/);
    expect(err?.severity).toBe("error");
    expect(err?.line).toBe(3);
  });

  it("missing name / description → error", () => {
    expect(find(validateWorkflowScript(`export const meta = { description: "d" };`), /meta\.name/)?.severity).toBe("error");
    expect(find(validateWorkflowScript(`export const meta = { name: "x" };`), /meta\.description/)?.severity).toBe("error");
  });

  it("TypeScript syntax → parse error with line, and no other analysis", () => {
    const issues = validateWorkflowScript(META + `const x: number = 5;\nreturn x;\n`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toMatch(/failed to parse/);
    expect(issues[0]?.line).toBe(2);
  });

  it("meta error does not suppress body analysis", () => {
    const issues = validateWorkflowScript(`const x = Date.now();\n`);
    expect(find(issues, /export const meta/)?.severity).toBe("error");
    expect(find(issues, /Date\.now\(\)/)?.severity).toBe("warn");
  });
});

describe("validateWorkflowScript — determinism bans", () => {
  it("Date.now() → warn by default with 1-based line", () => {
    const issues = validateWorkflowScript(META + `// pad\nconst t = Date.now();\nreturn t;\n`);
    const w = find(issues, /Date\.now\(\)/);
    expect(w?.severity).toBe("warn");
    expect(w?.line).toBe(3);
  });

  it("Math.random() → warn by default", () => {
    const w = find(validateWorkflowScript(META + `return Math.random();\n`), /Math\.random\(\)/);
    expect(w?.severity).toBe("warn");
    expect(w?.line).toBe(2);
  });

  it("argless new Date() → warn; new Date(arg) → clean", () => {
    const w = find(validateWorkflowScript(META + `return new Date();\n`), /new Date\(\)/);
    expect(w?.severity).toBe("warn");
    expect(validateWorkflowScript(META + `return new Date(0);\n`)).toEqual([]);
  });

  it("strict → all three become errors", () => {
    const src = META + `const a = Date.now();\nconst b = Math.random();\nconst c = new Date();\nreturn [a, b, c];\n`;
    const issues = validateWorkflowScript(src, { strict: true });
    expect(issues).toHaveLength(3);
    for (const i of issues) expect(i.severity).toBe("error");
    expect(issues.map((i) => i.line)).toEqual([2, 3, 4]);
  });

  it("unrelated members are not flagged", () => {
    const src = META + `return [myDate.now(), Math.max(1, 2), Date.parse("2024-01-01"), new Foo()];\n`;
    expect(validateWorkflowScript(src)).toEqual([]);
  });
});

describe("validateWorkflowScript — phases vs phase() calls", () => {
  const PHASED_META = `export const meta = {
  name: "t",
  description: "d",
  phases: [{ title: "Draft" }, { title: "Critique" }],
};\n`;

  it("meta title with no phase() call → warn (points at meta)", () => {
    const issues = validateWorkflowScript(PHASED_META + `phase("Draft");\nreturn 1;\n`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warn");
    expect(issues[0]?.message).toMatch(/"Critique" has no matching phase\("Critique"\) call/);
    expect(issues[0]?.line).toBe(1);
  });

  it("phase() literal missing from meta.phases → warn with call line", () => {
    const issues = validateWorkflowScript(
      PHASED_META + `phase("Draft");\nphase("Critique");\nphase("Extra");\nreturn 1;\n`,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/phase\("Extra"\) does not match any meta\.phases title/);
    expect(issues[0]?.line).toBe(8);
  });

  it("all titles matched (incl. template literal call) → clean", () => {
    const src = PHASED_META + `phase("Draft");\nphase(\`Critique\`);\nreturn 1;\n`;
    expect(validateWorkflowScript(src)).toEqual([]);
  });

  it("no meta.phases → phase() calls never warn", () => {
    expect(validateWorkflowScript(META + `phase("Whatever");\nreturn 1;\n`)).toEqual([]);
  });

  it("dynamic phase(expr) calls are ignored by the matcher", () => {
    const issues = validateWorkflowScript(PHASED_META + `for (const t of ["Draft", "Critique"]) phase(t);\nreturn 1;\n`);
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining(`"Draft" has no matching`),
      expect.stringContaining(`"Critique" has no matching`),
    ]);
  });
});

describe("validateWorkflowScript — budget loops", () => {
  it("while (budget.remaining() ...) without any budget.total reference → warn", () => {
    const src = META + `while (budget.remaining() > 1000) {\n  await agent("more");\n}\nreturn 1;\n`;
    const issues = validateWorkflowScript(src);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warn");
    expect(issues[0]?.message).toMatch(/budget\.remaining\(\).*budget\.total/);
    expect(issues[0]?.line).toBe(2);
  });

  it("for-loop test using budget.remaining() → warn", () => {
    const src = META + `for (let i = 0; budget.remaining() > 0 && i < 10; i++) await agent("x");\nreturn 1;\n`;
    expect(find(validateWorkflowScript(src), /budget\.total/)?.line).toBe(2);
  });

  it("budget.total referenced anywhere → no warn", () => {
    const src =
      META +
      `if (budget.total === null) return "no budget";\nwhile (budget.remaining() > 1000) {\n  await agent("more");\n}\nreturn 1;\n`;
    expect(validateWorkflowScript(src)).toEqual([]);
  });

  it("loops not mentioning budget.remaining() → no warn", () => {
    const src = META + `let n = 3;\nwhile (n-- > 0) await agent("x");\nreturn 1;\n`;
    expect(validateWorkflowScript(src)).toEqual([]);
  });
});

describe("validateWorkflowScript — literal fan-out caps", () => {
  const arrayOf = (n: number): string => `[${Array(n).fill("0").join(",")}]`;

  it("parallel() with >4096-element array literal → warn", () => {
    const issues = validateWorkflowScript(META + `await parallel(${arrayOf(4097)});\nreturn 1;\n`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warn");
    expect(issues[0]?.message).toMatch(/parallel\(\).*4097.*4096/);
    expect(issues[0]?.line).toBe(2);
  });

  it("pipeline() with >4096-element array literal → warn", () => {
    const issues = validateWorkflowScript(META + `await pipeline(${arrayOf(4097)}, x => x);\nreturn 1;\n`);
    expect(find(issues, /pipeline\(\)/)?.severity).toBe("warn");
  });

  it("exactly 4096 elements → clean; non-literal first arg → clean", () => {
    expect(validateWorkflowScript(META + `await parallel(${arrayOf(4096)});\nreturn 1;\n`)).toEqual([]);
    expect(validateWorkflowScript(META + `await parallel(thunks);\nreturn 1;\n`)).toEqual([]);
  });
});

describe("validateWorkflowScript — realistic script stays clean", () => {
  it("multi-phase script with matching phases, parallel + schema agents → no issues", () => {
    const src = `export const meta = {
  name: "digest",
  description: "summarize docs",
  phases: [{ title: "Summarize" }, { title: "Synthesize" }],
};
phase("Summarize");
const parts = await parallel([() => agent("a"), () => agent("b")]);
phase("Synthesize");
log("combining");
return agent("combine: " + JSON.stringify(parts.filter(Boolean)));
`;
    expect(validateWorkflowScript(src, { strict: true })).toEqual([]);
  });
});
