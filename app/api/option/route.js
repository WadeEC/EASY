import { addFieldOption } from "@/lib/tools.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  return Response.json(addFieldOption(b.record_type, b.field, b.option));
}
