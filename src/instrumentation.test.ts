import { afterEach, describe, expect, it, vi } from "vitest";

const startJobs = vi.fn(async () => true);
const migrateOnStart = vi.fn(async () => {});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  startJobs.mockClear();
  migrateOnStart.mockClear();
});

async function register(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.doMock("./lib/jobs/start", () => ({ startJobs }));
  vi.doMock("./lib/db/migrate-on-start", () => ({ migrateOnStart }));
  await (await import("./instrumentation")).register();
  await Promise.resolve();
}

describe("register (instrumentation.ts)", () => {
  it("does nothing during `next build`, so the build never opens a database pool", async () => {
    await register({ NEXT_RUNTIME: "nodejs", NEXT_PHASE: "phase-production-build", MIGRATE_ON_START: "true" });
    expect(migrateOnStart).not.toHaveBeenCalled();
    expect(startJobs).not.toHaveBeenCalled();
  });

  it("does nothing outside the node runtime", async () => {
    await register({ NEXT_RUNTIME: "edge" });
    expect(startJobs).not.toHaveBeenCalled();
  });

  it("migrates when asked, then starts the jobs", async () => {
    await register({ NEXT_RUNTIME: "nodejs", MIGRATE_ON_START: "true" });
    expect(migrateOnStart).toHaveBeenCalledOnce();
    expect(startJobs).toHaveBeenCalledOnce();
  });

  it("does not wait for jobs: a rejected start is logged, not thrown", async () => {
    startJobs.mockRejectedValueOnce(new Error("db down"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await register({ NEXT_RUNTIME: "nodejs", LOG_LEVEL: "error" });
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      expect(String(logged.mock.calls[0][0])).toContain("jobs.start_failed");
    } finally {
      logged.mockRestore();
    }
    expect(startJobs).toHaveBeenCalledOnce();
  });
});
