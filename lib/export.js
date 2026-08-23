// Exports — a season's leagues as Excel and CSV.
//
// Everything here reads ONE named season. There is no "current" anything: the
// caller says which season, and the sheets that come out are that season's
// players, teams, schedule, standings, coaches, unassigned and master rows.
// An export that silently blended two seasons would be worse than no export.
//
// Zero new dependencies: xlsx is already used by the master sheet, and the zip
// writer below is ~60 lines of stored-entry ZIP so a "download all CSVs"
// button doesn't drag in another package.
import * as XLSX from "xlsx";
import {
  getRecordsForSeason, getStandings, masterColumns, readMaster,
  attendanceWeek, attendanceWeeks, isPresentRow, rosterOrder, seasonWeekList, divisionOf,} from "./tools.js";
import { seasonLeagues, unassignedFor, getSeason } from "./seasons.js";

const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const val = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v);

// ---------------------------------------------------------------- sheet builders
// Every builder returns { name, header, rows } — a plain matrix, so the same
// data can become a worksheet or a .csv without a second code path.

function playersSheet(players, title = "Roster") {
  const header = ["ID", "Name", "Age", "League", "2nd League", "Division", "Team",
    "Township", "Parent Phone", "Jersey Size", "Key Tag", "All Star", "Notes"];
  const rows = players.map((p) => [
    p.id, p.name, p.age ?? "", p.league || "", p.second_league || "", divisionOf(p),
    p.team || "", p.township || "", p.parent_phone || p.phone || "", p.jersey_size || "",
    p.key_tag || "", p.all_star ? "Yes" : "", p.notes || "",
  ]);
  return { name: title, header, rows };
}

function teamsSheet(players, coaches) {
  const byTeam = new Map();
  for (const p of players) {
    const t = p.team || "";
    if (!t) continue;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t).push(p);
  }
  const coachByTeam = new Map();
  for (const c of coaches) {
    const t = c.team || "";
    if (!t) continue;
    if (!coachByTeam.has(t)) coachByTeam.set(t, []);
    coachByTeam.get(t).push(`${c.name}${c.role ? ` (${c.role})` : ""}`);
  }
  const header = ["Team", "Division", "Players", "Avg Age", "Coaches", "Roster"];
  const rows = [...byTeam.keys()].sort((a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true })
  ).map((t) => {
    const roster = byTeam.get(t);
    const ages = roster.map((p) => Number(p.age)).filter((n) => Number.isFinite(n));
    const div = String(t).includes("/") ? String(t).split("/")[0].trim() : (roster[0]?.division || "");
    return [
      t, div, roster.length,
      ages.length ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10 : "",
      (coachByTeam.get(t) || []).join(", "),
      roster.map((p) => p.name).sort().join(", "),
    ];
  });
  return { name: "Teams", header, rows };
}

function coachesSheet(coaches) {
  const header = ["ID", "Name", "Role", "Type", "League", "Team", "Phone", "Child"];
  const rows = coaches.map((c) => [
    c.id, c.name, c.role || "", c.coach_type || "", c.league || "", c.team || "",
    c.phone || "", c.child || c.child_name || "",
  ]);
  return { name: "Coaches", header, rows };
}

function scheduleSheet(games) {
  const header = ["Week", "Date", "Time", "Field", "Home", "Away", "Home Score", "Away Score", "Winner", "Referee"];
  const rows = games
    .slice()
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) ||
      String(a.time || "").localeCompare(String(b.time || "")))
    .map((g) => [
      g.week ?? "", g.date || "", g.time || "", g.location || g.field || "",
      g.home_team || "", g.away_team || "",
      g.home_score ?? "", g.away_score ?? "", g.winner || "", g.referee || "",
    ]);
  return { name: "Schedule", header, rows };
}

function standingsSheet(rows) {
  const header = ["Team", "W", "L", "T", "PF", "PA", "Diff", "Played"];
  const body = (rows || []).map((s) => [
    s.team, s.w ?? s.wins ?? 0, s.l ?? s.losses ?? 0, s.t ?? s.ties ?? 0,
    s.pf ?? s.points_for ?? 0, s.pa ?? s.points_against ?? 0,
    (s.pf ?? s.points_for ?? 0) - (s.pa ?? s.points_against ?? 0),
    s.played ?? s.gp ?? 0,
  ]);
  return { name: "Standings", header, rows: body };
}

