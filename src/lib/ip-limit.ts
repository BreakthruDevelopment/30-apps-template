import { isIP } from "node:net";

/**
 * Per-IP fixed-window limiter for public routes (token links, webhooks, sign-up forms): 60 requests per IP per minute.
 * In memory, so it is per app instance; the proxy or gateway in front is the second layer. Never use it for anything
 * that must hold across instances (that needs a database row, like the per-user limits in `usage.ts`).
 *
 * - IPv6 clients are keyed by their /64. One household or host controls a whole /64, so keying by the full address
 *   would let a single client pick a fresh key per request. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is keyed as IPv4.
 * - The table is bounded. When it is full, expired windows go first; if it is still full the OLDEST window is evicted,
 *   so a flood of spoofed or rotating addresses cannot lock out genuine new visitors (it can only reset its own counts).
 */
const WINDOW_MS = 60_000;
export const PUBLIC_LIMIT_PER_MINUTE = 60;
const MAX_TRACKED_IPS = 10_000;

// Insertion order is window-start order: a restarted window is deleted and re-inserted, so the first key is the oldest.
const hits = new Map<string, { windowStart: number; n: number }>();

/** Returns true when this request is allowed. `now` is a parameter for tests. */
export function allowPublicRequest(ip: string, now: number = Date.now(), limit: number = PUBLIC_LIMIT_PER_MINUTE): boolean {
  const key = limiterKey(ip);
  const entry = hits.get(key);
  if (entry && now - entry.windowStart < WINDOW_MS) {
    entry.n += 1;
    return entry.n <= limit;
  }
  hits.delete(key);
  if (hits.size >= MAX_TRACKED_IPS) {
    for (const [k, v] of hits) {
      if (now - v.windowStart < WINDOW_MS) break; // oldest first: everything after this one is still live
      hits.delete(k);
    }
    if (hits.size >= MAX_TRACKED_IPS) {
      const oldest = hits.keys().next().value;
      if (oldest !== undefined) hits.delete(oldest);
    }
  }
  hits.set(key, { windowStart: now, n: 1 });
  return true;
}

/**
 * The key a client is counted under: the address itself for IPv4, the /64 prefix for IPv6, `unknown` for anything else.
 * Exported for tests and for apps that want to log the key.
 */
export function limiterKey(ip: string): string {
  let value = ip.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value); // [2001:db8::1] or [2001:db8::1]:443
  if (bracketed) value = bracketed[1];
  value = value.split("%")[0];
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value); // some proxies append the source port to IPv4
  if (withPort) value = withPort[1];
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind === 6) {
    const groups = expandV6(value);
    return groups ? `${groups.slice(0, 4).join(":")}::/64` : "unknown";
  }
  return "unknown";
}

function expandV6(address: string): string[] | null {
  let text = address.toLowerCase();
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text); // embedded IPv4 in the low 32 bits
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    text = text.slice(0, tail.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  return all.length === 8 ? all.map((g) => g.replace(/^0+(?=.)/, "")) : null;
}

/**
 * The client address, from `X-Forwarded-For`. The rule is "trust the LAST entry": it is the one the platform's own
 * front end appended; everything before it is whatever the caller claimed and can be spoofed. That holds when exactly
 * one proxy of ours sits in front of the app:
 *   - AWS (API Gateway, ALB, Lambda function URL): appends the connecting client IP last. OK.
 *   - Azure Container Apps (Envoy ingress): appends the connecting client IP last. OK.
 *   - Google Cloud Run served directly: appends the connecting client IP last. OK. Behind a Google external load
 *     balancer the header ends `client, load-balancer`, so the last entry is the balancer's: take the second to last.
 *   - Oracle (Caddy on the VM) and any other reverse proxy: Caddy's `reverse_proxy` replaces a client-supplied header
 *     with the connecting address unless `trusted_proxies` is set, so the last entry is right. Confirm once with a curl
 *     that sends a fake `X-Forwarded-For`, and check that the fake value is NOT the one returned.
 * When a request arrives with no header (local dev, a direct hit), Next fills `X-Forwarded-For` from the socket, so you
 * get the connecting address. "unknown" only happens where no server sets it (unit tests, odd runtimes) and all of those share one bucket. If a second proxy is ever
 * added in front of the app, revisit this function; otherwise every visitor will share the proxy's address.
 */
export function clientIp(request: Request): string {
  return clientIpFromHeaders(request.headers);
}

/** Same rule for code with no `Request`, such as a page reading `headers()` from `next/headers`. */
export function clientIpFromHeaders(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-forwarded-for");
  const last = forwarded?.split(",").pop()?.trim();
  return last || "unknown";
}

/** For tests. */
export function resetPublicLimiter(): void {
  hits.clear();
}
