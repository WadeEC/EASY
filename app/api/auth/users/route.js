import { bindRequest } from "@/lib/actor.js";
// User-management endpoint.
//
//   GET                                 → list users (admin only, no password hashes)
//   POST { action:"create", … }         → open to anyone (self-signup). Every new
//                                          account is created with role "admin"
//                                          so all members of the team have equal access.
//   POST { action:"set_password", … }   → admin only
//   POST { action:"set_role", … }       → admin only
//   POST { action:"disable", … }        → admin only
//
// Self-signup is open by design — for a small trusted team sharing a private
// URL the friction of pre-creating accounts isn't worth it. The audit log
// stamps every action with the creating user's name, and admins can disable
// rogue accounts from the Users page if needed.

import { listUsers, createUser, setPassword, setUserRole, disableUser, setActorFromSession, getUserByUsername } from "@/lib/auth.js";
import { getDb, logAudit } from "@/lib/db.js";

export const dynamic = "force-dynamic";

function isAdmin(u) { return !!u && u.role === "admin"; }

export async function GET(req) {
  bindRequest(req);
  const u = setActorFromSession(req);
  if (!isAdmin(u)) return Response.json({ error: "Admin only." }, { status: 403 });
  return Response.json({ users: listUsers() });
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json().catch(() => ({}));
  const u = setActorFromSession(req);
  // "create" is open to anyone (self-signup). Every other action is admin-only.
  const allowed = b.action === "create" || isAdmin(u);
  if (!allowed) return Response.json({ error: "Admin only." }, { status: 403 });

  if (b.action === "create") {
    // Self-signups always land as "admin" — by policy everyone on the team
    // has equal access. Only an existing admin can downgrade later from the
    // Users page (set_role action).
    const role = isAdmin(u) ? (b.role || "admin") : "admin";
    const res = createUser({ username: b.username, password: b.password, display_name: b.display_name || "", role });
    if (res.error) return Response.json({ error: res.error });
    logAudit(u?.display_name || u?.username || "self-signup", "create", "users", res.id, null, { username: res.username, role: res.role }, "created user");
    return Response.json(res);
  }
  if (b.action === "set_password") {
    // When an admin resets someone else's password, the user is forced to pick
    // a new one on next sign-in (force_change). When you reset your OWN
    // password from this endpoint we don't force a change.
    const force = !!b.force_change;
    const res = setPassword(Number(b.id), b.password, { forceChange: force });
    if (res.error) return Response.json({ error: res.error });
    logAudit(u?.display_name || u?.username, "update", "users", Number(b.id), null, { force_change: force }, "password reset");
    return Response.json(res);
  }
  if (b.action === "set_role") {
    const res = setUserRole(Number(b.id), b.role);
    if (res.error) return Response.json({ error: res.error });
    logAudit(u?.display_name || u?.username, "update", "users", Number(b.id), null, { role: b.role }, "role changed");
    return Response.json(res);
  }
  if (b.action === "disable") {
    const res = disableUser(Number(b.id), !!b.on);
    logAudit(u?.display_name || u?.username, "update", "users", Number(b.id), null, { disabled: !!b.on }, b.on ? "disabled" : "re-enabled");
    return Response.json(res);
  }
  return Response.json({ error: "unknown action" });
}
