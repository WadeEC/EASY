import { bindRequest } from "@/lib/actor.js";
import { promises as fs } from "fs";
import path from "path";
import { detectDistrict } from "@/lib/import-detect.js";
import { setScope, setScopeFromReq, seasonForWrite } from "@/lib/season-scope.js";
import { seasonLeagueList } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

const EMPTY = {
  district: null,
  confidence: 0,
  evidence: [],
  alternates: [],
  suggestedLeague: null,
  suggestedLeagueAlternates: [],
};

// Only suggest leagues that belong to the season being uploaded into. The
// township → league list in markers.json doesn't know about seasons, so
// "Limerick" would otherwise suggest Saturday Limerick in the Winter season.
function seasonLeagueFilter(req, bodySeason) {
  try {
    if (bodySeason) setScope(bodySeason); else setScopeFromReq(req);
    const allowed = seasonLeagueList(seasonForWrite());
    return allowed;
  } catch { return null; }
}
function keepSeasonLeagues(list, allowed) {
  if (!allowed) return list;
  const lc = new Map(allowed.map((l) => [String(l).toLowerCase(), l]));
  return (list || []).map((l) => lc.get(String(l).toLowerCase())).filter(Boolean);
}

// POST { rows, filename } -> detection result
export async function POST(req) {
  bindRequest(req);
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const filename = body.filename || "";

  const markersPath = path.join(process.cwd(), "_imports", "markers.json");
  let markers = null;
  try {
    const raw = await fs.readFile(markersPath, "utf8");
    markers = JSON.parse(raw);
  } catch {
    return Response.json(EMPTY);
  }

  try {
    const result = detectDistrict({ rows, filename, markers });
    const allowed = seasonLeagueFilter(req, body.season);
    if (allowed) {
      const fromDistrict = [result.suggestedLeague, ...(result.suggestedLeagueAlternates || [])].filter(Boolean);
      const kept = [...new Set(keepSeasonLeagues(fromDistrict, allowed))];
      if (kept.length === 1) { result.suggestedLeague = kept[0]; result.suggestedLeagueAlternates = kept; }
      else if (kept.length > 1) { result.suggestedLeague = null; result.suggestedLeagueAlternates = kept; }
      else if (allowed.length === 1) { result.suggestedLeague = allowed[0]; result.suggestedLeagueAlternates = allowed; }
      else { result.suggestedLeague = null; result.suggestedLeagueAlternates = allowed.slice(); }
    }
    return Response.json(result);
  } catch (e) {
    return Response.json({ ...EMPTY, error: String(e && e.message || e) });
  }
}
