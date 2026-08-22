import { bindRequest } from "@/lib/actor.js";
import { undoPlan } from "@/lib/agent.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  return Response.json({ message: undoPlan(b.token) });
}
