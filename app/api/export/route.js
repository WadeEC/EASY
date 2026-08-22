// Export a season's leagues as Excel or CSV.
//
//   GET /api/export?season=Fall%202026&league=Saturday%20Limerick&format=xlsx
//   GET /api/export?season=Fall%202026&scope=season&format=zip
//   GET /api/export?season=Fall%202026&league=...&format=csv&sheet=Roster
//   GET /api/export?season=Fall%202026&week=2026-09-13&format=csv     (one week of attendance)
//   GET /api/export?season=Fall%202026&scope=attendance&format=xlsx   (the whole grid)
//   GET /api/export                        → what's exportable (seasons + leagues)
//
// `season` is required for a download and is never inferred silently: if it is
// missing we fall back to the request's scope and SAY SO in the filename, so a
// file on someone's desktop always announces which season it is.
import { bindRequest } from "@/lib/actor.js";
import { exportXlsx, exportCsvZip, exportCsv, leaguesInSeason } from "@/lib/export.js";
import { listSeasons } from "@/lib/seasons.js";
import { currentScope } from "@/lib/season-scope.js";

export const dynamic = "force-dynamic";

function resolve(req, body = {}) {
  const u = new URL(req.url);
  const q = (k) => body[k] ?? u.searchParams.get(k) ?? null;
  const scope = currentScope();
  const season = q("season") || (scope.mode === "one" ? scope.season : null);
  const week = q("week") || null;
  return {
    season,
    league: q("league") || null,
    // Naming a week is on its own enough to mean "the attendance export".
    scope: (q("scope") || (week ? "attendance" : q("league") ? "league" : "season")).toLowerCase(),
    week,
    format: String(q("format") || "xlsx").toLowerCase(),
    sheet: q("sheet") || "Roster",
  };
}

function send(result) {
  if (result.error) return Response.json({ error: result.error }, { status: 400 });
  return new Response(result.body, {
    headers: {
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Content-Length": String(result.body.length),
      "Cache-Control": "no-store",
    },
  });
}

async function handle(req, body = {}) {
  const opts = resolve(req, body);

  // No season asked for and none in scope → tell the caller what they can export.
  if (!opts.season || body.action === "options" || opts.format === "options") {
    const s = listSeasons();
    return Response.json({
      seasons: s.detail.map((d) => ({
        season: d.name, status: d.status, locked: d.locked, players: d.players,
        leagues: leaguesInSeason(d.name),
      })),
      active: s.active,
      formats: ["xlsx", "csv", "zip"],
      note: "Pass ?season= and either ?league= for one league or ?scope=season for the whole season.",
    });
  }

  if (opts.format === "zip" || opts.format === "csvs") return send(exportCsvZip(opts));
  if (opts.format === "csv") return send(exportCsv(opts));
  return send(exportXlsx(opts));
}

export async function GET(req) {
  bindRequest(req);
  return handle(req);
}

export async function POST(req) {
  bindRequest(req);
  let b = {}; try { b = await req.json(); } catch {}
  return handle(req, b);
}
