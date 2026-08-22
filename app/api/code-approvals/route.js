// Code-change approval endpoint.
//   GET  /api/code-approvals           -> list pending
//   POST /api/code-approvals           -> { action: "approve"|"reject", id }
import { approveCodeChange, rejectCodeChange, runCodeTool } from "@/lib/code-tools.js";
import { bindRequest } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  bindRequest(req);
  const list = await runCodeTool("code_list_pending", {});
  return Response.json({ pending: list });
}

export async function POST(req) {
  bindRequest(req);
  const b = await req.json();
  if (!b?.id) return Response.json({ error: "id required" }, { status: 400 });
  try {
    if (b.action === "approve") return Response.json(await approveCodeChange(b.id));
    if (b.action === "reject") return Response.json(await rejectCodeChange(b.id));
    return Response.json({ error: "action must be approve|reject" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message || String(e) }, { status: 500 });
  }
}
