// Local-app auth: username + password → httpOnly session cookie. PBKDF2 hashes
// (no plaintext on disk). Every authenticated request resolves to a user, and
// the audit log gets the user's name on every write.
//
// Why PBKDF2 instead of bcrypt/argon2? Node ships PBKDF2 natively — no extra
// build deps, no native bindings to worry about on the user's Mac install.

import { randomBytes, pbkdf2Sync, timingSafeEqual } from "crypto";
import { getDb, now } from "./db.js";
import { setActor } from "./actor.js";

const ITERATIONS = 120_000;     // strong enough; ~80ms on a modern Mac
const KEYLEN = 32;
const DIGEST = "sha256";
const SESSION_DAYS = 30;
export const SESSION_COOKIE = "ff_session";

function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(String(plain), salt, ITERATIONS, KEYLEN, DIGEST);
  return `pbkdf2$${ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function verifyPassword(plain, stored) {
  try {
    const [scheme, itStr, saltHex, hashHex] = String(stored || "").split("$");
    if (scheme !== "pbkdf2") return false;
    const iter = Number(itStr) || ITERATIONS;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = pbkdf2Sync(String(plain), salt, iter, expected.length, DIGEST);
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch { return false; }
}

// ---------------------------------------------------------------- users
export function listUsers() {
  return getDb().prepare(`
    SELECT id, username, display_name, role, created_at, last_login_at, disabled_at
    FROM users ORDER BY username
  `).all();
}

export function getUserByUsername(username) {
  return getDb().prepare("SELECT * FROM users WHERE username=?").get(String(username || "").toLowerCase()) || null;
}
export function getUserById(id) {
  return getDb().prepare("SELECT * FROM users WHERE id=?").get(Number(id)) || null;
}

export function createUser({ username, password, display_name = "", role = "admin" }) {
  // Permissive: emails work, short handles work. Anything except whitespace
  // and quotes (to keep query strings sane). 2–80 chars after trim, lowercased
  // so login is case-insensitive.
  const u = String(username || "").trim().toLowerCase();
  if (!u || u.length < 2 || u.length > 80 || /[\s"'`<>]/.test(u)) {
    return { error: "Username must be 2–80 chars and can't include spaces or quotes. Emails are fine." };
  }
  if (!password || String(password).length < 6) return { error: "Password must be at least 6 characters." };
  if (getUserByUsername(u)) return { error: `User '${u}' already exists.` };
  const hash = hashPassword(password);
  const r = getDb().prepare(
    "INSERT INTO users(username, display_name, pass_hash, role, created_at) VALUES(?,?,?,?,?)"
  ).run(u, display_name || u, hash, role || "admin", now());
  return { ok: true, id: r.lastInsertRowid, username: u, display_name: display_name || u, role };
}

export function setPassword(userId, newPassword) {
  if (!newPassword || String(newPassword).length < 6) return { error: "Password must be at least 6 characters." };
  const hash = hashPassword(newPassword);
  getDb().prepare("UPDATE users SET pass_hash=? WHERE id=?").run(hash, Number(userId));
  // Invalidate every existing session for safety.
  getDb().prepare("DELETE FROM sessions WHERE user_id=?").run(Number(userId));
  return { ok: true };
}

export function setUserRole(userId, role) {
  const r = String(role || "").toLowerCase();
  if (!["admin", "user"].includes(r)) return { error: "Role must be 'admin' or 'user'." };
  getDb().prepare("UPDATE users SET role=? WHERE id=?").run(r, Number(userId));
  return { ok: true };
}

export function disableUser(userId, on = true) {
  getDb().prepare("UPDATE users SET disabled_at=? WHERE id=?").run(on ? now() : null, Number(userId));
  if (on) getDb().prepare("DELETE FROM sessions WHERE user_id=?").run(Number(userId));
  return { ok: true };
}

// ---------------------------------------------------------------- sessions
function newToken() { return randomBytes(24).toString("hex"); }
function expiry() { return new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(); }

export function login({ username, password, userAgent = "" }) {
  const u = getUserByUsername(username);
  if (!u || u.disabled_at) return { error: "Wrong username or password." };
  if (!verifyPassword(password, u.pass_hash)) return { error: "Wrong username or password." };
  const token = newToken();
  getDb().prepare(
    "INSERT INTO sessions(token, user_id, created_at, expires_at, user_agent) VALUES(?,?,?,?,?)"
  ).run(token, u.id, now(), expiry(), String(userAgent || "").slice(0, 200));
  getDb().prepare("UPDATE users SET last_login_at=? WHERE id=?").run(now(), u.id);
  return { ok: true, token, user: publicUser(u) };
}

export function logout(token) {
  if (!token) return { ok: true };
  getDb().prepare("DELETE FROM sessions WHERE token=?").run(String(token));
  return { ok: true };
}

export function sessionUser(token) {
  if (!token) return null;
  const row = getDb().prepare("SELECT * FROM sessions WHERE token=?").get(String(token));
  if (!row) return null;
  // Lazy expiry — sessions older than expires_at don't grant access.
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    getDb().prepare("DELETE FROM sessions WHERE token=?").run(row.token);
    return null;
  }
  const u = getUserById(row.user_id);
  if (!u || u.disabled_at) return null;
  return u;
}

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
}

// ---------------------------------------------------------------- request wiring
// Read the session cookie, look up the user, and stamp lib/actor.js so every
// audit write attributes to that human. Returns the user (or null when no
// session). Call from middleware AND/OR from each API route's first line.
export function setActorFromSession(req) {
  try {
    const cookie = req?.headers?.get?.("cookie") || "";
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    const token = m ? decodeURIComponent(m[1]) : null;
    const u = sessionUser(token);
    if (u) {
      setActor(u.display_name || u.username);
      return u;
    }
    setActor("Anonymous");
    return null;
  } catch { return null; }
}

// First-run helper — called at startup so the app is never lockout-locked
// without a way in. If there are zero users, create a default "admin/admin"
// account and surface a clear console warning so the user knows to change it.
export function ensureBootstrapUser() {
  const count = getDb().prepare("SELECT COUNT(*) c FROM users").get().c;
  if (count > 0) return { bootstrapped: false, count };
  const r = createUser({ username: "admin", password: "admin", display_name: "Admin", role: "admin" });
  // eslint-disable-next-line no-console
  console.warn("[auth] No users found — created default admin/admin. CHANGE THIS PASSWORD immediately via the Users page.");
  return { bootstrapped: true, ...r };
}

export { hashPassword, verifyPassword };
