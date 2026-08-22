// Seasons endpoint — the registry, the lifecycle, and moving people between seasons.
//
//   GET                                          → { seasons, active, counts, detail, … }
//   GET ?report=cleanup                          → what needs fixing, per season
//   GET ?history=<playerId>                      → every season that player appears in
//   POST { action:"add", name }
//   POST { action:"start", name, leagues, copy_setup_from? }
//   POST { action:"set_leagues", name, leagues }
//   POST { action:"set_active", name }
//   POST { action:"lock"|"unlock"|"archive"|"reopen", name }
//   POST { action:"enroll", to_season, from_season?|ids?, league?, bump_age?, dry_run? }
//   POST { action:"assign_orphans", name, types? }
//   POST { action:"backfill", name }             (legacy alias for assign_orphans)
import {
  listSeasons, addSeason, setActiveSeason, backfillSeason, startSeason, setSeasonLeaguesFor,
  lockSeason, unlockSeason, archiveSeason, reopenSeason,
  enrollPlayersInSeason, assignOrphansToSeason, seasonCleanupReport, playerSeasonHistory,
  copySeasonSetup,
} from "@/lib/seasons.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  bindRequest(req);
  const u = new URL(req.url);
  if (u.searchParams.get("report") === "cleanup") return Response.json(seasonCleanupReport());
  const hist = u.searchParams.get("history");
  if (hist) return Response.json(playerSeasonHistory(Number(hist)));
  return Response.json(listSeasons());
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json().catch(() => ({}));
  switch (b.action) {
    case "add":            return Response.json(addSeason(b.name));
    case "start":          return Response.json(startSeason(b.name, b.leagues || [], {
                             copy_setup_from: b.copy_setup_from || null,
                             copy: b.copy || { divisions: true },
                           }));
    case "set_leagues":    return Response.json(setSeasonLeaguesFor(b.name, b.leagues || []));
    case "set_active":     return Response.json(setActiveSeason(b.name));
    case "lock":           return Response.json(lockSeason(b.name));
    case "unlock":         return Response.json(unlockSeason(b.name));
    case "archive":        return Response.json(archiveSeason(b.name));
    case "reopen":         return Response.json(reopenSeason(b.name));
    case "copy_setup":     return Response.json(copySeasonSetup(b.from, b.to, b.copy || { divisions: true }));
    case "enroll":         return Response.json(enrollPlayersInSeason({
                             ids: b.ids || null,
                             from_season: b.from_season || null,
                             to_season: b.to_season || b.name || null,
                             league: b.league || null,
                             bump_age: !!b.bump_age,
                             keep_league: b.keep_league !== false,
                             dry_run: !!b.dry_run,
                           }));
    case "assign_orphans": return Response.json(assignOrphansToSeason(b.name, b.types || undefined));
    case "backfill":       return Response.json(backfillSeason(b.name));
    default:               return Response.json({ error: "unknown action" });
  }
}
