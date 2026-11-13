import { beforeEach, describe, expect, it } from "vitest";
import { allowPublicRequest, clientIp, clientIpFromHeaders, limiterKey, resetPublicLimiter } from "./ip-limit";

describe("public per-IP limiter", () => {
  beforeEach(resetPublicLimiter);

  it("allows 60 per minute per IP, then refuses, then resets with the window", () => {
    for (let i = 0; i < 60; i++) expect(allowPublicRequest("1.1.1.1", 1_000)).toBe(true);
    expect(allowPublicRequest("1.1.1.1", 2_000)).toBe(false);
    expect(allowPublicRequest("2.2.2.2", 2_000)).toBe(true);
    expect(allowPublicRequest("1.1.1.1", 61_001)).toBe(true);
  });

  it("uses the last X-Forwarded-For entry (the platform's), not what the caller claimed", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" } });
    expect(clientIp(req)).toBe("8.8.8.8");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });

  it("keys IPv6 clients by /64, so rotating the low 64 bits does not buy a fresh allowance", () => {
    for (let i = 0; i < 60; i++) expect(allowPublicRequest(`2001:db8:1:2::${i + 1}`, 1_000)).toBe(true);
    expect(allowPublicRequest("2001:db8:1:2:aaaa:bbbb:cccc:dddd", 1_500)).toBe(false);
    expect(allowPublicRequest("2001:db8:1:3::1", 1_500)).toBe(true); // another /64
  });

  it("normalises addresses to a stable key", () => {
    expect(limiterKey("2001:DB8:0001:0002:0:0:0:9")).toBe(limiterKey("2001:db8:1:2::9"));
    expect(limiterKey("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(limiterKey("::1")).toBe("0:0:0:0::/64");
    expect(limiterKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(limiterKey("[2001:db8::1]")).toBe("2001:db8:0:0::/64");
    expect(limiterKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(limiterKey("1.2.3.4:5555")).toBe("1.2.3.4");
    expect(limiterKey("64:ff9b::1.2.3.4")).toBe("64:ff9b:0:0::/64");
    expect(limiterKey("unknown")).toBe("unknown");
    expect(limiterKey("not-an-ip")).toBe("unknown");
    expect(limiterKey("")).toBe("unknown");
  });

  it("when the table is full, evicts the oldest window instead of refusing a new visitor", () => {
    for (let i = 0; i < 10_000; i++) allowPublicRequest(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 1_000 + i);
    // Still within every window: the table is full of live entries.
    expect(allowPublicRequest("203.0.113.9", 20_000)).toBe(true);
    // 10.0.0.0 was the oldest and was evicted, so it starts a fresh window and gets a full allowance.
    for (let i = 0; i < 60; i++) expect(allowPublicRequest("10.0.0.0", 21_000)).toBe(true);
    expect(allowPublicRequest("10.0.0.0", 21_000)).toBe(false);
  });

  it("when the table is full, drops expired windows first", () => {
    for (let i = 0; i < 10_000; i++) allowPublicRequest(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, 1_000);
    for (let i = 0; i < 59; i++) allowPublicRequest("10.0.0.1", 1_000); // 60 hits: at the limit
    expect(allowPublicRequest("10.0.0.1", 1_000)).toBe(false);
    expect(allowPublicRequest("203.0.113.9", 100_000)).toBe(true); // table full of expired windows: they are swept
    // The old window for 10.0.0.1 expired, so it counts from 1 again, and the sweep did not evict a live entry.
    for (let i = 0; i < 60; i++) expect(allowPublicRequest("10.0.0.1", 100_000)).toBe(true);
    expect(allowPublicRequest("10.0.0.1", 100_000)).toBe(false);
  });
});
