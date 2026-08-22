import { getRecordTypes } from "@/lib/tools.js";
import { listAudit } from "@/lib/db.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    types: getRecordTypes().map((t) => ({ name: t.name, label: t.label })),
    recent: listAudit(8),
  });
}
