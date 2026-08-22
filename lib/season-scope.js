// Season scope — the single place that decides which season a request is
// allowed to see and touch.
//
// WHY THIS EXISTS
// Before this, "which season?" was re-decided in every route, and most routes
// never asked at all. That is how a question like "how many players do we
// have?" came back with last year's number folded in — the answer was true of
// the database but false of the season on screen. Scope is now resolved once
// per request and every read goes through it.
//
// THE CONTRACT (header `x-ff-season`, sent by lib/api.js on every call)
//   "Fall 2026"    → exactly that season
//   "(no season)"  → the legacy bucket: records that were never tagged
//   "*"            → every season, explicitly asked for
//   header missing → the active season (never "everything" by accident)
//
// Resolution is synchronous and per request, matching the existing actor.js
// pattern: routes call bindRequest(req) at the top and everything downstream
// reads currentScope().

import { getDb } from "./db.js";

export const ALL_SEASONS = "*";
export const NO_SEASON = "(no season)";

let _scope = { season: null, mode: "active", resolved: false };

function activeSeasonName() {
  try {
    const row = getDb().prepare(
      "SELECT value FROM ai_facts WHERE key='setting:active_season' ORDER BY id DESC LIMIT 1").get();
    if (row && row.value) return row.value;
  } catch {}
  try {
    const s = getDb().prepare("SELECT name FROM seasons ORDER BY sort DESC, id DESC LIMIT 1").get();
    return s ? s.name : null;
  } catch { return null; }
}

// mode: "one" | "none" | "all"
export function setScope(raw) {
  const v = raw == null ? null : String(raw).trim();
  if (v === ALL_SEASONS) { _scope = { season: null, mode: "all", resolved: true }; return _scope; }
  if (v === NO_SEASON) { _scope = { season: null, mode: "none", resolved: true }; return _scope; }
  if (v) { _scope = { season: v, mode: "one", resolved: true }; return _scope; }
  const a = activeSeasonName();
  _scope = a ? { season: a, mode: "one", resolved: true } : { season: null, mode: "all", resolved: true };
  return _scope;
}

export function setScopeFromReq(req) {
  let h = null;
  try { h = req?.headers?.get?.("x-ff-season") ?? null; } catch {}
  if (h == null) {
    // Also accept ?season= for links, print views and curl.
    try { h = new URL(req.url).searchParams.get("season"); } catch {}
  }
  return setScope(h);
}

export function currentScope() {
  if (!_scope.resolved) setScope(null);
  return _scope;
}

// The season name a NEW record should be stamped with. In "all" mode there is
// no single answer, so fall back to the active season rather than writing a
// record that belongs nowhere.
export function seasonForWrite() {
  const s = currentScope();
  if (s.mode === "one") return s.season;
  if (s.mode === "none") return null;
  return activeSeasonName();
}

export function scopeLabel() {
  const s = currentScope();
  if (s.mode === "all") return "All seasons";
  if (s.mode === "none") return NO_SEASON;
  return s.season;
}

// SQL fragment + params for any table that has a `season` column.
// Usage: const { sql, params } = seasonSql("r"); ... WHERE type=? ${sql}
export function seasonSql(alias = "") {
  const p = alias ? `${alias}.` : "";
  const s = currentScope();
  if (s.mode === "all") return { sql: "", params: [] };
  if (s.mode === "none") return { sql: ` AND (${p}season IS NULL OR TRIM(${p}season)='')`, params: [] };
  return { sql: ` AND ${p}season = ?`, params: [s.season] };
}

// Same thing for an explicitly named season (exports, migrations, S-Dot tools
// that were handed a season by name rather than by header).
export function seasonSqlFor(season, alias = "") {
  const p = alias ? `${alias}.` : "";
  const v = season == null ? null : String(season).trim();
  if (v === ALL_SEASONS) return { sql: "", params: [] };
  if (!v || v === NO_SEASON) return { sql: ` AND (${p}season IS NULL OR TRIM(${p}season)='')`, params: [] };
  return { sql: ` AND ${p}season = ?`, params: [v] };
}

// Does a row (or a parsed data blob) belong to the current scope?
export function inScope(row) {
  const s = currentScope();
  if (s.mode === "all") return true;
  const v = row && (row.season ?? row?.data?.season);
  const str = v == null ? "" : String(v);
  if (s.mode === "none") return str === "";
  return str === s.season;
}

// ---------------------------------------------------------------- write guard
// A locked or archived season is read-only. Every write path calls this, so
// there is exactly one answer to "can I change last season?" — no.
export function seasonWritable(name) {
  const v = name == null ? "" : String(name).trim();
  if (!v) return { ok: true }; // the legacy "(no season)" bucket stays editable
  try {
    const row = getDb().prepare("SELECT name, status, locked FROM seasons WHERE name=?").get(v);
    if (!row) return { ok: true }; // not registered yet — creating it is allowed
    if (row.locked) return { ok: false, error: `"${v}" is locked. Unlock the season before changing it.` };
    if (row.status === "archived") return { ok: false, error: `"${v}" is archived. Reopen it before changing it.` };
    return { ok: true };
  } catch { return { ok: true }; }
}

export function assertWritable(name) {
  const r = seasonWritable(name);
  return r.ok ? null : r.error;
}

// Reset — used by tests and by long-lived scripts between runs.
export function clearScope() { _scope = { season: null, mode: "active", resolved: false }; }
