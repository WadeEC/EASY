import { applyPlan } from "@/lib/agent.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  return Response.json(applyPlan(b.plan || []));
}