function unassignedSheet(u, league) {
  const header = ["Problem", "ID", "Name", "Age", "League", "Division", "Team", "Township"];
  const rows = [];
  const push = (label, list) => {
    for (const p of list) {
      if (league && p.league && p.league !== league) continue;
      if (league && !p.league && label !== "No league") continue;
      rows.push([label, p.id, p.name, p.age ?? "", p.league || "", divisionOf(p), p.team || "", p.township || ""]);
    }
  };
  push("No league", u.no_league);
  push("No division", u.no_division);
  push("No team", u.no_team);
  return { name: "Unassigned", header, rows };
}

function masterSheet(season, league) {
  const rows = readMaster({ record_type: "player", season, limit: 50000 })
    .filter((r) => !league || (r.source_league || "") === league);
  const cols = masterColumns("player", season);
  const prov = ["First Name", "Last Name", "_id", "_season", "_source_file", "_source_district",
    "_source_league", "_status", "_player_id", "_identity_key", "_imported_at", "_imported_by"];
  const header = [...prov, ...cols];
  const body = rows.map((r) => [
    r.first_name || "", r.last_name || "",
    r.id, r.season || "", r.source_file || "", r.source_district || "", r.source_league || "",
    r.status || "", r.player_id || "", r.identity_key || "", r.imported_at || "", r.imported_by || "",
    ...cols.map((c) => val(r.data[c])),
  ]);
  return { name: "Master Sheet", header, rows: body };
}

// ---------------------------------------------------------------- attendance
// One week, as a sheet a coach can read: everyone on the roster with what
// happened. "Not taken" is its own value, distinct from "Absent" — a blank in
// the old grid meant both, which made an exported week impossible to trust.
const STATUS_LABEL = { present: "Present", absent: "Absent", excused: "Excused", "": "Not taken" };

export function attendanceWeekSheet(week, league = null) {
  const w = attendanceWeek({ week, league });
  const header = ["Week", "Team", "Division", "League", "Player", "Status", "Note", "Marked at", "Marked by", "Via"];
  const rows = (w.rows || []).map((r) => [
    week, r.team || "", r.division || "", r.league || "", r.name,
    STATUS_LABEL[r.status] ?? r.status, r.note || "",
    r.marked_at || "", r.marked_by || "", r.via || "",
  ]);
  return { name: `Attendance ${week}`, header, rows, totals: w.totals };
}

// The whole season as one grid: a row per player, a column per week, plus the
// count. Same numbers the Attendance page shows.
export function attendanceGridSheet(season, league = null) {
  // The season's own weeks — the same list the Attendance page shows, not one
  // derived from the schedule.
  const weekList = seasonWeekList();
  const weeks = weekList.map((w) => w.week);
  const players = getRecordsForSeason("player", season).map((r) => ({
    id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data),
  })).filter((p) => inLeague(p, league));

  const marks = new Map(); // playerId -> week -> status
  for (const r of getRecordsForSeason("attendance", season)) {
    const d = parse(r.data);
    const pid = Number(d.player_id);
    if (!pid || !d.week) continue;
    if (!marks.has(pid)) marks.set(pid, new Map());
    marks.get(pid).set(String(d.week), String(d.status || "present").toLowerCase());
  }

  // Column heads read the way the app does — "Week 1", or whatever you renamed
  // it to. No dates: the ISO key is a filing detail, not a thing to print.
  const header = ["Player", "Team", "Division", "League",
    ...weekList.map((w, i) => (w.label || `Week ${i + 1}`) + (w.cancelled ? " (cancelled)" : "")),
    "Present", "Absent"];
  // Division first (youngest bracket), then team, then name A–Z.
  const rows = players
    .slice()
    .sort(rosterOrder())
    .map((p) => {
      const m = marks.get(p.id) || new Map();
      const cells = weeks.map((w) => {
        const st = m.get(w);
        return st === undefined ? "" : (st === "present" ? "P" : st === "absent" ? "A" : "E");
      });
      return [
        p.name, p.team || "", p.division || "", p.league || "", ...cells,
        cells.filter((c) => c === "P").length,
        cells.filter((c) => c === "A").length,
      ];
    });
  return { name: "Attendance", header, rows };
}

