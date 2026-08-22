// Who is making changes — the signed-in user's name, stamped on every audit
// row. Resolution order, highest priority first:
//   1) Session cookie → users.display_name / username
//   2) x-ff-actor header (legacy)
//   3) Default "Admin"
//
// Top-level ESM import creates a controlled cycle with db.js: db.js imports
// getActor from here at init, and we import getDb from there. ESM resolves
// this as long as we only CALL getDb() at request time (not module load).
import { getDb } from "./db.js";
import { setScopeFromReq, currentScope } from "./season-scope.js";

let _actor = "Admin";

export function setActor(a) {
  const v = (a == null ? "" : String(a)).trim();
  _actor = v || "Admin";
}
export function getActor() { return _actor; }

// Resolve the actor from the request. Synchronous so existing routes don't
// need to be rewritten. Reads the session cookie directly via better-sqlite3
// (no circular import — we go straight to db).
const SESSION_COOKIE = "ff_session";
function _readSessionCookie(req) {
  try {
    const cookie = req?.headers?.get?.("cookie") || "";
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}
// Bind the whole request context in one call: who is acting AND which season
// they are acting in. Every data route calls this first. Keeping the two
// together means a route can't remember to stamp the actor but forget the
// season — the mistake that let cross-season answers through.
export function bindRequest(req) {
  setActorFromReq(req);
  setScopeFromReq(req);
  return { actor: getActor(), scope: currentScope() };
}

export function setActorFromReq(req) {
  // 1) Try the session cookie.
  try {
    const token = _readSessionCookie(req);
    if (token) {
      const row = getDb().prepare(
        `SELECT u.username, u.display_name, u.disabled_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`
      ).get(token);
      if (row && !row.disabled_at && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now())) {
        setActor(row.display_name || row.username);
        return;
      }
    }
  } catch {}
  // 2) Legacy header fallback (background jobs / non-browser callers).
  try { const h = req && req.headers && req.headers.get("x-ff-actor"); if (h) { setActor(h); return; } } catch {}
  // 3) No session — leave the prior actor in place.
}
