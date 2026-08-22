import { listAudit, undo, restoreToPoint } from "@/lib/db.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ entries: listAudit(200) });
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  if (b.restoreTo != null) return Response.json(restoreToPoint(b.restoreTo));
  return Response.json(undo(b.id));
}