// ---------------------------------------------------------------- assembly
function loadSeason(season) {
  const players = getRecordsForSeason("player", season).map((r) => ({
    id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data),
  }));
  const coaches = getRecordsForSeason("coach", season).map((r) => ({
    id: r.id, name: r.name || parse(r.data).full_name || `#${r.id}`, ...parse(r.data),
  }));
  const games = getRecordsForSeason("game", season).map((r) => ({ id: r.id, ...parse(r.data) }));
  return { players, coaches, games };
}

function inLeague(x, league) {
  if (!league) return true;
  return (x.league || "") === league || (x.second_league || "") === league;
}

// Sheets for one league inside one season.
export function leagueSheets(season, league) {
  const { players, coaches, games } = loadSeason(season);
  const lp = players.filter((p) => inLeague(p, league));
  const lc = coaches.filter((c) => inLeague(c, league));
  const lg = games.filter((g) => !league || (g.league || "") === league);
  const u = unassignedFor(season);

  let standings = [];
  try { standings = getStandings(league || null, season) || []; } catch {}
  if (standings && standings.rows) standings = standings.rows;

  return [
    playersSheet(lp, "Roster"),
    unassignedSheet(u, league),
    teamsSheet(lp, lc),
    coachesSheet(lc),
    scheduleSheet(lg),
    standingsSheet(standings),
    attendanceGridSheet(season, league),
    masterSheet(season, league),
  ];
}

// Sheets for a whole season: a summary, then one roster sheet per league.
export function seasonSheets(season) {
  const { players, coaches, games } = loadSeason(season);
  const leagues = leaguesInSeason(season, players);
  const u = unassignedFor(season);

  const summary = {
    name: "Season Summary",
    header: ["League", "Players", "Teams", "Coaches", "Games", "No league", "No division", "No team"],
    rows: leagues.map((lg) => {
      const lp = players.filter((p) => inLeague(p, lg));
      return [
        lg, lp.length, new Set(lp.map((p) => p.team).filter(Boolean)).size,
        coaches.filter((c) => inLeague(c, lg)).length,
        games.filter((g) => (g.league || "") === lg).length,
        u.no_league.filter((p) => !p.league).length,
        u.no_division.filter((p) => p.league === lg).length,
        u.no_team.filter((p) => p.league === lg).length,
      ];
    }),
  };
  const sheets = [summary, playersSheet(players, "All Players"), unassignedSheet(u, null)];
  for (const lg of leagues) {
    const lp = players.filter((p) => inLeague(p, lg));
    sheets.push(playersSheet(lp, sheetName(lg)));
  }
  sheets.push(scheduleSheet(games));
  sheets.push(attendanceGridSheet(season, null));
  sheets.push(coachesSheet(coaches));
  sheets.push(masterSheet(season, null));
  return sheets;
}

export function leaguesInSeason(season, players = null) {
  const declared = seasonLeagues()[season] || [];
  const p = players || getRecordsForSeason("player", season).map((r) => parse(r.data));
  const seen = new Set(declared);
  for (const x of p) { if (x.league) seen.add(x.league); if (x.second_league) seen.add(x.second_league); }
  return [...seen].filter(Boolean).sort();
}

// Excel caps sheet names at 31 chars and forbids : \ / ? * [ ]
function sheetName(s) {
  return String(s || "Sheet").replace(/[:\\/?*[\]]/g, "-").slice(0, 31) || "Sheet";
}

function toMatrix(sheet) { return [sheet.header, ...sheet.rows]; }

