import {
  createFlag, getFlags, evaluateFlags, seedDefaultFlags, deleteRule, setRuleActive,
  getRecordTypes, getFields, FLAG_OPS, ensureJerseyHoldFlag,
} from "@/lib/tools.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const b = await req.json();

  if (b.action === "list") {
    seedDefaultFlags();
    const types = getRecordTypes().filter((t) => t.name !== "division").map((t) => ({
      name: t.name, label: t.label,
      fields: getFields(t.name).map((f) => ({ name: f.name, label: f.label, type: f.data_type })),
    }));
    return Response.json({ flags: evaluateFlags(), types, ops: FLAG_OPS });
  }
  if (b.action === "add") return Response.json(createFlag(b.label, b.record_type, b.field, b.op, b.value));
  if (b.action === "jersey_hold") return Response.json(ensureJerseyHoldFlag());
  if (b.action === "del") return Response.json(deleteRule(b.id));
  if (b.action === "toggle") return Response.json(setRuleActive(b.id, b.active));

  return Response.json({ error: "unknown action" });
}
