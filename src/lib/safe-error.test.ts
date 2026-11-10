import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { safeErrorFields } from "@/lib/safe-error";

describe("safeErrorFields", () => {
  it("keeps only the code and constraint of a database error", () => {
    const cause = Object.assign(new Error("x"), { code: "23505", constraint_name: "item_pkey", detail: "Key (id)=(secret) already exists." });
    const out = safeErrorFields(new DrizzleQueryError("select $1", ["secret"], cause));
    expect(out).toEqual({ error: "database query failed", name: "Error", code: "23505", constraint: "item_pkey" });
  });

  it("drops a code or constraint that doesn't look like one", () => {
    const cause = { code: "secret@example.com", constraint_name: "has spaces (secret)" };
    const out = safeErrorFields(new DrizzleQueryError("select $1", ["x"], cause as unknown as Error));
    expect(out).toEqual({ error: "database query failed", name: "Error" });
  });

  it("passes ordinary errors and non-errors through safely", () => {
    expect(safeErrorFields(new TypeError("nope"))).toEqual({ error: "nope", name: "TypeError" });
    expect(safeErrorFields("secret string")).toEqual({ error: "non-error thrown" });
  });
});
