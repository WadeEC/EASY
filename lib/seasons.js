// Seasons — first-class, registry-backed.
//
// A season is a row in the `seasons` table. Every season-owned record carries
// that season's name in a real `season` column, so a season genuinely owns its
// own players, coaches, teams, divisions, games, attendance, roster locks,
// blackouts and master sheet. Nothing is shared by accident.
//
// The three things this file guarantees:
//   1. SEPARATION    — reads are scoped in SQL (lib/season-scope.js), not by hand.
//   2. LINEAGE       — a returning player is a NEW record in the new season that
//                      points back at the old one. Last season is never emptied.
//   3. REVERSIBILITY — every change goes through the audited records path, so it
//                      shows in the Change Log and rewinds in Time Machine.
import { getDb, logAudit, now, SEASON_OWNED_TYPES } from "./db.js";
import {
  getFields, addField, addFieldOption, getFieldOptions, getRecords,
  getRecordsForSeason, applyCreateRecord, updateRecord, slug, divisionOf,} from "./tools.js";
import { getSetting, setSetting } from "./memory.js";
import { currentScope, assertWritable, NO_SEASON, ALL_SEASONS } from "./season-scope.js";

const FIELD = "season";
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

// ---------------------------------------------------------------- registry
export function ensureSeasonField() {
  const has = getFields("player").some((f) => f.name === FIELD);
  if (!has) addField("player", FIELD, "select", "Season", false, []);
  return { ok: true };
}

export function seasonRows() {
  return getDb().prepare("SELECT * FROM seasons ORDER BY sort DESC, id DESC").all();
}

export const seasonNames = () => seasonRows().map((r) => r.name);

export function getSeason(name) {
  const v = String(name || "").trim();
  if (!v) return null;
  return getDb().prepare("SELECT * FROM seasons WHERE name=?").get(v) || null;
}

function registerSeason(name, { created_by = null } = {}) {
  const v = String(name || "").trim();
  if (!v) return { error: "Season name required." };
  const d = getDb();
  const existing = getSeason(v);
  if (existing) return existing;
  const maxSort = d.prepare("SELECT COALESCE(MAX(sort), -1) m FROM seasons").get().m;
  const info = d.prepare(
    "INSERT INTO seasons(name, status, locked, sort, created_at, created_by) VALUES(?,?,?,?,?,?)"
  ).run(v, "active", 0, maxSort + 1, now(), created_by || "user");
  logAudit(created_by, "create", "seasons", Number(info.lastInsertRowid), null, { name: v }, "season created");
  // Keep the player.season select in step so the existing forms show it.
  ensureSeasonField();
  addFieldOption("player", FIELD, v);
  return getSeason(v);
}

// ---------------------------------------------------------------- leagues per season
// A season "adopts" league names (rules and divisions are keyed to the league
// NAME, so adopting a name carries its assignment rules into the new season).
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
  const blocked = assertWritable(label);
  if (blocked) return { error: blocked };
  const list = [...new Set((leagues || []).map((l) => String(l).trim()).filter(Boolean))];
  for (const lg of list) addFieldOption("player", "league", lg);
  const map = seasonLeagues();
  map[label] = list;
  setSetting("season_leagues", JSON.stringify(map));
  return { status: "ok", season: label, leagues: list };
}

// ---------------------------------------------------------------- lifecycle
// One-step "Start a season": register it, make it current, register which
// leagues it runs, and give it its own copy of the setup a season needs to
// function. Copies are real records in the new season — editing this season's
// Ages 9-10 never touches last season's.
export function startSeason(name, leagues = [], opts = {}) {
  const label = String(name || "").trim();
  if (!label) return { error: "Season name required." };
  if (getSeason(label)) return { error: `"${label}" already exists. Pick a different name or switch to it.` };

  const copyFrom = opts.copy_setup_from ? String(opts.copy_setup_from).trim() : null;
  if (copyFrom && !getSeason(copyFrom)) return { error: `There's no season called "${copyFrom}" to copy from.` };

  registerSeason(label);
  setSetting("active_season", label);
  const lg = setSeasonLeaguesFor(label, leagues);
  if (lg && lg.error) return lg;

  let copied = { divisions: 0, coaches: 0, referees: 0 };
  if (copyFrom) {
    const res = copySeasonSetup(copyFrom, label, opts.copy || { divisions: true });
    if (res && res.error) return res;
    copied = res;
  }

  return { status: "started", season: label, active: label, leagues: lg.leagues, copied_from: copyFrom, copied };
}

