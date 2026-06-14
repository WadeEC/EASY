import { runAgent } from "@/lib/agent.js";
import { setActorFromReq } from "@/lib/actor.js";
import { guard } from "@/lib/guard.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const g = guard(req);
  if (!g.ok) return g.response;
  setActorFromReq(req);
  const b = await req.json();
  // Accept new-shape { messages, pageContext } and legacy bare messages array.
  try {
    const result = await runAgent({
      messages: b.messages || [],
      pageContext: b.pageContext || null,
    });
    return Response.json(result);
  } catch (e) {
    console.error("[api/agent]", e);
    return Response.json({ error: String(e?.message || e), reply: "Sorry — the assistant hit an error. Try again in a moment." }, { status: 500 });
  }
}
