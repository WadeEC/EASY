import {
  scheduleTeams, getSchedule, saveSchedule, getFields, getRecords, updateRecord,
  markGameWorked, unmarkGameWorked, logRefShift, payReport,
  setGameScore, clearGameScore, getStandings,
  listBlackouts, blackoutDateSet, addBlackout, removeBlackout, applyRainout, previewRainout,
  rescheduleDate, pruneCrossDivisionGames,
} from "@/lib/tools.js";
import { buildSchedule, weekDate, clockTime, placeOnFields } from "@/lib/schedule.js";
import { seasonFromReq, leaguesForSeason } from "@/lib/seasons.js";
import { setActorFromReq } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  setActorFromReq(req);
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
      return { team: d.team || "", league: d.league || "", second_league: d.second_league || "", division: d.division || "", season: d.season ? String(d.season) : "" };
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
    const divOfTeam = (n) => { const i = String(n || "").indexOf(" / "); return i > 0 ? String(n).slice(0, i) : ""; };
    const teamsByDiv = new Map();
    for (const t of teams) {
      const dv = divOfTeam(t);
      if (!teamsByDiv.has(dv)) teamsByDiv.set(dv, []);
      teamsByDiv.get(dv).push(t);
    }
    const realDivisions = [...teamsByDiv.keys()].filter((d) => !!d);
    // For each division (or the whole league if none), build its round-robin
    // independently so we can stagger start times without games stomping each
    // other on fields.
    const groupBuilds = realDivisions.length
      ? realDivisions.map((dv) => ({ division: dv, teams: teamsByDiv.get(dv), start: divisionStarts[dv] || b.startTime || null,
          weeks: buildSchedule(teamsByDiv.get(dv), { startDate: b.startDate, weeks: b.weeks, gamesPerDay: b.gamesPerDay }) }))
      : [{ division: "", teams, start: b.startTime || null,
          weeks: buildSchedule(teams, { startDate: b.startDate, weeks: b.weeks, gamesPerDay: b.gamesPerDay }) }];
    const totalWeeks = Math.max(...groupBuilds.map((g) => g.weeks.length), 0);
    const weeks = Array.from({ length: totalWeeks }, (_, i) => {
      const date = weekDate(b.startDate, i, blackouts);
      const games = [];
      for (const g of groupBuilds) {
        const wkGames = g.weeks[i] || [];
        const placed = placeOnFields(wkGames, fields, g.start, gap);
        for (const p of placed) games.push(p);
      }
      return { week: i + 1, date, games };
    });
    return Response.json({
      teams, autoTeams, fields,
      divisions: realDivisions,
      division_start_times: divisionStarts,
      blackouts: listBlackouts(b.league || null),
      weeks,
    });
  }

  if (b.action === "save") return Response.json(saveSchedule(b.league || null, b.games || [], season));
  if (b.action === "clear") return Response.json({ ...saveSchedule(b.league || null, [], season), cleared: true });
  if (b.action === "list") return Response.json({ games: getSchedule(b.league || null, season) });
  if (b.action === "assign_ref") { updateRecord(Number(b.game_id), { referee: b.referee || "" }); return Response.json({ status: "ok" }); }

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
