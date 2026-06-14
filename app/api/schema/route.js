import { listSchema, getFields, addField, ensurePlayerKeyTag, ensurePlayerNotes, ensurePlayerAllStar, seedReferees, seedTournaments } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const type = new URL(req.url).searchParams.get("type");
  if (type) return Response.json({ fields: getFields(type) });
  return Response.json({ schema: listSchema() });
}

export async function POST(req) {
  const b = await req.json();
  if (b.action === "ensure_player_fields") { ensurePlayerKeyTag(); ensurePlayerNotes(); ensurePlayerAllStar(); return Response.json({ status: "ok" }); }
  if (b.action === "ensure_referees") { return Response.json(seedReferees()); }
  if (b.action === "ensure_tournaments") { return Response.json(seedTournaments()); }
  return Response.json(addField(b.record_type, b.name, b.data_type, b.label, b.required, b.options));
}
