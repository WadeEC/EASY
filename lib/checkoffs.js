// Custom check-offs: things staff tick off for a player at check-in, set up by
// the league ("Got gift", "Picture form in", "Medical form signed"). They sit
// next to the built-in jersey checkbox on the Team Board's Check-in details,
// and an unticked one shows in red under "Needs attention" until it's done.
//
// An item says WHEN it applies (`repeat`):
//   "week"  — just one check-in week (`week` = that Sunday, e.g. "2026-10-11"):
//             "gift handed out" on gift day.
//   "every" — every week; ticked fresh each week ("brought water bottle").
//   "once"  — once per season; ticked once and stays done ("photo form in").
// …and optionally WHO: one league and/or one division (blank = everyone).
// Items belong to the season they were made in (blank = every season).
//
// Ticks live in check_marks, keyed (item, player, week) — week is '' for a
// "once" item, so one tick covers the whole season.

import { getDb, logAudit, now } from "./db.js";
import { getActor } from "./actor.js";
import { seasonForWrite } from "./season-scope.js";

const REPEATS = ["week", "every", "once"];
const clean = (s) => String(s == null ? "" : s).trim();

// The key a mark is stored under for this item in this check-in week.
const markWeek = (item, week) => (item.repeat === "once" ? "" : clean(week));

export function listItems({ season = null } = {}) {
  const rows = getDb().prepare("SELECT * FROM check_items ORDER BY sort, id").all();
  return season == null ? rows : rows.filter((r) => !r.season || r.season === season);
}

export function addItem({ label, repeat = "week", week = "", league = "", division = "", season } = {}) {
  const lb = clean(label);
  if (!lb) return { error: "Name the check-off, e.g. Got gift." };
  if (!REPEATS.includes(repeat)) return { error: "Pick when it applies." };
  if (repeat === "week" && !clean(week)) return { error: "Pick the week it's for." };
  const sn = season === undefined ? (seasonForWrite() || "") : clean(season);
  const d = getDb();
  const sort = d.prepare("SELECT COALESCE(MAX(sort), 0) + 1 s FROM check_items").get().s;
  const info = d.prepare(
    "INSERT INTO check_items(label, repeat, week, season, league, division, active, sort, created_at, created_by) VALUES(?,?,?,?,?,?,1,?,?,?)"
  ).run(lb, repeat, repeat === "week" ? clean(week) : "", sn, clean(league), clean(division), sort, now(), getActor());
  logAudit("user", "create", "check_items", info.lastInsertRowid, null, { label: lb, repeat, week, league, division, season: sn }, "added check-off");
  return { status: "added", id: info.lastInsertRowid };
}

export function updateItem(id, patch = {}) {
  const d = getDb();
  const row = d.prepare("SELECT * FROM check_items WHERE id=?").get(Number(id));
  if (!row) return { error: `no check-off ${id}` };
  const next = { ...row };
  if (patch.label != null) { if (!clean(patch.label)) return { error: "The check-off needs a name." }; next.label = clean(patch.label); }
  if (patch.repeat != null) { if (!REPEATS.includes(patch.repeat)) return { error: "Pick when it applies." }; next.repeat = patch.repeat; }
  if (patch.week != null) next.week = clean(patch.week);
  if (next.repeat !== "week") next.week = "";
  if (next.repeat === "week" && !next.week) return { error: "Pick the week it's for." };
  if (patch.league != null) next.league = clean(patch.league);
  if (patch.division != null) next.division = clean(patch.division);
  if (patch.active != null) next.active = patch.active ? 1 : 0;
  d.prepare("UPDATE check_items SET label=?, repeat=?, week=?, league=?, division=?, active=? WHERE id=?")
    .run(next.label, next.repeat, next.week, next.league, next.division, next.active, row.id);
  logAudit("user", "update", "check_items", row.id, row, next, "edited check-off");
  return { status: "updated", id: row.id };
}

// Deleting an item also drops its ticks — there's nothing left to tick.
export function deleteItem(id) {
  const d = getDb();
  const row = d.prepare("SELECT * FROM check_items WHERE id=?").get(Number(id));
  if (!row) return { error: `no check-off ${id}` };
  const marks = d.prepare("DELETE FROM check_marks WHERE item_id=?").run(row.id).changes;
  d.prepare("DELETE FROM check_items WHERE id=?").run(row.id);
  logAudit("user", "delete", "check_items", row.id, row, null, `deleted check-off (${marks} ticks)`);
  return { status: "deleted", id: row.id, marks };
}

// Does this item apply to this player in this check-in week?
// `p` is player data with season / league / division on it.
export function applies(item, p, week) {
  if (!item.active) return false;
  if (item.season && clean(p.season) && item.season !== clean(p.season)) return false;
  if (item.league && item.league !== clean(p.league)) return false;
  if (item.division && item.division !== clean(p.division)) return false;
  if (item.repeat === "week" && item.week !== clean(week)) return false;
  return true;
}

// Every tick for a check-in week (plus the season-long "once" ticks), as a Set
// of "item:player" — fetched once so the whole board can be scored cheaply.
export function marksForWeek(week) {
  const set = new Set();
  for (const m of getDb().prepare("SELECT item_id, player_id, week FROM check_marks WHERE week=? OR week=''").all(clean(week))) {
    set.add(`${m.item_id}:${m.player_id}:${m.week}`);
  }
  return set;
}

// The check-offs that apply to one player this week, each with done true/false.
export function itemsForPlayer(p, week, items = listItems(), marks = marksForWeek(week)) {
  return items.filter((it) => applies(it, p, week)).map((it) => ({
    id: it.id, label: it.label, repeat: it.repeat,
    done: marks.has(`${it.id}:${p.id}:${markWeek(it, week)}`),
  }));
}

export function setMark(itemId, playerId, week, done) {
  const d = getDb();
  const item = d.prepare("SELECT * FROM check_items WHERE id=?").get(Number(itemId));
  if (!item) return { error: `no check-off ${itemId}` };
  const wk = markWeek(item, week);
  if (done) {
    d.prepare("INSERT OR REPLACE INTO check_marks(item_id, player_id, week, done_at, done_by) VALUES(?,?,?,?,?)")
      .run(item.id, Number(playerId), wk, now(), getActor());
  } else {
    d.prepare("DELETE FROM check_marks WHERE item_id=? AND player_id=? AND week=?").run(item.id, Number(playerId), wk);
  }
  logAudit("user", "update", "check_marks", Number(playerId), null, { item: item.label, week: wk, done: !!done }, `${done ? "checked off" : "unchecked"} ${item.label}`);
  return { status: "ok", done: !!done };
}
