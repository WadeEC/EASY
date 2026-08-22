import { bindRequest } from "@/lib/actor.js";
// Self-service password change. Signed-in user provides current + new password;
// the auth lib verifies the current one, applies the new one, and clears any
// must-change-password or reset-request flags so the user is no longer nagged.
import { setActorFromSession, changeMyPassword } from "@/lib/auth.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const u = setActorFromSession(req);
  if (!u) return Response.json({ error: "Sign in required." }, { status: 401 });
  let b = {};
  try { b = await req.json(); } catch {}
  const res = changeMyPassword(u.id, b?.current_password, b?.new_password);
  if (res.error) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ ok: true });
}
