import { applyPlan } from "@/lib/agent.js";
import { setActorFromReq } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  setActorFromReq(req);
  const b = await req.json();
  return Response.json(applyPlan(b.plan || []));
}
