// GET → returns the current user (or 401). Also surfaces `first_run`: true
// when there are zero users in the DB, so the login page can default to
// "Create account" without an extra probe.
import { setActorFromSession } from "@/lib/auth.js";
import { getDb } from "@/lib/db.js";

export const dynamic = "force-dynamic";

function firstRun() {
  try { return getDb().prepare("SELECT COUNT(*) c FROM users").get().c === 0; }
  catch { return false; }
}

export async function GET(req) {
  const u = setActorFromSession(req);
  if (!u) return Response.json({ user: null, first_run: firstRun() }, { status: 401 });
  return Response.json({
    user: {
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      role: u.role,
      must_change_password: !!(u.must_change_password),
    },
    first_run: false,
  });
}
