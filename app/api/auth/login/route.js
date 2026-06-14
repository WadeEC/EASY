// POST { username, password } → sets httpOnly session cookie.
import { login, SESSION_COOKIE } from "@/lib/auth.js";

export const dynamic = "force-dynamic";

// Add Secure to the cookie when running behind HTTPS so browsers won't send it
// over plain HTTP. NODE_ENV=production on Render/Fly/Railway → cookie is Secure.
const COOKIE_SECURE = process.env.NODE_ENV === "production" ? "; Secure" : "";

export async function POST(req) {
  const b = await req.json().catch(() => ({}));
  const ua = req.headers.get("user-agent") || "";
  const res = login({ username: b.username, password: b.password, userAgent: ua });
  if (res.error) return Response.json({ error: res.error }, { status: 401 });
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(res.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${COOKIE_SECURE}`;
  return new Response(JSON.stringify({ ok: true, user: res.user }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}
