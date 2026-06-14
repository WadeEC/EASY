import { getAssignmentRules, createAssignmentRule, deleteRule, reassignAllRecords } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const type = new URL(req.url).searchParams.get("type") || "player";
  return Response.json({ rules: getAssignmentRules(type) });
}

export async function POST(req) {
  const b = await req.json();
  return Response.json(createAssignmentRule(b.name, b.conditions, b.set_value, b.set_field || "league", b.record_type || "player"));
}

// Re-apply all assignment rules to existing records (e.g., after a rule edit).
export async function PUT(req) {
  const b = await req.json().catch(() => ({}));
  return Response.json(reassignAllRecords(b.record_type || "player"));
}

export async function DELETE(req) {
  const b = await req.json();
  return Response.json(deleteRule(b.id));
}
