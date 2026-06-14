import { listAudit, undo, restoreToPoint } from "@/lib/db.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ entries: listAudit(200) });
}

export async function POST(req) {
  const b = await req.json();
  if (b.restoreTo != null) return Response.json(restoreToPoint(b.restoreTo));
  return Response.json(undo(b.id));
}