// Clone a season's *setup* (not its people) into another season.
export function copySeasonSetup(from, to, what = { divisions: true }) {
  const src = String(from || "").trim(), dst = String(to || "").trim();
  const out = { divisions: 0, coaches: 0, referees: 0 };
  if (!src || !dst || src === dst) return out;
  const blocked = assertWritable(dst);
  if (blocked) return { error: blocked };

  const clone = (type) => {
    const existing = new Set(getRecordsForSeason(type, dst).map((r) => String(r.name || "").toLowerCase()));
    let n = 0;
    for (const r of getRecordsForSeason(type, src)) {
      const nm = r.name || "";
      if (nm && existing.has(nm.toLowerCase())) continue;
      const d = parse(r.data);
      delete d.team;                     // rosters do not carry over
      d.season = dst;
      d.copied_from_season = src;
      const res = applyCreateRecord(type, nm, d, "user(new season)");
      if (!res.error) n++;
    }
    return n;
  };

  if (what.divisions !== false) out.divisions = clone("division");
  if (what.coaches) out.coaches = clone("coach");
  if (what.referees) out.referees = clone("referee");
  return out;
}

export function setSeasonStatus(name, { locked = null, status = null } = {}) {
  const row = getSeason(name);
  if (!row) return { error: `There's no season called "${name}".` };
  const d = getDb();
  const before = { ...row };
  if (locked !== null) d.prepare("UPDATE seasons SET locked=? WHERE id=?").run(locked ? 1 : 0, row.id);
  if (status !== null) d.prepare("UPDATE seasons SET status=? WHERE id=?").run(String(status), row.id);
  const after = getSeason(name);
  logAudit(null, "update", "seasons", row.id, before, after, "season status changed");
  return { status: "ok", season: after.name, locked: !!after.locked, state: after.status };
}

export const lockSeason    = (name) => setSeasonStatus(name, { locked: 1 });
export const unlockSeason  = (name) => setSeasonStatus(name, { locked: 0 });
export const archiveSeason = (name) => setSeasonStatus(name, { status: "archived", locked: 1 });
export const reopenSeason  = (name) => setSeasonStatus(name, { status: "active", locked: 0 });

export function addSeason(name) {
  const label = String(name || "").trim();
  if (!label) return { error: "Season name required." };
  const row = registerSeason(label);
  if (row && row.error) return row;
  setSetting("active_season", label);
  return { status: "added", season: label, active: label };
}

export function activeSeason() {
  const a = getSetting("active_season", null);
  if (a && getSeason(a)) return a;
  const first = seasonRows()[0];
  return first ? first.name : null;
}

export function setActiveSeason(name) {
  const label = String(name || "").trim();
  if (!label) return { error: "Season name required." };
  if (!getSeason(label)) return { error: `"${label}" isn't a season yet — add it first.` };
  setSetting("active_season", label);
  return { status: "active", season: label };
}

// ---------------------------------------------------------------- overview
export function listSeasons() {
  ensureSeasonField();
  const rows = seasonRows();
  const active = activeSeason();
  const d = getDb();

  const byType = {};
  for (const r of d.prepare(
    `SELECT COALESCE(NULLIF(TRIM(season),''), ?) s, type, COUNT(*) c FROM records GROUP BY 1, 2`
  ).all(NO_SEASON)) {
    (byType[r.s] = byType[r.s] || {})[r.type] = r.c;
  }
  const counts = {};
  for (const s of Object.keys(byType)) counts[s] = byType[s].player || 0;
  const untagged = counts[NO_SEASON] || 0;

  let allLeagues = [];
  try { allLeagues = getFieldOptions("player", "league") || []; } catch {}

  const master = {};
  for (const r of d.prepare(
    `SELECT COALESCE(NULLIF(TRIM(season),''), ?) s, COUNT(*) c FROM import_master GROUP BY 1`
  ).all(NO_SEASON)) master[r.s] = r.c;

  const lbs = seasonLeagues();
  const detail = rows.map((r) => ({
    name: r.name,
    status: r.status,
    locked: !!r.locked,
    created_at: r.created_at,
    leagues: lbs[r.name] || [],
    counts: byType[r.name] || {},
    players: (byType[r.name] || {}).player || 0,
    master_rows: master[r.name] || 0,
    is_active: r.name === active,
  }));

  return {
    seasons: rows.map((r) => r.name),
    active,
    counts,
    untagged,
    allLeagues,
    leaguesBySeason: lbs,
    detail,
    legacy: untagged ? { name: NO_SEASON, players: untagged, counts: byType[NO_SEASON] || {} } : null,
  };
}

