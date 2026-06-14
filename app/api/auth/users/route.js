// User-management endpoint. Admins only.
//
//   GET                                 → list users (no password hashes)
//   POST { action:"create", username, password, display_name?, role? }
//   POST { action:"set_password", id, password }
//   POST { action:"set_role", id, role }
//   POST { action:"disable", id, on:true|false }
//
// The session user must have role="admin". Bootstrap allows the first user to
// be created without a session (so the very first install can set up an account
// via the UI). After that, only an admin can mint more.

import { listUsers, createUser, setPassword, setUserRole, disableUser, setActorFromSession, getUserByUsername } from "@/lib/auth.js";
import { getDb, logAudit } from "@/lib/db.js";

export const dynamic = "force-dynamic";

function isAdmin(u) { return !!u && u.role === "admin"; }
function firstRun() {
  return getDb().prepare("SELECT COUNT(*) c FROM users").get().c === 0;
}

export async function GET(req) {
  const u = setActorFromSession(req);
  if (!isAdmin(u)) return Response.json({ error: "Admin only." }, { status: 403 });
  return Response.json({ users: listUsers() });
}

export async function POST(req) {
  const b = await req.json().catch(() => ({}));
  const u = setActorFromSession(req);
  const allowed = isAdmin(u) || (b.action === "create" && firstRun());
  if (!allowed) return Response.json({ error: "Admin only." }, { status: 403 });

  if (b.action === "create") {
    const res = createUser({ username: b.username, password: b.password, display_name: b.display_name || "", role: b.role || "admin" });
    if (res.error) return Response.json({ error: res.error });
    logAudit(u?.display_name || u?.username || "bootstrap", "create", "users", res.id, null, { username: res.username, role: res.role }, "created user");
    return Response.json(res);
  }
  if (b.action === "set_password") {
    const res = setPassword(Number(b.id), b.password);
    if (res.error) return Response.json({ error: res.error });
    logAudit(u?.display_name || u?.username, "update", "users", Number(b.id), null, null, "password changed");
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
