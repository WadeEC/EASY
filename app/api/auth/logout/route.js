import { bindRequest } from "@/lib/actor.js";
// POST → clears the current session.
import { logout, SESSION_COOKIE } from "@/lib/auth.js";

export const dynamic = "force-dynamic";

function readToken(req) {
  const cookie = req.headers.get("cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function POST(req) {
  bindRequest(req);
  const token = readToken(req);
  logout(token);
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const clear = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Set-Cookie": clear, "Cache-Control": "no-store" },
  });
}
