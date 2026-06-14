import { getRecords, applyCreateRecord, updateRecord, deleteRecord, slug } from "@/lib/tools.js";
import { setActorFromReq } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const type = new URL(req.url).searchParams.get("type");
  return Response.json({ records: type ? getRecords(type) : [] });
}

export async function POST(req) {
  setActorFromReq(req);
  const b = await req.json();
  const name = b.name || b.fields?.full_name || b.fields?.name || null;
  return Response.json(applyCreateRecord(slug(b.type), name, b.fields || {}, "user"));
}

export async function PATCH(req) {
  setActorFromReq(req);
  const b = await req.json();
  return Response.json(updateRecord(b.id, b.fields || {}));
}

export async function DELETE(req) {
  setActorFromReq(req);
  const b = await req.json();
  return Response.json(deleteRecord(b.id));
}
