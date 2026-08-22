import { getPressQueue, pressStatusFor, setPressOverride } from "@/lib/tools.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  if (b.action === "list") return Response.json(getPressQueue(b.league || null));
  if (b.action === "status") return Response.json(pressStatusFor(Number(b.player_id)));
  if (b.action === "set_override") return Response.json(setPressOverride(Number(b.player_id), b.override || "", b.reason || ""));
  return Response.json({ error: "unknown action" });
}
