// Comprehensive demo seeder — builds a large, realistic, fully-simulated league so every
// feature has data to show. SAFE: run with the dev server STOPPED (single writer). It backs
// up the current league.db first, then wipes and reseeds using the real app engine.
//
//   npm run seed            (then: npm run dev)
//
import fs from "fs";
import path from "path";
import { getDb } from "../lib/db.js";
import { setActor } from "../lib/actor.js";
import {
  seedStandardPlayers, seedCoaches, seedReferees, seedGamesSection, seedTournaments,
  defineRecordType, addField, addFieldOption, createRecord, applyCreateRecord, updateRecord,
  getRecords, getFields, getRecordTypes, createDivision, createTeamRule, setAllStarCap,
  saveSchedule, scheduleTeams, setCheckin, ensureJerseyHoldFlag, ensureRankingFields,
  setBalanceByRank, finalizeSeason, createAssignmentRule,
} from "../lib/tools.js";
import { buildTeams } from "../lib/teams.js";
import { buildSchedule, placeOnFields, weekDate } from "../lib/schedule.js";
import { buildRounds, scheduleRounds, recompute, roundName } from "../lib/bracket.js";

// ----------------------------------------------------------------- helpers
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const chance = (p) => Math.random() < p;
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function nextWeekday(from, weekday) { const d = new Date(from); while (d.getDay() !== weekday) d.setDate(d.getDate() + 1); return d; }
// Sunday-of-the-week ISO — must match lib/tools.js _weekStartISO so attendance lines up with seasonWeeks().
const weekStartISO = (iso) => { const d = new Date(iso + "T00:00:00"); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10); };

const FIRST = ["Liam","Noah","Mason","Mia","Ava","Ethan","Sophia","Logan","Olivia","Lucas","Emma","Jack","Ella","Owen","Aria","Leo","Nora","Eli","Cora","Sam","Max","Ivy","Jude","Zoe","Cole","Lily","Finn","Ruby","Kai","Jane","Reed","Tess","Cruz","Beau","Wren","Dax","Quinn","Rhys","Sage","Knox"];
const LAST = ["Rivera","Walsh","Cole","Nguyen","Fox","Dunn","Reed","Shah","Munoz","Doyle","Brooks","Kim","Carter","Hayes","Bauer","Lowe","Park","Diaz","Stone","Webb","Hunt","Bryant","Frost","Vance","Pena","Marsh","Cross","Holt","Ray","Wade"];
const JSIZES = ["YS","YM","YL","AS","AM","AL"];
// All leagues run on the same weekly cadence (Saturdays) so the season has ONE set of 8 weeks.
// Distinct field names + distinct ref crews per league keep games conflict-free across leagues.
const LEAGUES = [
  { name: "Saturday Limerick", weekday: 6, fields: ["Limerick Field 1", "Limerick Field 2"] },
  { name: "Sunday Upper Merion", weekday: 0, fields: ["Merion North", "Merion South"] },
];
const SEASON_START = new Date("2025-09-01T00:00:00");
const WEEKS = 8;

// deterministic-ish skill 1..5 with a curve (more 3s than 1s/5s)
const rollSkill = () => pick([1, 2, 2, 3, 3, 3, 4, 4, 5]);

function wipe(db) {
  for (const t of ["records", "rules", "fields", "record_types", "staging", "audit_log"]) {
    try { db.exec(`DELETE FROM ${t}`); } catch {}
  }
}

