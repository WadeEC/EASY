// Rename / move / delete for the things on Leagues & Assignment that are
// referenced BY NAME all over the database: leagues, townships and seasons.
//
// Why this file exists: a league name isn't one row. "Saturday Limerick" is
// copied onto every player (league + second_league), every game, coach,
// referee and division, into each season's league list, the roster locks,
// schedule blackouts, and the assignment/flag rules that test or set it.
// Changing it in one place and not the others makes things quietly stop
// matching (kiosk field, standings, schedules). So every change here walks ALL
// of those places, in one go.
//
// Ground rules (agreed with Wade):
//   • Delete is REFUSED while anything still uses the name. The caller is told
//     exactly what uses it and offered a move instead.
//   • A move = rename INTO another existing name (merge). After it, the old
//     name is gone and everything that used it now uses the new one.
//   • Before any rename / move / delete, the whole database is snapshotted to
//     backups/ next to league.db (on Render: /data/backups). Settings changes
//     can't be undone in Time Machine, so the snapshot is the safety net.
//   • A locked or archived season is never touched — the caller is told to
//     unlock it first, so a rename can't half-apply.

import fs from "node:fs";
import path from "node:path";
import { getDb, logAudit, now } from "./db.js";
import { updateRecord } from "./tools.js";
import { getSetting, setSetting } from "./memory.js";
import { seasonWritable } from "./season-scope.js";

const parse = (s, fb = {}) => { try { return JSON.parse(s || ""); } catch { return fb; } };
const clean = (s) => String(s == null ? "" : s).trim();

