import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { migrateOnStart, migrationState } from "./migrate-on-start";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("migrateOnStart", () => {
  it("marks ok when the first attempt succeeds", async () => {
    const runOnce = vi.fn().mockResolvedValue(undefined);
    await migrateOnStart({ runOnce, sleep: async () => {}, delays: [1, 1] });
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(migrationState()).toBe("ok");
  });

  it("retries in the background until the database exists", async () => {
    const runOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error('database "x" does not exist'))
      .mockRejectedValueOnce(new Error('database "x" does not exist'))
      .mockResolvedValue(undefined);
    await migrateOnStart({ runOnce, sleep: async () => {}, delays: [1, 1, 1] });
    for (let i = 0; i < 10 && migrationState() !== "ok"; i++) await flush();
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(migrationState()).toBe("ok");
  });

  it("reports retrying while waiting, then failed after the last attempt", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runOnce = vi.fn().mockRejectedValue(new Error("down"));
    await migrateOnStart({ runOnce, sleep: () => gate, delays: [1, 1] });
    expect(migrationState()).toBe("retrying");
    release();
    for (let i = 0; i < 10 && migrationState() !== "failed"; i++) await flush();
    expect(runOnce).toHaveBeenCalledTimes(3);
    expect(migrationState()).toBe("failed");
  });
});
