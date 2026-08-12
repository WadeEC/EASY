// Seasons endpoint.
//   GET                                → { seasons, active, counts, untagged }
//   POST { action:"add", name }        → create a season (first one becomes active)
//   POST { action:"set_active", name } → set the app-wide active season
//   POST { action:"backfill", name }   → tag every season-less player (audited)
import { listSeasons, addSeason, setActiveSeason, backfillSeason, startSeason, setSeasonLeaguesFor } from "@/lib/seasons.js";
import { setActorFromReq } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(listSeasons());
}

export async function POST(req) {
  setActorFromReq(req);
  const b = await req.json().catch(() => ({}));
  if (b.action === "add") return Response.json(addSeason(b.name));
  if (b.action === "start") return Response.json(startSeason(b.name, b.leagues || []));
  if (b.action === "set_leagues") return Response.json(setSeasonLeaguesFor(b.name, b.leagues || []));
  if (b.action === "set_active") return Response.json(setActiveSeason(b.name));
  if (b.action === "backfill") return Response.json(backfillSeason(b.name));
  return Response.json({ error: "unknown action" });
}
