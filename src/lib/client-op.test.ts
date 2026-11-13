import { describe, expect, it } from "vitest";
import { GENERIC_ACTION_ERROR, opFor, runAsyncAction } from "./client-op";

describe("opFor (idempotent client ops)", () => {
  let n = 0;
  const mint = () => `id-${++n}`;

  it("reuses the id while the payload is unchanged, and mints a new one when it changes", () => {
    const first = opFor(null, { title: "a" }, mint);
    expect(opFor(first, { title: "a" }, mint)).toBe(first);
    const changed = opFor(first, { title: "b" }, mint);
    expect(changed.id).not.toBe(first.id);
  });

  it("a cleared ref (server answered) starts a fresh op even for the same payload", () => {
    const first = opFor(null, { title: "a" }, mint);
    expect(opFor(null, { title: "a" }, mint).id).not.toBe(first.id);
  });

  it("defaults to crypto.randomUUID", () => {
    expect(opFor(null, {}).id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("runAsyncAction (buttons that reset in finally)", () => {
  const harness = () => {
    const log: string[] = [];
    return {
      log,
      ui: {
        setPending: (p: boolean) => log.push(`pending:${p}`),
        setError: (e: string | null) => log.push(`error:${e}`),
      },
    };
  };

  it("sets pending, runs the work, and resets pending on success", async () => {
    const h = harness();
    await runAsyncAction(async () => {}, h.ui);
    expect(h.log).toEqual(["pending:true", "error:null", "pending:false"]);
  });

  it("resets pending and shows a fixed message when the work throws, never the thrown text", async () => {
    const h = harness();
    await runAsyncAction(async () => {
      throw new Error("select * from secret_table failed");
    }, h.ui);
    expect(h.log).toEqual(["pending:true", "error:null", `error:${GENERIC_ACTION_ERROR}`, "pending:false"]);
    expect(h.log.join()).not.toContain("secret_table");
  });

  it("uses the caller's message, and clears the previous error on the next run", async () => {
    const h = harness();
    await runAsyncAction(() => Promise.reject(new Error("x")), h.ui, "Couldn't save.");
    await runAsyncAction(async () => {}, h.ui);
    expect(h.log).toContain("error:Couldn't save.");
    expect(h.log.slice(-3)).toEqual(["pending:true", "error:null", "pending:false"]);
  });
});
