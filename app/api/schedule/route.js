import {
  scheduleTeams, scheduleTeamsByDivision, teamDivisionMap, getSchedule, saveSchedule, getFields, getRecords, updateRecord,
  markGameWorked, unmarkGameWorked, logRefShift, payReport,
  setGameScore, clearGameScore, getStandings,
  listBlackouts, blackoutDateSet, addBlackout, removeBlackout, applyRainout, previewRainout,
  rescheduleDate, pruneCrossDivisionGames, addGame, divisionOf,} from "@/lib/tools.js";
import { buildSchedule, weekDate, clockTime, placeOnFields, minutesOf } from "@/lib/schedule.js";
import { seasonFromReq, leaguesForSeason } from "@/lib/seasons.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  const season = seasonFromReq(req); // sidebar season picker — null = all seasons

  if (b.action === "config") {
    const pl = getFields("player").find((f) => f.name === "league");
    let leagues = [];
    try { leagues = pl && pl.options ? JSON.parse(pl.options) : []; } catch {}
    const snLeagues = leaguesForSeason(season);
    if (snLeagues) leagues = leagues.filter((l) => snLeagues.includes(l));
    const players = getRecords("player").map((r) => {
      let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
      return { team: d.team || "", league: d.league || "", second_league: d.second_league || "", division: divisionOf(d), season: d.season ? String(d.season) : "" };
    }).filter((p) => p.team && (!season || !p.season || p.season === season));
    function teamStats(league) {
      const stats = {};
      for (const p of players) {
        if (league && p.league !== league && p.second_league !== league) continue;
        const s = stats[p.team] || (stats[p.team] = { team: p.team, players: 0, divisions: new Set() });
        s.players++;
        if (p.division) s.divisions.add(p.division);
      }
      return Object.values(stats).map((s) => ({ team: s.team, players: s.players, divisions: [...s.divisions].sort() })).sort((a, b) => a.team.localeCompare(b.team));
    }
    return Response.json({
      leagues,
      allTeams: scheduleTeams(null, season),
      teamsByLeague: Object.fromEntries(leagues.map((l) => [l, scheduleTeams(l, season)])),
      teamStats: Object.fromEntries(leagues.map((l) => [l, teamStats(l)])),
      allTeamStats: teamStats(null),
      // Teams grouped by the bracket they really play in — the build form shows
      // this so you can see what each division's schedule will contain.
      byDivision: Object.fromEntries(leagues.map((l) => [l, scheduleTeamsByDivision(l, season)])),
    });
  }

  if (b.action === "preview") {
    const autoTeams = scheduleTeams(b.league || null, season);
    const teams = Array.isArray(b.teams) && b.teams.length ? b.teams.map(String) : autoTeams;
    const gap = Number(b.slotMins) || 0;
    const fields = Array.isArray(b.fields) ? b.fields.map((f) => String(f).trim()).filter(Boolean) : [];
    const blackouts = blackoutDateSet(b.league || null);
    // Per-division start times — same league day, different times per division.
    const divisionStarts = b.division_start_times || {};
    // A team's division comes from WHO IS ON IT (their ages), with the name
    // prefix only as a fallback. Teams built before divisions existed are just
    // "Team 7" — the old name-only rule put them all in one bracket-less pool,
    // which is how a schedule ended up pairing eight-year-olds with fifteens.
    const dvMap = teamDivisionMap(b.league || null, season);
    const teamsByDiv = new Map();
    const mixedTeams = [];
    for (const t of teams) {
      const info = dvMap.get(t);
      if (info && info.mixed) { mixedTeams.push({ team: t, breakdown: info.breakdown }); continue; }
      const dv = info ? (info.division || "") : (() => { const i = String(t || "").indexOf(" / "); return i > 0 ? String(t).slice(0, i) : ""; })();
      if (!teamsByDiv.has(dv)) teamsByDiv.set(dv, []);
      teamsByDiv.get(dv).push(t);
    }
    if (mixedTeams.length) {
      return Response.json({
        error: `These teams have players from more than one age bracket, so there's no division to schedule them in: ${mixedTeams.map((m) => m.team).join(", ")}. Rebuild the teams per division, or move those players, then try again.`,
        mixed_teams: mixedTeams,
      });
    }
    const realDivisions = [...teamsByDiv.keys()].filter((d) => !!d);
    const soloDivisions = realDivisions.filter((d) => (teamsByDiv.get(d) || []).length < 2);
    // For each division (or the whole league if none), build its round-robin
    // independently so we can stagger start times without games stomping each
    // other on fields.
    const groupBuilds = realDivisions.length
      ? realDivisions.filter((dv) => (teamsByDiv.get(dv) || []).length >= 2).map((dv) => ({ division: dv, teams: teamsByDiv.get(dv), start: divisionStarts[dv] || b.startTime || null,
          weeks: buildSchedule(teamsByDiv.get(dv), { startDate: b.startDate, weeks: b.weeks, gamesPerDay: b.gamesPerDay }) }))
      : [{ division: "", teams, start: b.startTime || null,
          weeks: buildSchedule(teams, { startDate: b.startDate, weeks: b.weeks, gamesPerDay: b.gamesPerDay }) }];
    const totalWeeks = Math.max(...groupBuilds.map((g) => g.weeks.length), 0);
    // One field ledger per game day, shared by every division: whoever plays an
    // hour first fills the low-numbered fields and the next division picks up
    // where they stopped (Ages 7-8 on Fields 1-2 at 1:00, Ages 9-10 on 3-5),
    // instead of each bracket restarting at Field 1 and colliding. Earliest
    // start time places first.
    const placeOrder = groupBuilds
      .map((g, i) => ({ g, i, m: minutesOf(g.start) }))
      .sort((a, b) => (a.m == null ? 1e9 : a.m) - (b.m == null ? 1e9 : b.m) || a.i - b.i)
      .map((x) => x.g);
    const weeks = Array.from({ length: totalWeeks }, (_, i) => {
      const date = weekDate(b.startDate, i, blackouts);
      const games = [];
      const dayFields = new Map(); // field -> booked minute ranges for this date
      for (const g of placeOrder) {
        const wkGames = g.weeks[i] || [];
        const placed = placeOnFields(wkGames, fields, g.start, gap, dayFields);
        for (const p of placed) games.push(p);
      }
      return { week: i + 1, date, games };
    });
    return Response.json({
      teams, autoTeams, fields,
      divisions: realDivisions,
      // What will actually be built, bracket by bracket. Teams never play
      // outside their own.
      per_division: realDivisions.map((dv) => ({
        division: dv, teams: (teamsByDiv.get(dv) || []).length, start_time: divisionStarts[dv] || b.startTime || null,
      })),
      solo_divisions: soloDivisions.map((dv) => ({ division: dv, teams: (teamsByDiv.get(dv) || []).length })),
      no_division_teams: teamsByDiv.get("") || [],
      division_start_times: divisionStarts,
      blackouts: listBlackouts(b.league || null),
      weeks,
    });
  }

  if (b.action === "save") return Response.json(saveSchedule(b.league || null, b.games || [], season));
  if (b.action === "clear") return Response.json({ ...saveSchedule(b.league || null, [], season), cleared: true });
  if (b.action === "list") return Response.json({ games: getSchedule(b.league || null, season) });
  // One game at a time — a make-up, a tournament fixture, anything the round-robin
  // build didn't produce. Unlike "save", this never touches the existing schedule.
  // The same tools function S-Dot's add_game calls, so both routes behave identically.
  if (b.action === "add_game") return Response.json(addGame({
    league: b.league || null, date: b.date, time: b.time,
    home_team: b.home, away_team: b.away, field: b.location, referee: b.referee, week: b.week,
  }));
  if (b.action === "assign_ref") {
    const res = updateRecord(Number(b.game_id), { referee: b.referee || "" });
    return Response.json(res.error ? { error: res.error } : { status: "ok" });
  }

  if (b.action === "mark_worked") return Response.json(markGameWorked(b.game_id, b.ref_name));
  if (b.action === "unmark_worked") return Response.json(unmarkGameWorked(b.game_id, b.ref_name));
  if (b.action === "ref_shift") return Response.json(logRefShift(b.ref_name, b.shift));
  if (b.action === "pay_report") return Response.json({ rows: payReport({ from: b.from, to: b.to, league: b.league, field: b.field }) });

  if (b.action === "set_score") return Response.json(setGameScore(b.game_id, { home_score: b.home_score, away_score: b.away_score, forfeit: b.forfeit, note: b.note }));
  if (b.action === "clear_score") return Response.json(clearGameScore(b.game_id));
  if (b.action === "standings") return Response.json({ rows: getStandings(b.league || null, season) });

  if (b.action === "blackouts_list") return Response.json({ blackouts: listBlackouts(b.league || null) });
  if (b.action === "blackout_add") return Response.json(addBlackout(b.date, b.league || null, b.reason || ""));
  if (b.action === "blackout_remove") return Response.json(removeBlackout(b.id));
  if (b.action === "rainout_preview") return Response.json(previewRainout({ date: b.date, league: b.league || null }));
  if (b.action === "rainout_apply") return Response.json(applyRainout({ date: b.date, league: b.league || null, reason: b.reason || "Rainout" }));
  if (b.action === "reschedule_date") return Response.json(rescheduleDate({ from: b.from, to: b.to, league: b.league || null, dry: !!b.dry }));
  if (b.action === "prune_cross_division") return Response.json(pruneCrossDivisionGames(b.league || null));

  return Response.json({ error: "unknown action" });
}
