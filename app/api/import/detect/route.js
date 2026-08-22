import { bindRequest } from "@/lib/actor.js";
import { promises as fs } from "fs";
import path from "path";
import { detectDistrict } from "@/lib/import-detect.js";

export const dynamic = "force-dynamic";

const EMPTY = {
  district: null,
  confidence: 0,
  evidence: [],
  alternates: [],
  suggestedLeague: null,
  suggestedLeagueAlternates: [],
};

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
    return Response.json(result);
  } catch (e) {
    return Response.json({ ...EMPTY, error: String(e && e.message || e) });
  }
}
