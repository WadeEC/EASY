import {
  movePlayer, bulkMovePlayers,
  getLeagueLocks, setLeagueLock, isLeagueLocked,
  getFields, getRecords, getDivisions,
} from "@/lib/tools.js";
import { setActorFromReq } from "@/lib/actor.js";
import { seasonFromReq, inSeason, leaguesForSeason } from "@/lib/seasons.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  setActorFromReq(req);
  const b = await req.json();
  const season = seasonFromReq(req); // sidebar season picker

  if (b.action === "move") {
    const res = movePlayer(Number(b.id), b.changes || {});
    return Response.json(res);
  }
  if (b.action === "move_bulk") {
    const res = bulkMovePlayers(b.ids || [], b.changes || {}, b.mode || "set");
    return Response.json(res);
  }
  if (b.action === "locks_list") {
    return Response.json({ locks: getLeagueLocks() });
  }
  if (b.action === "locks_set") {
    return Response.json(setLeagueLock(b.league, !!b.locked));
  }
  if (b.action === "context") {
    // Helper for the UI: returns leagues, divisions, locks, and a slim player list
    const pl = getFields("player");
    const lf = pl.find((f) => f.name === "league");
    let leagues = []; try { leagues = lf?.options ? JSON.parse(lf.options) : []; } catch {}
    const snLeagues = leaguesForSeason(season);
    if (snLeagues) leagues = leagues.filter((l) => snLeagues.includes(l));
    const players = getRecords("player").filter((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return inSeason(d, season); }).map((r) => {
      let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
      return {
        id: r.id,
        name: r.name || d.full_name || `#${r.id}`,
        league: d.league || "",
        second_league: d.second_league || "",
        division: d.division || "",
        season: d.season || "",
        age: d.age ?? "",
      };
    });
    return Response.json({
      leagues,
      divisions: getDivisions(),
      locks: getLeagueLocks(),
      players,
    });
  }
  return Response.json({ error: "unknown action" });
}
