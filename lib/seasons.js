// Seasons — first-class season support.
//
// A season is a select option on the player "season" field (same pattern as
// township / league), plus one app-wide "active season" setting. Imports stamp
// every row with the chosen season; duplicate detection is scoped WITHIN a
// season so a returning player can register again next season.
//
// Data safety: everything here goes through the existing records UPDATE +
// audit-log path, so every change shows in the Change Log and is revertible
// via Time Machine. Nothing is ever deleted.
import { getDb, logAudit, now } from "./db.js";
import { getFields, addField, addFieldOption, getFieldOptions, getRecords } from "./tools.js";
import { getSetting, setSetting } from "./memory.js";

const FIELD = "season";

export function ensureSeasonField() {
  const has = getFields("player").some((f) => f.name === FIELD);
  if (!has) addField("player", FIELD, "select", "Season", false, []);
  return { ok: true };
}

// Season -> leagues mapping. A season "adopts" league names (rules and
// divisions are keyed to the league NAME, so adopting a name carries its
// assignment rules and age divisions into the new season automatically).
// Stored as one JSON setting. A season with no mapping = no restriction
// (back-compat: all leagues show).
export function seasonLeagues() {
  try { return JSON.parse(getSetting("season_leagues", "{}") || "{}"); } catch { return {}; }
}

export function leaguesForSeason(season) {
  if (!season) return null;
  const arr = seasonLeagues()[String(season)];
  return Array.isArray(arr) && arr.length ? arr : null;
}

export function setSeasonLeaguesFor(season, leagues) {
  const label = String(season || "").trim();
  if (!label) return { error: "Season name required." };
  const list = [...new Set((leagues || []).map((l) => String(l).trim()).filter(Boolean))];
  // Any brand-new league name becomes a real league option (same machinery as
  // the Leagues tab), so rules/divisions/rosters can use it right away.
  for (const lg of list) addFieldOption("player", "league", lg);
  const map = seasonLeagues();
  map[label] = list;
  setSetting("season_leagues", JSON.stringify(map));
  return { status: "ok", season: label, leagues: list };
}

// One-step "Start a season": create it, make it current, and register which
// leagues it runs (adopted from past seasons and/or brand new).
export function startSeason(name, leagues = []) {
  const r = addSeason(name);
  if (r && r.error) return r;
  const lg = setSeasonLeaguesFor(r.season, leagues);
  if (lg && lg.error) return lg;
  return { status: "started", season: r.season, active: r.season, leagues: lg.leagues };
}

// { seasons, active, counts, untagged, allLeagues, leaguesBySeason }
export function listSeasons() {
  ensureSeasonField();
  const seasons = getFieldOptions("player", FIELD) || [];
  const active = getSetting("active_season", null);
  const counts = {};
  let untagged = 0;
  for (const r of getRecords("player")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    const s = d.season ? String(d.season) : "";
    if (!s) untagged++;
    else counts[s] = (counts[s] || 0) + 1;
  }
  let allLeagues = [];
  try { allLeagues = getFieldOptions("player", "league") || []; } catch {}
  return { seasons, active, counts, untagged, allLeagues, leaguesBySeason: seasonLeagues() };
}

export function addSeason(name) {
  const label = String(name || "").trim();
  if (!label) return { error: "Season name required." };
  ensureSeasonField();
  const res = addFieldOption("player", FIELD, label);
  if (res && res.error) return res;
  // The most recently made season becomes the current one — new uploads and
  // every page's default filter follow it.
  setSetting("active_season", label);
  return { status: "added", season: label, active: label };
}

export function activeSeason() {
  return getSetting("active_season", null);
}

// The app-wide season a request is scoped to. The client sends the sidebar
// picker's value on every call as an `x-ff-season` header ("" = all seasons).
export function seasonFromReq(req) {
  try {
    const h = req && req.headers && req.headers.get ? req.headers.get("x-ff-season") : null;
    return h ? String(h) : null;
  } catch { return null; }
}

// Lenient season match for DISPLAY: records with no season tag show under every
// season (safe until they're backfilled). Writes/deletes should stay strict.
export function inSeason(data, season) {
  if (!season) return true;
  const s = data && data.season ? String(data.season) : "";
  return !s || s === String(season);
}

export function setActiveSeason(name) {
  const label = String(name || "").trim();
  if (!label) return { error: "Season name required." };
  const seasons = getFieldOptions("player", FIELD) || [];
  if (!seasons.includes(label)) return { error: `"${label}" isn't a season yet — add it first.` };
  setSetting("active_season", label);
  return { status: "active", season: label };
}

// Tag every player AND game that has NO season yet with `label` (e.g.
// "Spring 2026"). One-time migration helper for data that predates seasons.
// Audited per record — visible in the Change Log, revertible in Time Machine.
export function backfillSeason(label) {
  const season = String(label || "").trim();
  if (!season) return { error: "Season name required." };
  ensureSeasonField();
  const seasons = getFieldOptions("player", FIELD) || [];
  if (!seasons.includes(season)) addFieldOption("player", FIELD, season);
  const d = getDb();
  let tagged = 0, games = 0;
  const tag = (r, isGame) => {
    let data = {}; try { data = JSON.parse(r.data || "{}"); } catch { return; }
    if (data.season) return;
    const before = { ...data };
    data.season = season;
    const json = JSON.stringify(data);
    d.prepare("UPDATE records SET data=?, updated_at=? WHERE id=?").run(json, now(), r.id);
    logAudit("user(seasons)", "update", "records", r.id,
      { ...r, data: JSON.stringify(before) }, { ...r, data: json }, `backfilled season ${season}`);
    if (isGame) games++; else tagged++;
  };
  for (const r of getRecords("player")) tag(r, false);
  for (const r of getRecords("game")) tag(r, true);
  if (!getSetting("active_season", null)) setSetting("active_season", season);
  return { status: "backfilled", season, tagged, games };
}