// The season a request is scoped to. Kept for callers that still import it.
export function seasonFromReq(req) {
  try {
    const h = req && req.headers && req.headers.get ? req.headers.get("x-ff-season") : null;
    if (h === ALL_SEASONS) return null;
    return h ? String(h) : null;
  } catch { return null; }
}

// STRICT season match, kept for the handful of places that filter in JS.
export function inSeason(data, season) {
  if (!season || season === ALL_SEASONS) return true;
  const s = data && data.season ? String(data.season) : "";
  if (String(season) === NO_SEASON) return !s;
  return s === String(season);
}

// ---------------------------------------------------------------- migration
// Enroll players from one season into another. The source record is NEVER
// touched: last season's roster, standings and reports stay exactly as they
// were. A new record is created in the target season carrying the player's
// identity (name, age, phone, township, key tag) but NOT their old placement —
// they land in the target season's Unassigned so this season's rules and team
// build decide where they go.
//
// `enrolled_from_season` + `enrolled_from_id` are the paper trail: that is how
// "Jayden played Fall 2023 and Fall 2026" is answerable without guessing.
const CARRY_FIELDS = [
  "full_name", "age", "township", "parent_phone", "phone", "key_tag",
  "jersey_size", "notes", "link_reason",
];
const DROP_FIELDS = [
  "team", "division", "link_group", "all_star", "end_season_rank", "rank_season",
  "rank_history", "jersey_issued", "size_confirmed_at", "size_confirmed_by",
  "press_override", "press_override_reason", "press_override_by", "press_override_at",
];

export function enrollPlayersInSeason({
  ids = null, from_season = null, to_season = null, league = null,
  bump_age = false, keep_league = true, dry_run = false,
} = {}) {
  const to = String(to_season || "").trim();
  if (!to) return { error: "Which season should they be enrolled in?" };
  if (!getSeason(to)) return { error: `There's no season called "${to}". Start it first.` };
  const blocked = assertWritable(to);
  if (blocked) return { error: blocked };

  const from = from_season ? String(from_season).trim() : null;
  if (from && from === to) return { error: "That's the same season — nothing to move." };

  const d = getDb();
  let source = [];
  if (Array.isArray(ids) && ids.length) {
    const clean = ids.map(Number).filter((n) => Number.isFinite(n));
    const ph = clean.map(() => "?").join(",");
    source = d.prepare(`SELECT * FROM records WHERE type='player' AND id IN (${ph})`).all(...clean);
    const missing = clean.filter((i) => !source.some((r) => r.id === i));
    if (missing.length) return { error: `No player with id ${missing.join(", ")}.` };
  } else if (from) {
    source = getRecordsForSeason("player", from);
  } else {
    return { error: "Give me either a list of players or the season to bring them over from." };
  }
  if (league) source = source.filter((r) => {
    const dd = parse(r.data);
    return (dd.league || "") === league || (dd.second_league || "") === league;
  });
  if (!source.length) return { error: "No players matched — nothing was changed." };

  // Who is already in the target season? Lineage id first (exact), then
  // name (a returning kid who was re-imported by hand).
  const already = new Map();
  for (const r of getRecordsForSeason("player", to)) {
    const dd = parse(r.data);
    if (dd.enrolled_from_id) already.set(`id:${dd.enrolled_from_id}`, r.id);
    const nm = String(r.name || dd.full_name || "").trim().toLowerCase();
    if (nm) already.set(`nm:${nm}`, r.id);
  }

  const enrolled = [], skipped = [], plan = [];
  for (const r of source) {
    const dd = parse(r.data);
    const nm = String(r.name || dd.full_name || "").trim();
    const hit = already.get(`id:${r.id}`) ?? already.get(`nm:${nm.toLowerCase()}`);
    if (hit != null) { skipped.push({ id: r.id, name: nm, reason: `already in ${to} (#${hit})` }); continue; }
    const next = {};
    for (const k of CARRY_FIELDS) if (dd[k] != null && dd[k] !== "") next[k] = dd[k];
    if (keep_league && dd.league) next.league = dd.league;
    if (bump_age && Number.isFinite(Number(next.age))) next.age = Number(next.age) + 1;
    next.season = to;
    next.enrolled_from_season = r.season || dd.season || from || "";
    next.enrolled_from_id = r.id;
    for (const k of DROP_FIELDS) delete next[k];
    plan.push({ from_id: r.id, name: nm, fields: next });
  }

  if (dry_run) {
    return {
      dry_run: true, to_season: to, from_season: from,
      would_enroll: plan.length, would_skip: skipped.length,
      sample: plan.slice(0, 10).map((p) => ({ name: p.name, league: p.fields.league || "", age: p.fields.age ?? "" })),
      skipped: skipped.slice(0, 10),
    };
  }

  const tx = d.transaction(() => {
    for (const p of plan) {
      const res = applyCreateRecord("player", p.name, p.fields, "user(enroll)");
      if (res.error) skipped.push({ id: p.from_id, name: p.name, reason: res.error });
      else enrolled.push({ new_id: res.id, from_id: p.from_id, name: p.name });
    }
  });
  tx();

  return {
    status: "enrolled", to_season: to, from_season: from,
    enrolled: enrolled.length, skipped: skipped.length,
    details: enrolled.slice(0, 50), skipped_details: skipped.slice(0, 50),
    note: `Source records in ${from || "their original season"} were not changed.`,
  };
}

