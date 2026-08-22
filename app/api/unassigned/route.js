// This season's Unassigned.
//
// "Unassigned" used to mean whatever each screen decided it meant. It now means
// one thing, per season, split into the three problems that actually need
// different fixes:
//   no_league   — nobody has routed them yet (assignment rules / township)
//   no_division — in a league, but no age bracket
//   no_team     — in a division, but the team build hasn't placed them
//
//   GET  /api/unassigned                → the scoped season's three buckets
//   GET  /api/unassigned?season=Fall%202026
//   POST { action:"assign", ids, league?, division?, team? }
//   POST { action:"auto_division" }     → re-sort by age into this season's divisions
//   POST { action:"place_on_teams", league?, division?, ids?, max_size?, dry_run }
//        → seat players who have no team onto the teams that already exist,
//          without moving anyone who is already on one
import { bindRequest } from "@/lib/actor.js";
import { unassignedFor, leaguesForSeason } from "@/lib/seasons.js";
import { bulkMovePlayers, getDivisions, getLeagueLocks, reassignDivisions, placeUnassignedPlayers, leagueOptions } from "@/lib/tools.js";
import { currentScope, scopeLabel } from "@/lib/season-scope.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  bindRequest(req);
  const u = new URL(req.url);
  const named = u.searchParams.get("season");
  const data = named ? unassignedFor(named) : unassignedFor();
  return Response.json({
    ...data,
    scope: scopeLabel(),
    divisions: getDivisions(),
    // The configured leagues for this season — not the ones that happen to be
    // set on a division record (divisions are usually league-wide, so that
    // list was empty and the League picker had nothing in it).
    leagues: leagueOptions(
      (data.no_league || []).concat(data.no_division || [], data.no_team || []).map((p) => p.league),
      leaguesForSeason(named || currentScope().season),
    ),
    locks: getLeagueLocks(),
  });
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json().catch(() => ({}));

  if (b.action === "assign") {
    const ids = (b.ids || []).map(Number).filter(Boolean);
    if (!ids.length) return Response.json({ error: "Pick at least one player." });
    const changes = {};
    for (const k of ["league", "division", "team"]) {
      if (Object.prototype.hasOwnProperty.call(b, k)) changes[k] = b[k] || "";
    }
    if (!Object.keys(changes).length) return Response.json({ error: "Nothing to change." });
    const res = bulkMovePlayers(ids, changes, "set");
    return Response.json({ ...res, remaining: unassignedFor().counts });
  }

  // Late arrivals onto the teams that already exist. Preview by default;
  // nobody who already has a team is touched either way.
  if (b.action === "place_on_teams") {
    const res = placeUnassignedPlayers({
      league: b.league || null, division: b.division || null,
      ids: Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : null,
      max_size: b.max_size ?? null,
      dry_run: b.dry_run !== false,
    });
    return Response.json(res.error ? res : { ...res, remaining: unassignedFor().counts });
  }

  if (b.action === "auto_division") {
    const res = reassignDivisions();
    return Response.json({ ...res, remaining: unassignedFor().counts });
  }

  return Response.json({ error: "unknown action" });
}
