import { undoPlan } from "@/lib/agent.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const b = await req.json();
  return Response.json({ message: undoPlan(b.token) });
}