// Where has this person appeared? Follows the lineage chain both ways.
export function playerSeasonHistory(playerId) {
  const id = Number(playerId);
  const d = getDb();
  const row = d.prepare("SELECT * FROM records WHERE id=? AND type='player'").get(id);
  if (!row) return { error: `No player #${id}.` };
  const data = parse(row.data);
  const name = String(row.name || data.full_name || "").trim();

  const seen = new Map();
  const add = (r) => {
    if (!r || seen.has(r.id)) return;
    const dd = parse(r.data);
    seen.set(r.id, {
      id: r.id, season: r.season || dd.season || NO_SEASON,
      league: dd.league || "", division: divisionOf(dd), team: dd.team || "",
      age: dd.age ?? "", from_id: dd.enrolled_from_id || null,
    });
  };
  add(row);
  let cur = data.enrolled_from_id;
  for (let i = 0; i < 20 && cur; i++) {
    const p = d.prepare("SELECT * FROM records WHERE id=?").get(Number(cur));
    if (!p) break;
    add(p);
    cur = parse(p.data).enrolled_from_id;
  }
  for (const r of d.prepare(
    `SELECT * FROM records WHERE type='player'
       AND (json_extract(data,'$.enrolled_from_id') = ? OR LOWER(TRIM(COALESCE(name,''))) = ?)`
  ).all(id, name.toLowerCase())) add(r);

  const list = [...seen.values()].sort((a, b) => String(a.season).localeCompare(String(b.season)));
  return { player: name, seasons: list, count: list.length };
}

// ---------------------------------------------------------------- unassigned
// "Unassigned" is a per-season fact, and it is three different problems that
// used to be one blurry pile. Naming them is what makes the number actionable.
export function unassignedFor(season = undefined) {
  const rows = season === undefined ? getRecords("player") : getRecordsForSeason("player", season);
  const label = season === undefined ? (currentScope().season || NO_SEASON) : season;
  const buckets = { no_league: [], no_division: [], no_team: [] };
  for (const r of rows) {
    const dd = parse(r.data);
    const p = {
      id: r.id, name: r.name || dd.full_name || `#${r.id}`, age: dd.age ?? "",
      league: dd.league || "", division: divisionOf(dd), team: dd.team || "",
      township: dd.township || "",
    };
    if (!p.league) buckets.no_league.push(p);
    else if (!p.division) buckets.no_division.push(p);
    else if (!p.team) buckets.no_team.push(p);
  }
  const byLeague = {};
  for (const p of [...buckets.no_division, ...buckets.no_team]) {
    (byLeague[p.league] = byLeague[p.league] || []).push(p);
  }
  return {
    season: label,
    total: buckets.no_league.length + buckets.no_division.length + buckets.no_team.length,
    counts: {
      no_league: buckets.no_league.length,
      no_division: buckets.no_division.length,
      no_team: buckets.no_team.length,
    },
    ...buckets,
    by_league: byLeague,
  };
}

