// Production guardrails — rate limiting + shared-secret auth.
//
// Rate limit: token bucket per IP. Defaults to 60 req/min, 600 req/hr.
// Auth: if APP_SECRET is set, every /api request must include either
//       `x-app-secret: <secret>` header OR a cookie named "ff_auth".
//       In dev (no APP_SECRET), auth is skipped — keeps local dev easy.
//
// Override with env: RATE_PER_MIN, RATE_PER_HOUR.

const PER_MIN = Number(process.env.RATE_PER_MIN || 60);
const PER_HOUR = Number(process.env.RATE_PER_HOUR || 600);
const SECRET = process.env.APP_SECRET || "";

const buckets = new Map(); // key -> { min: [], hour: [] }

function gc(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

function clientKey(req) {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

export function checkRate(req) {
  const key = clientKey(req);
  let b = buckets.get(key);
  if (!b) { b = { min: [], hour: [] }; buckets.set(key, b); }
  gc(b.min, 60_000);
  gc(b.hour, 3_600_000);
  if (b.min.length >= PER_MIN) return { ok: false, error: "Too many requests this minute", retryAfter: 60 };
  if (b.hour.length >= PER_HOUR) return { ok: false, error: "Hourly request cap reached", retryAfter: 3600 };
  const now = Date.now();
  b.min.push(now);
  b.hour.push(now);
  return { ok: true, key, perMinUsed: b.min.length, perHourUsed: b.hour.length };
}

export function checkAuth(req) {
  if (!SECRET) return { ok: true, mode: "open-dev" };
  const header = req.headers.get("x-app-secret");
  if (header && header === SECRET) return { ok: true, mode: "header" };
  const cookie = req.headers.get("cookie") || "";
  const m = /(?:^|;\s*)ff_auth=([^;]+)/.exec(cookie);
  if (m && decodeURIComponent(m[1]) === SECRET) return { ok: true, mode: "cookie" };
  return { ok: false, error: "Unauthorized" };
}

// Combined guard for use in API routes:
//   const g = guard(req); if (!g.ok) return g.response;
export function guard(req) {
  const auth = checkAuth(req);
  if (!auth.ok) {
    return { ok: false, response: Response.json({ error: auth.error }, { status: 401 }) };
  }
  const rate = checkRate(req);
  if (!rate.ok) {
    return {
      ok: false,
      response: Response.json({ error: rate.error }, { status: 429, headers: { "Retry-After": String(rate.retryAfter) } }),
    };
  }
  return { ok: true, auth, rate };
}

export function guardStatus() {
  return {
    auth_enforced: !!SECRET,
    rate_per_min: PER_MIN,
    rate_per_hour: PER_HOUR,
    active_clients: buckets.size,
  };
}
