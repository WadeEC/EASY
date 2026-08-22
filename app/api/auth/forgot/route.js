import { bindRequest } from "@/lib/actor.js";
// "I forgot my password" — anonymous endpoint. Always returns ok regardless of
// whether the username exists (so attackers can't probe usernames). If the
// account does exist, it gets flagged as `password_reset_requested=1` so any
// signed-in admin sees the badge on the Users page and can reset it.
import { requestPasswordReset } from "@/lib/auth.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  let b = {};
  try { b = await req.json(); } catch {}
  const username = String(b?.username || "").trim();
  if (!username) return Response.json({ error: "Username is required." }, { status: 400 });
  requestPasswordReset(username);
  return Response.json({
    ok: true,
    message: "Reset requested. Contact your admin to set a new password.",
  });
}