// ----------------------------------------------------------------- run
async function main() {
  const dbPath = process.env.LEAGUE_DB || path.join(process.cwd(), "league.db");

  // 1) Back up whatever is there (data + wal/shm) so nothing is lost.
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(path.dirname(dbPath), "_db-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backupDir, `league.db${suffix}.preseed-${ts}.bak`));
  }
  console.log(`Backed up current database to ${backupDir}`);

  const db = getDb();
  setActor("Wade Thompson");           // every change is attributed to the admin in the change log
  console.log("Wiping and reseeding…");
  wipe(db);

  // 2) Schema / sections
  seedStandardPlayers();
  seedCoaches();
  seedReferees();
  seedGamesSection();
  seedTournaments();
  ensureRankingFields();
  if (!getFields("player").some((f) => f.name === "team")) addField("player", "team", "text", "Team");
  if (!getFields("player").some((f) => f.name === "jersey_issued")) addField("player", "jersey_issued", "bool", "Jersey Issued");
  if (!getFields("coach").some((f) => f.name === "team")) addField("coach", "team", "text", "Team");
  for (const lg of LEAGUES) addFieldOption("player", "league", lg.name);   // ensure all 3 leagues are options

  // 2b) Township-based assignment rules so a newly-added player gets routed to a league
  //     based on the township they registered in. This is what makes the demo "type Limerick
  //     and watch them appear on Saturday Limerick" work end-to-end.
  createAssignmentRule("Limerick township → Saturday Limerick",
    [{ field: "township", op: "==", value: "Limerick" }], "Saturday Limerick");
  createAssignmentRule("Upper Merion township → Sunday Upper Merion",
    [{ field: "township", op: "==", value: "Upper Merion" }], "Sunday Upper Merion");
  createAssignmentRule("Phoenixville township → Saturday Limerick",
    [{ field: "township", op: "==", value: "Phoenixville" }], "Saturday Limerick");
  createAssignmentRule("Payne township → Sunday Upper Merion",
    [{ field: "township", op: "==", value: "Payne Township" }], "Sunday Upper Merion");
  createAssignmentRule("Plymouth township → Sunday Upper Merion",
    [{ field: "township", op: "==", value: "Plymouth Township" }], "Sunday Upper Merion");

  // 3) Divisions (age groups) per league
  for (const lg of LEAGUES) {
    createDivision("6U", lg.name, 5, 6);
    createDivision("8U", lg.name, 7, 8);
    createDivision("10U", lg.name, 9, 10);
    createDivision("12U", lg.name, 11, 12);
  }

  // 4) Players — ~40 per league, with sibling clusters (shared last name + league)
  let tag = 1000;
  const playersByLeague = {};
  for (const lg of LEAGUES) {
    playersByLeague[lg.name] = [];
    let made = 0;
    while (made < 40) {
      const family = chance(0.25);                 // a quarter of the time, add 2 siblings
      const last = pick(LAST);
      const sibs = family ? 2 : 1;
      for (let s = 0; s < sibs && made < 40; s++) {
        const age = 6 + rnd(7);                     // 6..12
        const skill = rollSkill();
        const data = {
          full_name: `${pick(FIRST)} ${last}`,
          age,
          league: lg.name,
          jersey_size: pick(JSIZES),
          parent_phone: `610-555-${pad(rnd(100))}${pad(rnd(100))}`.slice(0, 12),
          key_tag: String(++tag),
          jersey_issued: chance(0.8),
          _skill: skill,                            // temp, used to set rank later
        };
        const res = createRecord("player", data, data.full_name);   // engine assigns division by age+league
        if (res && res.id) playersByLeague[lg.name].push({ id: res.id, ...data });
        made++;
      }
    }
  }
  const totalPlayers = Object.values(playersByLeague).reduce((s, a) => s + a.length, 0);
  console.log(`Players: ${totalPlayers}`);

  // 5) Mark some all-stars + set the cap rule (FR all-star spread)
  for (const lg of LEAGUES) for (const p of playersByLeague[lg.name]) if (p._skill === 5 && chance(0.6)) updateRecord(p.id, { all_star: true });
  setAllStarCap(2);

  // 6) Coaches — 4 per league, each pinned to a child (a real player in that league)
  for (const lg of LEAGUES) {
    const kids = [...playersByLeague[lg.name]];
    for (let i = 0; i < 4; i++) {
      const child = kids.length ? kids.splice(rnd(kids.length), 1)[0] : null;
      createRecord("coach", {
        full_name: `${pick(FIRST)} ${pick(LAST)}`,
        role: i === 0 ? "Head Coach" : "Assistant Coach",
        league: lg.name,
        phone: `610-555-${pad(rnd(100))}${pad(rnd(100))}`.slice(0, 12),
        child_name: child ? child.full_name : "",
      }, null);
    }
  }

  // 7) Team rules the builder uses going forward
  createTeamRule("keep_together", "__siblings__", "Keep siblings together");
  createTeamRule("coach_child", "", "Keep each coach's child on their team");

  // 8) Build + SAVE balanced teams per league (this season → balanced by age)
  const coachRecs = getRecords("coach").map((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return { id: r.id, name: r.name || d.full_name, role: d.role, league: d.league, child: d.child_name }; });
  for (const lg of LEAGUES) {
    const ps = getRecords("player").map((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return { id: r.id, name: r.name || d.full_name, ...d }; }).filter((p) => p.league === lg.name);
    const cs = coachRecs.filter((c) => c.league === lg.name);
    const _res = buildTeams(ps, { rules: [{ type: "keep_together", field: "__siblings__" }, { type: "balance", field: "age" }, { type: "cap", field: "all_star", max: 2 }], coaches: cs, targetSize: 10 });
    const teams = _res.teams || _res;
    for (const t of teams) {
      for (const pl of t.players) updateRecord(pl.id, { team: t.name });
      for (const co of t.coaches) updateRecord(co.id, { team: t.name });
    }
    console.log(`${lg.name}: ${teams.length} teams`);
  }

  // 9) Referees with scan tags
  const refNames = ["Dana Whistle", "Marcus Reed", "Tom Blake", "Priya Shah", "Carlos Munoz", "Erin Doyle", "Jordan Lee", "Sam Park"];
  refNames.forEach((nm, i) => createRecord("referee", { full_name: nm, phone: `610-555-${pad(10 + i)}${pad(rnd(100))}`.slice(0, 12), league: LEAGUES[i % LEAGUES.length].name, field: LEAGUES[i % LEAGUES.length].fields[i % 2], key_tag: String(2001 + i) }, nm));
  const refByLeague = {}; for (const lg of LEAGUES) refByLeague[lg.name] = refNames.filter((_, i) => LEAGUES[i % LEAGUES.length].name === lg.name);

  // 10) Season schedule per league — conflict-free fields/times + ref crews (no double-booking)
  const leagueWeekDates = {};
  for (const lg of LEAGUES) {
    const teamNames = scheduleTeams(lg.name);
    if (teamNames.length < 2) continue;
    const start = nextWeekday(SEASON_START, lg.weekday);
    const weeks = buildSchedule(teamNames, { weeks: WEEKS, gamesPerDay: 1 });
    const dates = [];
    const games = [];
    weeks.forEach((wkGames, wi) => {
      const date = weekDate(isoOf(start), wi);   // weekDate already returns a YYYY-MM-DD string
      dates.push(date);
      const placed = placeOnFields(wkGames, lg.fields, "09:00", 60);   // 9:00 + 10:00 across 2 fields
      // assign referees: distinct per time slot so nobody is double-booked
      const bySlot = {};
      placed.forEach((g) => { (bySlot[g.time] = bySlot[g.time] || []).push(g); });
      Object.values(bySlot).forEach((slot) => slot.forEach((g, idx) => { g.referee = refByLeague[lg.name][idx % refByLeague[lg.name].length] || refNames[idx % refNames.length]; }));
      placed.forEach((g) => games.push({ week: wi + 1, date, time: g.time, home: g.home, away: g.away, location: g.location, referee: g.referee }));
    });
    leagueWeekDates[lg.name] = dates;
    saveSchedule(lg.name, games);
    console.log(`${lg.name}: ${games.length} games over ${dates.length} weeks`);
  }

  // 11) Attendance — 8 weeks, realistic patterns; some miss the first 2 weeks (jersey-hold)
  for (const lg of LEAGUES) {
    const dates = leagueWeekDates[lg.name] || [];
    for (const p of playersByLeague[lg.name]) {
      const earlyMisser = chance(0.1);               // ~10% miss the opener → jersey-hold flag
      const lowAvail = !earlyMisser && chance(0.15); // ~15% show up rarely → low-availability cohort
      const rate = earlyMisser ? 0.7 : lowAvail ? 0.12 : pick([0.75, 0.85, 0.95, 1.0]);
      dates.forEach((wk, wi) => {
        const week = weekStartISO(wk);               // record on the week-start (Sunday), matching seasonWeeks()
        if (wi < 2) { if (!earlyMisser) setCheckin(p.id, p.full_name, week, true); return; }  // everyone else is present weeks 1-2
        if (Math.random() < rate) setCheckin(p.id, p.full_name, week, true);
      });
    }
  }
  ensureJerseyHoldFlag();   // "missed first 2 weeks → hold jersey" rule
  console.log("Attendance + jersey-hold flag seeded");

  // 12) End-of-season rankings (1-5) → finalize season → turn on rank-balance for next season (FR-2.10)
  for (const lg of LEAGUES) for (const p of playersByLeague[lg.name]) updateRecord(p.id, { end_season_rank: p._skill });
  finalizeSeason("2025 Fall");
  setBalanceByRank(true);
  console.log("End-of-season rankings set + balance-by-rank enabled");

  // 13) Tournament — single elim, 8 uniquely-named showcase teams, with results entered
  const tTeams = ["Limerick Lions", "Merion Mustangs", "KOP Comets", "Valley Vipers", "Ridge Raiders", "Limerick Llamas", "Merion Marauders", "KOP Cobras"];
  if (tTeams.length >= 2) {
    let rounds = scheduleRounds(buildRounds(tTeams), ["Championship Field", "North Field"], "09:00", 45, 20);
    for (const m of rounds[0]) if (m.home && m.away && m.home !== "(bye)" && m.away !== "(bye)") m.winner = m.home;
    recompute(rounds);
    if (rounds[1]) { for (const m of rounds[1]) if (m.home && m.away) m.winner = m.home; recompute(rounds); }
    const refRot = ["Dana Whistle", "Marcus Reed", "Tom Blake", "Priya Shah"];
    for (const rd of rounds) { const bySlot = {}; for (const m of rd) { if (m.home === "(bye)" || m.away === "(bye)" || !m.time) continue; (bySlot[m.time] = bySlot[m.time] || []).push(m); } Object.values(bySlot).forEach((slot) => slot.forEach((m, i) => { m.ref = refRot[i % refRot.length]; })); }
    const st = { teams: tTeams, fields: ["Championship Field", "North Field"], startTime: "09:00", slotMins: 45, roundGap: 20, date: "2025-11-08", rounds };
    createRecord("tournament", { name: "Fall Classic", date: "2025-11-08", state: JSON.stringify(st) }, "Fall Classic");
    console.log(`Tournament: Fall Classic (${tTeams.length} teams, ${rounds.length} rounds)`);
  }

  // 14) A few representative admin edits so the Change Log / Time Machine show real actions on top
  const saturday = getRecords("player").map((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return { id: r.id, name: r.name, ...d }; }).filter((p) => p.league === "Saturday Limerick" && p.team);
  if (saturday.length >= 2) {
    const a = saturday[0], b = saturday[1];
    if (a.team !== b.team) updateRecord(a.id, { team: b.team });   // a roster move
  }

  // summary
  const count = (t) => getRecords(t).length;
  console.log("\n=== Seed complete ===");
  console.log(`players ${count("player")} · coaches ${count("coach")} · games ${count("game")} · referees ${count("referee")} · divisions ${count("division")} · attendance ${count("attendance")} · tournaments ${count("tournament")}`);
  console.log("Now start the app:  npm run dev");
}

export { main };
// Auto-run when invoked as a CLI (node scripts/seed-demo.mjs), but not when imported.
const invoked = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invoked) main().then(() => process.exit(0)).catch((e) => { console.error("Seed failed:", e); process.exit(1); });
