import { getFields, getRecords, applyCreateRecord, validateRecord, identityKey, findAmbiguousMatches, slug, writeMasterRow, coerceSelectValue } from "@/lib/tools.js";
import { setActorFromReq } from "@/lib/actor.js";

export const dynamic = "force-dynamic";

const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

// Body: {
//   type, rows: [{col: val}], mapping: {fieldName: csvCol}, source: "Limerick"|null,
//   allowAmbiguous?: [rowIndex, ...]   // user reviewed these and chose "Add as new"
// }
export async function POST(req) {
  setActorFromReq(req); // stamp every audit row with the signed-in user
  const b = await req.json();
  const rtype = slug(b.type);
  const fields = getFields(rtype);
  const mapping = b.mapping || {};
  const source = b.source || null;
  const sourceFile = b.sourceFile || b.filename || null;
  const rows = b.rows || [];
  const allowAmbiguous = new Set((b.allowAmbiguous || []).map((n) => Number(n)));

  // Index existing strict identity keys → record (for the "recognized" list)
  const existingByKey = new Map();
  for (const r of getRecords(rtype)) {
    const k = identityKey(parse(r.data));
    if (k) existingByKey.set(k, { id: r.id, name: r.name });
  }
  const seenKeys = new Set(existingByKey.keys());

  let added = 0;
  const addedNames = [];
  const recognizedNames = [];
  const ambiguous = [];
  const skipped = [];

  // Cache parsed select-option lists so we don't JSON.parse per row.
  const selectOpts = new Map();
  for (const f of fields) {
    if (f.data_type === "select" && f.options) {
      try { selectOpts.set(f.name, JSON.parse(f.options)); } catch {}
    }
  }
  // Surface unmatched select values once per row instead of failing the row.
  const unmatched = []; // { rowIndex, name, field, value }

  rows.forEach((row, n) => {
    const data = {};
    for (const f of fields) {
      const col = mapping[f.name];
      if (col && col !== "(skip)" && row[col] != null && row[col] !== "") {
        let v = row[col];
        if (f.data_type === "number") {
          const num = parseFloat(v);
          if (!Number.isNaN(num)) v = num;
        } else if (f.data_type === "select" && selectOpts.has(f.name)) {
          // Try to coerce free-text ("Adult Medium", "Youth S", "10/12") into one of
          // the configured options. Blank stays blank; unmatched stays blank but is
          // reported back so the user sees what we couldn't parse.
          const c = coerceSelectValue(v, selectOpts.get(f.name));
          if (c.value != null) v = c.value;
          else {
            if (c.unmatched) unmatched.push({ rowIndex: n + 1, name: row[mapping.full_name || "Full Name"] || `row ${n + 1}`, field: f.label || f.name, value: c.unmatched });
            continue; // leave field blank rather than failing the row
          }
        }
        data[f.name] = v;
      }
    }
    if (source) data.township = source;

    const displayName = data.full_name || data.name || `(row ${n + 1})`;
    const key = identityKey(data);

    // 1) Exact identity match → already in the system. Don't re-create.
    if (key && seenKeys.has(key)) {
      const hit = existingByKey.get(key) || {};
      recognizedNames.push({ id: hit.id || null, name: displayName, rowIndex: n + 1 });
      try { writeMasterRow({ record_type: rtype, source_file: sourceFile, source_district: source, source_league: data.league || null, identity_key: key, status: "recognized", player_id: hit.id || null, raw_data: row }); } catch {}
      return;
    }

    // 2) Soft / ambiguous match (FR-1.3, OQ-1): same first+last, corroborating phone or age.
    //    Never silently merge. Surface for review unless the user already cleared this row.
    if (!allowAmbiguous.has(n + 1)) {
      const candidates = findAmbiguousMatches(rtype, data);
      if (candidates.length) {
        ambiguous.push({
          rowIndex: n + 1,
          incoming: {
            name: displayName,
            age: data.age ?? null,
            phone_last4: String(data.parent_phone || data.phone || "").replace(/\D+/g, "").slice(-4) || null,
            township: data.township || null,
            league: data.league || null,
          },
          candidates,
        });
        return;
      }
    }

    // 3) Validate + create.
    const probs = validateRecord(rtype, data);
    if (probs.length) { skipped.push(`Row ${n + 1} (${displayName}): ${probs.join(", ")}`); return; }
    const res = applyCreateRecord(rtype, displayName, data, "user(import)");
    if (res && res.error) { skipped.push(`Row ${n + 1} (${displayName}): ${res.error}`); return; }
    added++;
    addedNames.push({ id: res?.id || null, name: displayName, rowIndex: n + 1 });
    if (key) { seenKeys.add(key); existingByKey.set(key, { id: res?.id || null, name: displayName }); }
    try {
      const wasAmbiguousOverride = allowAmbiguous.has(n + 1);
      writeMasterRow({
        record_type: rtype,
        source_file: sourceFile,
        source_district: source,
        source_league: data.league || null,
        identity_key: key,
        status: wasAmbiguousOverride ? "ambiguous_added" : "added",
        player_id: res?.id || null,
        raw_data: row,
      });
    } catch {}
  });

  return Response.json({
    added,
    addedNames,
    duplicates: recognizedNames.length, // back-compat for older clients
    recognized: recognizedNames.length,
    recognizedNames,
    ambiguous,
    skipped,
    unmatched, // free-text select values we couldn't auto-coerce; field was left blank
  });
}
