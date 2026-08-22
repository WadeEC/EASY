import { bindRequest } from "@/lib/actor.js";
import { listRules, setRuleActive, deleteRule } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ rules: listRules() });
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  if (b.action === "toggle") return Response.json(setRuleActive(b.id, b.active));
  if (b.action === "delete") return Response.json(deleteRule(b.id));
  return Response.json({ error: "unknown action" });
}