// ------------------------------------------------------------------ snapshot
// Copy the live database to backups/<stamp>-<why>.db before a big change.
// better-sqlite3's backup() is WAL-safe and doesn't block readers. Keeps the
// newest 30 snapshots so the 1 GB Render disk can't fill up.
const KEEP = 30;
export async function snapshot(why) {
  const file = process.env.LEAGUE_DB || path.join(process.cwd(), "league.db");
  const dir = path.join(path.dirname(file), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const tag = clean(why).replace(/[^a-z0-9]+/gi, "-").slice(0, 60).replace(/^-|-$/g, "");
  const dest = path.join(dir, `${now().replace(/[:T]/g, "-")}-${tag}.db`);
  await getDb().backup(dest);
  const old = fs.readdirSync(dir).filter((f) => f.endsWith(".db")).sort().reverse().slice(KEEP);
  for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  return path.basename(dest);
}

// ------------------------------------------------------------------ choice kinds
// A "choice" is a value picked from a dropdown and copied onto records.
// `keys` = the record fields that hold it (on ANY record type).
const KINDS = {
  league:   { label: "league",   keys: ["league", "second_league"] },
  township: { label: "township", keys: ["township"] },
};
function kindOf(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown kind '${kind}'`);
  return k;
}

// Every record whose data holds `name` in one of the kind's fields.
function recordsUsing(keys, name) {
  return getDb().prepare("SELECT id, type, name, data, season FROM records").all()
    .map((r) => ({ ...r, d: parse(r.data) }))
    .filter((r) => keys.some((k) => r.d[k] === name));
}

// Rules store their tests as JSON. Return a rewritten copy (or null if the
// rule doesn't mention `from` in one of `keys`).
//   assignment: condition {all:[{field,op,value}]}, action {set, to}
//   flag:       action {field, op, value, label}
function rewriteRule(rule, keys, from, to) {
  const cond = parse(rule.condition, {});
  const act = parse(rule.action, {});
  let hit = false;
  for (const c of (cond && Array.isArray(cond.all)) ? cond.all : []) {
    if (keys.includes(c.field) && c.value === from) { c.value = to; hit = true; }
  }
  if (keys.includes(act.set) && act.to === from) { act.to = to; hit = true; }
  if (keys.includes(act.field) && act.value === from) { act.value = to; hit = true; }
  return hit ? { condition: JSON.stringify(cond), action: JSON.stringify(act) } : null;
}
function rulesUsing(keys, name) {
  return getDb().prepare("SELECT * FROM rules").all().filter((r) => rewriteRule(r, keys, name, name + "\u0000"));
}

// Fields on any record type that offer this kind as a dropdown.
function choiceFields(keys) {
  const ph = keys.map(() => "?").join(",");
  return getDb().prepare(`SELECT * FROM fields WHERE name IN (${ph})`).all(...keys);
}
export function choiceExists(kind, name) {
  const { keys } = kindOf(kind);
  return choiceFields(keys).some((f) => parse(f.options, []).includes(name));
}

// What uses a league/township right now — shown before a delete or move.
export function choiceUsage(kind, name) {
  const { keys } = kindOf(kind);
  const v = clean(name);
  const recs = recordsUsing(keys, v);
  const byType = {};
  for (const r of recs) byType[r.type] = (byType[r.type] || 0) + 1;
  const rules = rulesUsing(keys, v).map((r) => ({ id: r.id, name: r.name, kind: r.kind }));
  const d = getDb();
  const out = { name: v, records: byType, total_records: recs.length, rules };
  if (kind === "league") {
    const lbs = parse(getSetting("season_leagues", "{}"), {});
    out.seasons = Object.keys(lbs).filter((s) => (lbs[s] || []).includes(v));
    out.blackouts = d.prepare("SELECT COUNT(*) c FROM schedule_blackouts WHERE league=?").get(v).c;
    out.locks = d.prepare("SELECT COUNT(*) c FROM league_locks WHERE league=?").get(v).c;
  }
  // Delete is blocked by real data: records, rules, blackouts. Season lists and
  // lock rows are just bookkeeping and get cleaned up with the name.
  out.in_use = recs.length > 0 || rules.length > 0 || (out.blackouts || 0) > 0;
  return out;
}

// Records in a locked/archived season can't be written. Refuse up front with
// the season names, rather than leaving half the records renamed.
function lockedSeasonsIn(recs) {
  const bad = new Set();
  for (const r of recs) if (!seasonWritable(r.season).ok) bad.add(r.season);
  return [...bad];
}

// Rename a league/township everywhere. With merge=true, `to` may already exist
// (that's a "move everything from A into B, then A is gone").
export async function renameChoice(kind, fromName, toName, { merge = false } = {}) {
  const { keys, label } = kindOf(kind);
  const from = clean(fromName), to = clean(toName);
  if (!from || !to) return { error: `Both the current and the new ${label} name are required.` };
  if (from === to) return { error: "That's the same name." };
  if (!choiceExists(kind, from) && !recordsUsing(keys, from).length) return { error: `There's no ${label} called "${from}".` };
  const exists = choiceExists(kind, to);
  if (exists && !merge) return { error: `There's already a ${label} called "${to}". To combine them, use Delete on "${from}" and move it into "${to}".` };
  if (!exists && merge) return { error: `There's no ${label} called "${to}" to move into.` };

  const recs = recordsUsing(keys, from);
  const locked = lockedSeasonsIn(recs);
  if (locked.length) return { error: `Some ${from} records are in a locked or archived season (${locked.join(", ")}). Unlock it on the Seasons tab first.` };

  const backup = await snapshot(`${merge ? "move" : "rename"}-${kind}-${from}`);
  const d = getDb();
  const why = merge ? `moved ${label} '${from}' → '${to}'` : `renamed ${label} '${from}' → '${to}'`;

  // 1) Dropdown choices on every field that offers them.
  for (const f of choiceFields(keys)) {
    const opts = parse(f.options, []);
    if (!opts.includes(from)) continue;
    const next = [];
    for (const o of opts) { const v = o === from ? to : o; if (!next.includes(v)) next.push(v); }
    d.prepare("UPDATE fields SET options=? WHERE id=?").run(JSON.stringify(next), f.id);
    logAudit("user", "update", "fields", f.id, { options: f.options }, { options: JSON.stringify(next) }, why);
  }

  // 2) Every record (player, game, coach, referee, division, team…). Goes
  //    through updateRecord, so each one is in the Change Log and Time Machine.
  let records = 0;
  const blocked = [];
  for (const r of recs) {
    const patch = {};
    for (const k of keys) if (r.d[k] === from) patch[k] = to;
    const res = updateRecord(r.id, patch, "user(rename)", why);
    if (res.error) blocked.push({ id: r.id, name: r.name, reason: res.error }); else records++;
  }

  // 3) Rules that test or set it (assignment, flags).
  let rules = 0;
  for (const r of d.prepare("SELECT * FROM rules").all()) {
    const next = rewriteRule(r, keys, from, to);
    if (!next) continue;
    d.prepare("UPDATE rules SET condition=?, action=? WHERE id=?").run(next.condition, next.action, r.id);
    logAudit("user", "update", "rules", r.id, { condition: r.condition, action: r.action }, next, why);
    rules++;
  }

  // 4) League-only bookkeeping: season league lists, roster locks, blackouts.
  let extra = {};
  if (kind === "league") {
    const lbs = parse(getSetting("season_leagues", "{}"), {});
    let seasons = 0;
    for (const s of Object.keys(lbs)) {
      if (!(lbs[s] || []).includes(from)) continue;
      lbs[s] = [...new Set(lbs[s].map((x) => (x === from ? to : x)))];
      seasons++;
    }
    if (seasons) setSetting("season_leagues", JSON.stringify(lbs));
    // A lock row is keyed (season, league). On a merge the target may already
    // have one for that season — keep the target's, drop the old one.
    d.prepare("DELETE FROM league_locks WHERE league=? AND season IN (SELECT season FROM league_locks WHERE league=?)").run(from, to);
    const locks = d.prepare("UPDATE league_locks SET league=? WHERE league=?").run(to, from).changes;
    d.prepare("DELETE FROM schedule_blackouts WHERE league=? AND (date, season) IN (SELECT date, season FROM schedule_blackouts WHERE league=?)").run(from, to);
    const blackouts = d.prepare("UPDATE schedule_blackouts SET league=? WHERE league=?").run(to, from).changes;
    extra = { seasons, locks, blackouts };
  }

  return { status: blocked.length ? "partial" : "ok", kind, from, to, merged: merge, records, rules, ...extra, blocked, backup };
}

// Delete a league/township that nothing uses. If something does, refuse and
// return the usage so the screen can offer a move.
export async function deleteChoice(kind, name) {
  const { keys, label } = kindOf(kind);
  const v = clean(name);
  if (!v) return { error: `Which ${label}?` };
  const usage = choiceUsage(kind, v);
  if (usage.in_use) return { error: "in_use", usage };
  const backup = await snapshot(`delete-${kind}-${v}`);
  const d = getDb();
  for (const f of choiceFields(keys)) {
    const opts = parse(f.options, []);
    if (!opts.includes(v)) continue;
    const next = opts.filter((o) => o !== v);
    d.prepare("UPDATE fields SET options=? WHERE id=?").run(JSON.stringify(next), f.id);
    logAudit("user", "update", "fields", f.id, { options: f.options }, { options: JSON.stringify(next) }, `deleted ${label} '${v}'`);
  }
  if (kind === "league") {
    const lbs = parse(getSetting("season_leagues", "{}"), {});
    let changed = false;
    for (const s of Object.keys(lbs)) if ((lbs[s] || []).includes(v)) { lbs[s] = lbs[s].filter((x) => x !== v); changed = true; }
    if (changed) setSetting("season_leagues", JSON.stringify(lbs));
    d.prepare("DELETE FROM league_locks WHERE league=?").run(v);
  }
  return { status: "deleted", kind, name: v, backup };
}

// ------------------------------------------------------------------ seasons
// Where a season's NAME is stored: the seasons table; records.season (column)
// and data.season; player rank_season / rank_history; import history; player
// links; blackouts; roster locks; the active-season setting; the season's
// league list; and the player.season dropdown.
function seasonRow(name) { return getDb().prepare("SELECT * FROM seasons WHERE name=?").get(clean(name)) || null; }

export function seasonUsage(name) {
  const v = clean(name);
  const d = getDb();
  const byType = {};
  for (const r of d.prepare("SELECT type, COUNT(*) c FROM records WHERE season=? GROUP BY type").all(v)) byType[r.type] = r.c;
  const total = Object.values(byType).reduce((a, b) => a + b, 0);
  const links = d.prepare("SELECT COUNT(*) c FROM player_links WHERE season=?").get(v).c;
  const blackouts = d.prepare("SELECT COUNT(*) c FROM schedule_blackouts WHERE season=?").get(v).c;
  const imports = d.prepare("SELECT COUNT(*) c FROM import_master WHERE season=?").get(v).c;
  const rules = d.prepare("SELECT id, name, kind FROM rules WHERE season=?").all(v);
  const active = clean(getSetting("active_season", "")) === v;
  return { name: v, records: byType, total_records: total, links, blackouts, imports, rules, active,
    in_use: total > 0 || links > 0 || blackouts > 0 || rules.length > 0 };
}

export async function renameSeason(fromName, toName, { merge = false } = {}) {
  const from = clean(fromName), to = clean(toName);
  if (!from || !to) return { error: "Both the current and the new season name are required." };
  if (from === to) return { error: "That's the same name." };
  const src = seasonRow(from);
  if (!src) return { error: `There's no season called "${from}".` };
  const dst = seasonRow(to);
  if (dst && !merge) return { error: `There's already a season called "${to}". To combine them, use Delete on "${from}" and move it into "${to}".` };
  if (!dst && merge) return { error: `There's no season called "${to}" to move into.` };
  for (const s of [from, ...(dst ? [to] : [])]) {
    const w = seasonWritable(s);
    if (!w.ok) return { error: w.error };
  }

  const backup = await snapshot(`${merge ? "move" : "rename"}-season-${from}`);
  const d = getDb();
  const why = merge ? `moved season '${from}' → '${to}'` : `renamed season '${from}' → '${to}'`;

  // 1) The season itself. On a merge the old row goes; otherwise it's renamed
  //    in place so its sort order / status / created date are kept.
  if (merge) {
    d.prepare("DELETE FROM seasons WHERE id=?").run(src.id);
    logAudit("user", "delete", "seasons", src.id, src, null, why);
  } else {
    d.prepare("UPDATE seasons SET name=? WHERE id=?").run(to, src.id);
    logAudit("user", "update", "seasons", src.id, src, { ...src, name: to }, why);
  }

  // 2) Records. updateRecord with a `season` patch moves the column AND
  //    data.season together (and is in the Change Log / Time Machine).
  let records = 0;
  const blocked = [];
  for (const r of d.prepare("SELECT id, name, data FROM records WHERE season=? OR data LIKE ?").all(from, `%${JSON.stringify(from).slice(1, -1)}%`)) {
    const dd = parse(r.data);
    const patch = {};
    const row = d.prepare("SELECT season FROM records WHERE id=?").get(r.id);
    if (row.season === from || dd.season === from) patch.season = to;
    if (dd.rank_season === from) patch.rank_season = to;
    const hist = parse(dd.rank_history, null);
    if (Array.isArray(hist) && hist.some((h) => h && h.season === from)) {
      patch.rank_history = JSON.stringify(hist.map((h) => (h && h.season === from ? { ...h, season: to } : h)));
    }
    if (!Object.keys(patch).length) continue;
    const res = updateRecord(r.id, patch, "user(rename)", why);
    if (res.error) blocked.push({ id: r.id, name: r.name, reason: res.error }); else records++;
  }

  // 3) Side tables keyed by season name. (On a merge, a lock / blackout the
  //    target already has wins — the duplicate from the old season is dropped.)
  const imports = d.prepare("UPDATE import_master SET season=? WHERE season=?").run(to, from).changes;
  const links = d.prepare("UPDATE player_links SET season=? WHERE season=?").run(to, from).changes;
  // Rules that belong to this season follow it (on a move they join the target).
  const rules = d.prepare("UPDATE rules SET season=? WHERE season=?").run(to, from).changes;
  d.prepare("DELETE FROM schedule_blackouts WHERE season=? AND (date, COALESCE(league,'')) IN (SELECT date, COALESCE(league,'') FROM schedule_blackouts WHERE season=?)").run(from, to);
  const blackouts = d.prepare("UPDATE schedule_blackouts SET season=? WHERE season=?").run(to, from).changes;
  d.prepare("DELETE FROM league_locks WHERE season=? AND league IN (SELECT league FROM league_locks WHERE season=?)").run(from, to);
  d.prepare("UPDATE league_locks SET season=? WHERE season=?").run(to, from);

  // 4) Settings: the current season, and the season → leagues list.
  if (clean(getSetting("active_season", "")) === from) setSetting("active_season", to);
  const lbs = parse(getSetting("season_leagues", "{}"), {});
  if (lbs[from]) {
    lbs[to] = [...new Set([...(lbs[to] || []), ...lbs[from]])];
    delete lbs[from];
    setSetting("season_leagues", JSON.stringify(lbs));
  }

  // 5) The player.season dropdown (and any other field named season).
  for (const f of choiceFields(["season"])) {
    const opts = parse(f.options, []);
    if (!opts.includes(from)) continue;
    const next = [];
    for (const o of opts) { const v = o === from ? to : o; if (!next.includes(v)) next.push(v); }
    d.prepare("UPDATE fields SET options=? WHERE id=?").run(JSON.stringify(next), f.id);
  }

  return { status: blocked.length ? "partial" : "ok", from, to, merged: merge, records, imports, links, blackouts, rules, blocked, backup };
}

export async function deleteSeason(name) {
  const v = clean(name);
  const row = seasonRow(v);
  if (!row) return { error: `There's no season called "${v}".` };
  const usage = seasonUsage(v);
  if (usage.active) return { error: `"${v}" is the current season. Make another season current first.` };
  if (usage.in_use) return { error: "in_use", usage };
  const backup = await snapshot(`delete-season-${v}`);
  const d = getDb();
  d.prepare("DELETE FROM seasons WHERE id=?").run(row.id);
  logAudit("user", "delete", "seasons", row.id, row, null, `deleted season '${v}'`);
  d.prepare("DELETE FROM league_locks WHERE season=?").run(v);
  const lbs = parse(getSetting("season_leagues", "{}"), {});
  if (lbs[v]) { delete lbs[v]; setSetting("season_leagues", JSON.stringify(lbs)); }
  for (const f of choiceFields(["season"])) {
    const opts = parse(f.options, []);
    if (opts.includes(v)) d.prepare("UPDATE fields SET options=? WHERE id=?").run(JSON.stringify(opts.filter((o) => o !== v)), f.id);
  }
  // Import history rows are kept on purpose — they're the record of what was
  // uploaded, and nothing reads them by season once the season is gone.
  return { status: "deleted", name: v, backup };
}

// ------------------------------------------------------------------ rule edits
// Flags (Home flags tab) and team build rules (Team building tab) are rows in
// the `rules` table with their settings as JSON in `action`. These edit them in
// place — no snapshot needed, they're small and the Change Log keeps before/after.
const FLAG_OPS = ["empty", "not_empty", "==", "!=", ">=", "<=", ">", "<"];

export function updateFlag(id, { label = null, field = null, op = null, value = null, weeks = null } = {}) {
  const d = getDb();
  const row = d.prepare("SELECT * FROM rules WHERE id=? AND kind='flag'").get(Number(id));
  if (!row) return { error: `no flag with id ${id}` };
  const act = parse(row.action, {});
  const next = { ...act };
  const name = label != null && clean(label) ? clean(label) : row.name;
  next.label = name;
  // Built-in flags (attendance, press…) only let you rename them / change the
  // week count; their test is code, not a field comparison.
  if (!act.kind || act.kind === "field") {
    if (field != null) next.field = clean(field);
    if (op != null) { if (!FLAG_OPS.includes(op)) return { error: `"${op}" isn't a flag test.` }; next.op = op; }
    if (value != null) next.value = String(value);
  }
  if (weeks != null && act.kind === "attendance") next.weeks = Math.max(1, Number(weeks) || 2);
  d.prepare("UPDATE rules SET name=?, action=? WHERE id=?").run(name, JSON.stringify(next), row.id);
  logAudit("user", "update", "rules", row.id, { name: row.name, action: row.action }, { name, action: JSON.stringify(next) }, "edited flag");
  return { status: "updated", id: row.id, name };
}

export function updateTeamRule(id, { name = null, field = null, max = null } = {}) {
  const d = getDb();
  const row = d.prepare("SELECT * FROM rules WHERE id=? AND kind='team_rule'").get(Number(id));
  if (!row) return { error: `no team rule with id ${id}` };
  const act = parse(row.action, {});
  const next = { ...act };
  if (field != null && ["balance", "keep_together", "cap"].includes(act.type)) next.field = clean(field);
  if (max != null && act.type === "cap") next.max = Math.max(0, Number(max) || 0);
  const nm = name != null && clean(name) ? clean(name) : row.name;
  d.prepare("UPDATE rules SET name=?, action=? WHERE id=?").run(nm, JSON.stringify(next), row.id);
  logAudit("user", "update", "rules", row.id, { name: row.name, action: row.action }, { name: nm, action: JSON.stringify(next) }, "edited team rule");
  return { status: "updated", id: row.id, name: nm };
}

// ------------------------------------------------------------------ rules per season
// Assignment rules belong to a season (rules.season) or to every season (NULL).

// Copy rules into a season — "adopt" last season's rules. The copies are new,
// independent rules: editing one later doesn't change the original. A rule
// that's already in the target season with the same name, conditions and
// result is skipped, so adopting twice doesn't double up.
export function adoptRules(ids, toSeason) {
  const to = clean(toSeason);
  if (!to) return { error: "Pick the season to adopt the rules into." };
  if (!seasonRow(to)) return { error: `There's no season called "${to}".` };
  const d = getDb();
  const have = new Set(d.prepare("SELECT name, condition, action FROM rules WHERE kind='assignment' AND season=?").all(to)
    .map((r) => `${r.name}|${r.condition}|${r.action}`));
  let adopted = 0, skipped = 0;
  for (const id of (ids || []).map(Number)) {
    const r = d.prepare("SELECT * FROM rules WHERE id=? AND kind='assignment'").get(id);
    if (!r) continue;
    const key = `${r.name}|${r.condition}|${r.action}`;
    if (have.has(key)) { skipped++; continue; }
    const info = d.prepare(
      `INSERT INTO rules(name,kind,record_type,hard,condition,action,active,added_by,created_at,season)
       VALUES(?,?,?,?,?,?,?,?,?,?)`
    ).run(r.name, r.kind, r.record_type, r.hard, r.condition, r.action, r.active, "user(adopt)", now(), to);
    logAudit("user", "create", "rules", info.lastInsertRowid, null, { name: r.name, season: to, from_rule: r.id }, `adopted rule into ${to}`);
    have.add(key); adopted++;
  }
  return { status: "adopted", season: to, adopted, skipped };
}

// Delete a rule from ONE season. A rule that belongs to that season is
// deleted outright; an "All seasons" rule is only switched off there (added to
// skip_seasons), so every other season — and new ones — keep using it.
export function removeRuleFromSeason(id, season) {
  const d = getDb();
  const r = d.prepare("SELECT * FROM rules WHERE id=? AND kind='assignment'").get(Number(id));
  if (!r) return { error: `no assignment rule with id ${id}` };
  const sn = clean(season);
  if (!sn) return { error: "Pick a season in the sidebar first." };
  if (r.season && r.season !== sn) return { error: `"${r.name}" belongs to ${r.season}, not ${sn}.` };
  if (r.season === sn) {
    d.prepare("DELETE FROM rules WHERE id=?").run(r.id);
    logAudit("user", "delete", "rules", r.id, r, null, `deleted rule from ${sn}`);
    return { status: "deleted", id: r.id };
  }
  let skip = [];
  try { skip = JSON.parse(r.skip_seasons || "[]"); } catch {}
  if (!Array.isArray(skip)) skip = [];
  if (!skip.includes(sn)) skip.push(sn);
  d.prepare("UPDATE rules SET skip_seasons=? WHERE id=?").run(JSON.stringify(skip), r.id);
  logAudit("user", "update", "rules", r.id, { skip_seasons: r.skip_seasons }, { skip_seasons: skip }, `removed rule from ${sn} only`);
  return { status: "removed", id: r.id, season: sn };
}

// Move one rule to a season ("" / null = every season). Used for "only this
// season" on a shared rule, and to share a season's rule with every season.
export function setRuleSeason(id, season) {
  const d = getDb();
  const r = d.prepare("SELECT * FROM rules WHERE id=? AND kind='assignment'").get(Number(id));
  if (!r) return { error: `no assignment rule with id ${id}` };
  const sn = clean(season) || null;
  if (sn && !seasonRow(sn)) return { error: `There's no season called "${sn}".` };
  d.prepare("UPDATE rules SET season=?, skip_seasons='' WHERE id=?").run(sn, r.id);
  logAudit("user", "update", "rules", r.id, { season: r.season }, { season: sn }, sn ? `rule now only for ${sn}` : "rule now for every season");
  return { status: "updated", id: r.id, season: sn || "" };
}
