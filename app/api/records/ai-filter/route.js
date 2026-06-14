import { chat } from "@/lib/llm.js";
import { getFields, slug } from "@/lib/tools.js";

export const dynamic = "force-dynamic";

// Translate a natural-language query (e.g., "under 13 in Upper Merion") into a
// predicate that the client can apply against the records list.
//
// Response shape: { predicate: { all: [{field, op, value}] } } or { error }.
//
// We keep the predicate language tight (matchAll/cmp from lib/tools.js):
//   ops: ==, !=, >, >=, <, <=
//   field must be one of the known field names for this record type
//   value is a string or number
export async function POST(req) {
  const b = await req.json().catch(() => ({}));
  const record_type = slug(b.record_type || "player");
  const q = String(b.query || "").trim();
  if (!q) return Response.json({ error: "Empty query." });

  const fields = getFields(record_type).map((f) => ({
    name: f.name,
    label: f.label || f.name,
    type: f.data_type,
    options: (() => { try { return f.options ? JSON.parse(f.options) : null; } catch { return null; } })(),
  }));
  if (!fields.length) return Response.json({ error: `No fields configured for '${record_type}'.` });

  const fieldDesc = fields.map((f) => {
    let s = `- ${f.name} (${f.type})`;
    if (f.options) s += ` — one of: ${f.options.join(", ")}`;
    return s;
  }).join("\n");

  const sys = [
    "You translate a user's natural-language filter into a JSON predicate against a list of records.",
    "",
    "Output STRICT JSON with this exact shape — no prose, no markdown fences:",
    `{ "all": [ { "field": "<field name>", "op": "<one of ==,!=,>,>=,<,<=>", "value": "<string or number>" } ] }`,
    "",
    "Rules:",
    "- Use only field names from the list below.",
    "- All conditions in `all` are AND-ed.",
    "- For 'is X', 'are X', 'in X', use ==. For 'not X', use !=.",
    "- Numeric comparisons use >, >=, <, <=.",
    "- 'under 13' → age < 13.  '13 or older' → age >= 13.  'no jersey size' → jersey_size == \"\".",
    "- If the user mentions an option that doesn't match exactly, pick the closest configured option.",
    "- If you can't translate the request, respond with: { \"all\": [] }",
    "",
    "Fields available for record type '" + record_type + "':",
    fieldDesc,
  ].join("\n");

  let predicate = null;
  let raw = "";
  try {
    const res = await chat({
      mode: "fast",
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: q },
      ],
    });
    raw = String(res?.message?.content ?? "").trim();
    // Strip code fences if a provider wrapped the JSON.
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    predicate = JSON.parse(raw);
  } catch (e) {
    return Response.json({ error: "Couldn't parse AI response.", raw });
  }
  if (!predicate || !Array.isArray(predicate.all)) {
    return Response.json({ error: "AI returned an unexpected shape.", raw });
  }
  // Validate every condition references a known field + supported op.
  const okOps = new Set(["==", "!=", ">", ">=", "<", "<="]);
  const knownFields = new Set(fields.map((f) => f.name));
  predicate.all = predicate.all.filter((c) => c && knownFields.has(c.field) && okOps.has(c.op || "==") && c.value != null);
  return Response.json({ predicate });
}