// ---------------------------------------------------------------- cleanup
// What is wrong with the data, per season — stated plainly, with the ids to fix
// it. This is the report that replaces "the AI thinks everything is fine".
export function seasonCleanupReport() {
  const d = getDb();
  const out = { generated_at: now(), seasons: [], orphans: {}, options: {} };

  const ph = SEASON_OWNED_TYPES.map(() => "?").join(",");
  const orphanRows = d.prepare(
    `SELECT type, COUNT(*) c FROM records
      WHERE (season IS NULL OR TRIM(season)='') AND type IN (${ph}) GROUP BY type`
  ).all(...SEASON_OWNED_TYPES);
  for (const r of orphanRows) out.orphans[r.type] = r.c;
  out.orphan_total = orphanRows.reduce((a, b) => a + b.c, 0);
  out.orphans.master_rows = d.prepare(
    "SELECT COUNT(*) c FROM import_master WHERE season IS NULL OR TRIM(season)=''").get().c;

  // Select options nobody uses — the "Wedn" typo class of problem.
  for (const f of d.prepare("SELECT record_type, name, options FROM fields WHERE data_type='select'").all()) {
    let opts = []; try { opts = JSON.parse(f.options || "[]"); } catch {}
    if (!opts.length) continue;
    const unused = [];
    for (const o of opts) {
      const c = d.prepare(
        "SELECT COUNT(*) c FROM records WHERE type=? AND json_extract(data, '$.' || ?) = ?"
      ).get(f.record_type, f.name, o).c;
      if (!c) unused.push(o);
    }
    if (unused.length) out.options[`${f.record_type}.${f.name}`] = unused;
  }

  for (const s of seasonRows()) {
    const u = unassignedFor(s.name);
    const counts = {};
    for (const r of d.prepare("SELECT type, COUNT(*) c FROM records WHERE season=? GROUP BY type").all(s.name))
      counts[r.type] = r.c;
    const claimed = leaguesForSeason(s.name);
    const strayLeagues = [];
    if (claimed) {
      for (const r of d.prepare(
        "SELECT DISTINCT json_extract(data,'$.league') lg FROM records WHERE type='player' AND season=?"
      ).all(s.name)) {
        if (r.lg && !claimed.includes(r.lg)) strayLeagues.push(r.lg);
      }
    }
    out.seasons.push({
      name: s.name, status: s.status, locked: !!s.locked,
      counts, unassigned: u.counts, unassigned_total: u.total,
      stray_leagues: strayLeagues,
      master_rows: d.prepare("SELECT COUNT(*) c FROM import_master WHERE season=?").get(s.name).c,
    });
  }
  return out;
}

// Assign every season-less record of a type to a season. Audited per record.
export function assignOrphansToSeason(label, types = SEASON_OWNED_TYPES) {
  const season = String(label || "").trim();
  if (!season) return { error: "Season name required." };
  if (!getSeason(season)) return { error: `There's no season called "${season}".` };
  const blocked = assertWritable(season);
  if (blocked) return { error: blocked };
  const list = (types || []).map(slug).filter((t) => SEASON_OWNED_TYPES.includes(t));
  if (!list.length) return { error: "No season-owned record types given." };

  const d = getDb();
  const rows = d.prepare(
    `SELECT * FROM records WHERE (season IS NULL OR TRIM(season)='') AND type IN (${list.map(() => "?").join(",")})`
  ).all(...list);
  let tagged = 0;
  const tx = d.transaction(() => {
    for (const r of rows) { const res = updateRecord(r.id, { season }, "user(seasons)"); if (!res.error) tagged++; }
    d.prepare("UPDATE import_master SET season=? WHERE season IS NULL OR TRIM(season)=''").run(season);
  });
  tx();
  return { status: "assigned", season, tagged, types: list };
}

// Back-compat: the old one-button backfill, now expressed in terms of the above.
export function backfillSeason(label) {
  const season = String(label || "").trim();
  if (!season) return { error: "Season name required." };
  if (!getSeason(season)) registerSeason(season);
  const res = assignOrphansToSeason(season);
  if (res.error) return res;
  if (!getSetting("active_season", null)) setSetting("active_season", season);
  return { status: "backfilled", season, tagged: res.tagged };
}
