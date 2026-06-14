import { chat } from "@/lib/llm.js";

export const dynamic = "force-dynamic";

const MAX_CELL = 100;
const MAX_ROWS = 8;
const PROMPT_CHAR_CAP = 3500;

function truncCell(v) {
  if (v == null) return "";
  const s = String(v);
  return s.length > MAX_CELL ? s.slice(0, MAX_CELL) + "…" : s;
}

function extractJsonBlock(text) {
  if (!text) return null;
  // Try a direct parse first
  try { return JSON.parse(text); } catch {}
  // Otherwise try to find the first {...} block
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// POST { rows, filename, columns, knownDistricts, fields }
//   fields: [{ name, label, type }]   target schema we're mapping into
// Returns: { district, league, reason, newDistrictSuggestion, headerMap }
export async function POST(req) {
  let body = {};
  try { body = await req.json(); } catch { body = {}; }

  const filename = body.filename || "";
  const columns = Array.isArray(body.columns) ? body.columns : [];
  const knownDistricts = Array.isArray(body.knownDistricts) ? body.knownDistricts : [];
  const rowsIn = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : [];
  const fields = Array.isArray(body.fields) ? body.fields : [];

  const sampleRows = rowsIn.map((r) => {
    if (!r || typeof r !== "object") return {};
    const out = {};
    for (const col of columns.length ? columns : Object.keys(r)) {
      out[col] = truncCell(r[col]);
    }
    return out;
  });

  const fieldList = fields.map((f) => `${f.name} (${f.type || "text"})${f.label ? ` "${f.label}"` : ""}`).join(", ");

  const system = `You identify which youth-sports district a roster spreadsheet belongs to AND propose a header→field mapping for it.

Return STRICT JSON only — no prose, no markdown, no code fences:
{
  "district": "<one of knownDistricts, or null>",
  "league": "<league name or null>",
  "reason": "<one sentence>",
  "newDistrictSuggestion": "<name or null>",
  "headerMap": { "<known_field_name>": "<exact incoming column header, or null>" }
}

Rules for headerMap:
- Keys MUST be names from the provided field list (case-sensitive).
- Values MUST be exact column names from the provided columns (case-sensitive, exact whitespace).
- If a field has no matching column, set its value to null OR omit it.
- Do not invent columns. Do not invent field names.
- If first/last name are in separate columns and there's no full_name column, omit full_name (the client will synthesize it).`;

  let userMsg =
    `Filename: ${filename}\n` +
    `Known districts: ${knownDistricts.join(", ") || "(none)"}\n` +
    `Target fields: ${fieldList || "(none)"}\n` +
    `Columns: ${columns.map((c) => `"${c}"`).join(", ")}\n` +
    `Sample rows (first ${sampleRows.length}):\n` +
    JSON.stringify(sampleRows, null, 2);

  if (userMsg.length > PROMPT_CHAR_CAP) {
    userMsg = userMsg.slice(0, PROMPT_CHAR_CAP) + "\n…(truncated)";
  }

  let resp;
  try {
    resp = await chat({
      mode: "fast",
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
    });
  } catch (e) {
    return Response.json({
      district: null,
      league: null,
      reason: "AI call failed",
      newDistrictSuggestion: null,
      headerMap: {},
      error: e?.message || String(e),
    });
  }

  const content = resp?.message?.content || "";
  const parsed = extractJsonBlock(content) || {};
  return Response.json({
    district: parsed.district || null,
    league: parsed.league || null,
    reason: parsed.reason || "",
    newDistrictSuggestion: parsed.newDistrictSuggestion || null,
    headerMap: (parsed.headerMap && typeof parsed.headerMap === "object") ? parsed.headerMap : {},
  });
}