export function buildWorkbook(sheets, { title = "Export" } = {}) {
  const wb = XLSX.utils.book_new();
  const used = new Set();
  for (const s of sheets) {
    let nm = sheetName(s.name);
    let i = 2;
    while (used.has(nm.toLowerCase())) nm = sheetName(`${s.name} ${i++}`);
    used.add(nm.toLowerCase());
    const ws = XLSX.utils.aoa_to_sheet(toMatrix(s));
    // Readable column widths beat a wall of ####.
    ws["!cols"] = s.header.map((h, i) => {
      const w = Math.max(String(h).length, ...s.rows.slice(0, 400).map((r) => String(r[i] ?? "").length));
      return { wch: Math.min(Math.max(w + 2, 8), 48) };
    });
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, nm);
  }
  if (!sheets.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["No data"]]), "Empty");
  wb.Props = { Title: title };
  return Buffer.from(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

export function toCsv(sheet) {
  const esc = (s) => {
    const v = String(s == null ? "" : s);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return toMatrix(sheet).map((r) => r.map(esc).join(",")).join("\r\n");
}

// ---------------------------------------------------------------- zip
// Minimal ZIP writer, stored (no compression) — enough for a bundle of CSVs
// and it keeps the dependency list where it is.
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function buildZip(files) {
  // files: [{ name, content }]
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const data = Buffer.from(f.content, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 name flag
    local.writeUInt16LE(0, 8);           // stored
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date (1996-01-01, fixed → reproducible)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// ---------------------------------------------------------------- entry points
const safe = (s) => String(s || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";

export function exportPlan({ season, league = null, scope = "league", week = null }) {
  const sn = String(season || "").trim();
  if (!sn) return { error: "Which season?" };
  if (!getSeason(sn)) return { error: `There's no season called "${sn}".` };

  // One week of attendance, or the whole season's grid.
  if (scope === "attendance") {
    if (week) {
      const known = attendanceWeeks(league);
      if (!known.includes(String(week))) {
        return { error: `${week} isn't a week in ${sn}. Weeks: ${known.join(", ") || "none yet"}.` };
      }
      return {
        season: sn, league, week,
        sheets: [attendanceWeekSheet(String(week), league)],
        base: `${safe(sn)}${league ? "-" + safe(league) : ""}-attendance-${safe(week)}`,
      };
    }
    return {
      season: sn, league,
      sheets: [attendanceGridSheet(sn, league)],
      base: `${safe(sn)}${league ? "-" + safe(league) : ""}-attendance`,
    };
  }

  if (scope === "season") {
    return { season: sn, league: null, sheets: seasonSheets(sn), base: `${safe(sn)}-all-leagues` };
  }
  if (!league) return { error: "Which league? (or ask for the whole season)" };
  const leagues = leaguesInSeason(sn);
  if (!leagues.includes(league)) {
    return { error: `"${league}" isn't a league in ${sn}. This season has: ${leagues.join(", ") || "none yet"}.` };
  }
  return { season: sn, league, sheets: leagueSheets(sn, league), base: `${safe(sn)}-${safe(league)}` };
}

export function exportXlsx(opts) {
  const plan = exportPlan(opts);
  if (plan.error) return plan;
  return {
    filename: `${plan.base}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: buildWorkbook(plan.sheets, { title: `${plan.season}${plan.league ? " — " + plan.league : ""}` }),
    sheets: plan.sheets.map((s) => ({ name: s.name, rows: s.rows.length })),
  };
}

export function exportCsvZip(opts) {
  const plan = exportPlan(opts);
  if (plan.error) return plan;
  const files = plan.sheets.map((s) => ({ name: `${plan.base}/${safe(s.name)}.csv`, content: toCsv(s) }));
  return {
    filename: `${plan.base}-csv.zip`,
    contentType: "application/zip",
    body: buildZip(files),
    sheets: plan.sheets.map((s) => ({ name: s.name, rows: s.rows.length })),
  };
}

// One sheet as a bare .csv — what "just give me the roster" means.
export function exportCsv(opts) {
  const plan = exportPlan(opts);
  if (plan.error) return plan;
  // "The roster as a CSV" means different sheet names depending on scope — a
  // league export calls it Roster, a whole-season one calls it All Players.
  // Fall through the aliases rather than handing back the summary tab.
  const wanted = [opts.sheet, "Roster", "All Players"].filter(Boolean).map((x) => String(x).toLowerCase());
  let sheet = null;
  for (const w of wanted) { sheet = plan.sheets.find((x) => x.name.toLowerCase() === w); if (sheet) break; }
  if (!sheet) sheet = plan.sheets[0];
  return {
    filename: `${plan.base}-${safe(sheet.name)}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: Buffer.from("﻿" + toCsv(sheet), "utf8"), // BOM so Excel opens UTF-8 cleanly
    sheets: [{ name: sheet.name, rows: sheet.rows.length }],
  };
}
