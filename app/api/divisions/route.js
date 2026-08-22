import { bindRequest } from "@/lib/actor.js";
import {
  setupDivisions, reassignDivisions, getRecordTypes, getDivisions, createDivision,
  seedStandardDivisions, deleteRecord, getFields,
} from "@/lib/tools.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  if (b.action === "setup") return Response.json(setupDivisions());
  if (b.action === "reassign") return Response.json(reassignDivisions());
  if (b.action === "status") return Response.json({ exists: getRecordTypes().some((t) => t.name === "division") });
  if (b.action === "list") {
    const pl = getFields("player").find((f) => f.name === "league");
    let leagues = [];
    try { leagues = pl && pl.options ? JSON.parse(pl.options) : []; } catch {}
    return Response.json({ divisions: getDivisions(), leagues });
  }
  if (b.action === "create") return Response.json(createDivision(b.name, b.league, b.age_min, b.age_max));
  if (b.action === "seed_standard") return Response.json(seedStandardDivisions());
  if (b.action === "del") { const r = deleteRecord(b.id, "user"); reassignDivisions(); return Response.json(r); }
  return Response.json({ error: "unknown action" });
}
