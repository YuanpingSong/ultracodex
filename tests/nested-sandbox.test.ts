import { describe, expect, it } from "vitest";
import { resolveNestedSandbox } from "../src/executor/codex.js";

describe("resolveNestedSandbox", () => {
  it("downgrades workspace-write inside a seatbelt sandbox (outer boundary holds)", () => {
    expect(resolveNestedSandbox("workspace-write", true)).toEqual({
      sandbox: "danger-full-access",
      downgraded: true,
    });
    expect(resolveNestedSandbox("read-only", true)).toEqual({
      sandbox: "danger-full-access",
      downgraded: true,
    });
  });

  it("passes danger-full-access through unchanged when nested", () => {
    expect(resolveNestedSandbox("danger-full-access", true)).toEqual({
      sandbox: "danger-full-access",
      downgraded: false,
    });
  });

  it("changes nothing outside a sandbox", () => {
    for (const s of ["read-only", "workspace-write", "danger-full-access"] as const) {
      expect(resolveNestedSandbox(s, false)).toEqual({ sandbox: s, downgraded: false });
    }
  });
});
