import { bindRequest } from "@/lib/actor.js";
// Long-term memory inspection.
//   GET  /api/memory               -> list recent facts
//   POST /api/memory  {key, value, scope} -> remember
//   POST /api/memory  {forget: id} -> forget one
//   POST /api/memory  {clearScope: scope} -> clear a scope
import { listFacts, remember, forget, clearScope } from "@/lib/memory.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ facts: listFacts(100) });
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  if (b.forget) return Response.json(forget(Number(b.forget)));
  if (b.clearScope) return Response.json(clearScope(String(b.clearScope)));
  if (b.key && b.value) return Response.json(remember(b.key, b.value, b.scope || "league"));
  return Response.json({ error: "specify {key,value} or {forget:id} or {clearScope}" }, { status: 400 });
}
