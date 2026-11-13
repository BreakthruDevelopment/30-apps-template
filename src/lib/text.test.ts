import { describe, expect, it } from "vitest";
import { NUL_MESSAGE, hasNoNul, jsonHasNul, text } from "./text";

describe("text()", () => {
  it("trims, enforces min and max", () => {
    expect(text(5).parse("  hi  ")).toBe("hi");
    expect(text(5, { min: 1, minMessage: "Title is required" }).safeParse("   ").error?.issues[0].message).toBe("Title is required");
    expect(text(3).safeParse("abcd").success).toBe(false);
  });

  it("rejects a NUL byte anywhere, with a clear message", () => {
    for (const bad of ["a\0b", "\0", "tail\0", "\0head"]) {
      const r = text(50).safeParse(bad);
      expect(r.success).toBe(false);
      expect(r.error?.issues[0].message).toBe(NUL_MESSAGE);
    }
    expect(text(50).safeParse("plain   unicode ok").success).toBe(true);
  });

  it("hasNoNul and jsonHasNul agree on strings, keys and nesting", () => {
    expect(hasNoNul("ok")).toBe(true);
    expect(hasNoNul("a\0")).toBe(false);
    expect(jsonHasNul({ a: ["x", { b: "ok" }] })).toBe(false);
    expect(jsonHasNul({ a: ["x", { b: "bad\0" }] })).toBe(true);
    expect(jsonHasNul({ "k\0": 1 })).toBe(true);
    expect(jsonHasNul("literal \\u0000 text is not a NUL, but is conservatively refused")).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(jsonHasNul(cyclic)).toBe(true);
  });
});
