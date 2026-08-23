import { getFields, getRecords, getRecordsForSeason, getRecordsAll, applyCreateRecord, validateRecord, identityKey, findAmbiguousMatches, slug, writeMasterRow, coerceSelectValue, isKnownDivision } from "@/lib/tools.js";
import { setScope, assertWritable } from "@/lib/season-scope.js";
import { updateRecord, assignDivision } from "@/lib/tools.js";
import { getRow } from "@/lib/db.js";
import { bindRequest } from "@/lib/actor.js";
import { coerceDate, isDateColumn } from "@/lib/import-helpers.js";

export const dynamic = "force-dynamic";

const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const hasVal = (v) => v != null && String(v).trim() !== "";

// Fields the APP owns. A registration export knows a kid's phone number; it
// does not know which team you put them on, whether their jersey was handed
// over, or what a staff member wrote in the notes. A re-upload must never
// reach into these — that's how a re-import quietly undoes a Saturday's work.
const APP_OWNED = new Set([
  "team", "division", "division_source", "division_override", "season",
  "jersey_issued", "size_confirmed_at", "size_confirmed_by",
  "press_override", "press_override_reason", "press_override_by", "press_override_at",
  "key_tag", "notes", "link_group", "link_reason",
  "end_season_rank", "rank_season", "rank_history", "all_star",
]);

// What changed between what's on file and what the new sheet says.
//
// Only fields the sheet actually carried a value for. A column that isn't in
// this export, or a cell left blank, means "no news" — never "delete what you
// had". Clearing a value stays a deliberate edit someone makes by hand.
function changedFields(existing, incoming) {
  const patch = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (APP_OWNED.has(k)) continue;
    if (!hasVal(v)) continue;
    const before = existing[k];
    if (String(before == null ? "" : before).trim() === String(v).trim()) continue;
    patch[k] = v;
  }
  return patch;
}
const divisionOk = (v) => { try { return isKnownDivision(v); } catch { return true; } };

// Body: {
//   type, rows: [{col: val}], mapping: {fieldName: csvCol}, source: "Limerick"|null,
//   allowAmbiguous?: [rowIndex, ...]   // user reviewed these and chose "Add as new"
// }
export async function POST(req) {
  bindRequest(req); // stamp every audit row with the signed-in user
  const b = await req.json();
  const rtype = slug(b.type);
  const fields = getFields(rtype);
  const mapping = b.mapping || {};
  const source = b.source || null;
  const season = b.season || null; // which season this upload belongs to
  // The upload's own season picker wins over the sidebar for the whole request:
  // every read below (dedup, ambiguity) and every write lands in that season.
  if (season) {
    const blocked = assertWritable(season);
    if (blocked) return Response.json({ error: blocked }, { status: 400 });
    setScope(season);
  }
  const sourceFile = b.sourceFile || b.filename || null;
  const rows = b.rows || [];
  const allowAmbiguous = new Set((b.allowAmbiguous || []).map((n) => Number(n)));
  // { rowIndex: existingPlayerId } — the user looked at an ambiguous row and
  // said "that's the same person". A changed phone number is exactly this
  // case: the strict identity no longer matches, so it can't be resolved
  // automatically, but it's obviously the same kid to whoever is looking.
  const updateInto = {};
  for (const [k, v] of Object.entries(b.updateInto || {})) {
    const rowIdx = Number(k), pid = Number(v);
    if (rowIdx && pid) updateInto[rowIdx] = pid;
  }

  // Index existing strict identity keys → record (for the "recognized" list).
  // Season scoping: when this import targets a season, records that carry a
  // DIFFERENT season are not duplicates — a returning player must be able to
  // register again next season. Records with no season tag still match any
  // season (safer until they're backfilled).
  // STRICT: only records in the TARGET season count as duplicates — a returning
  // player must be able to register again next season. This is now enforced by
  // the season column rather than re-checked per row, so it can't drift.
  const existingByKey = new Map();
  const otherSeasonIds = new Set();
  const inTarget = season ? getRecordsForSeason(rtype, season) : getRecords(rtype);
  for (const r of inTarget) {
    const k = identityKey(parse(r.data));
    if (k) existingByKey.set(k, { id: r.id, name: r.name });
  }
  if (season && rtype === "player") {
    const targetIds = new Set(inTarget.map((r) => r.id));
    for (const r of getRecordsAll(rtype)) if (!targetIds.has(r.id)) otherSeasonIds.add(r.id);
  }
  const seenKeys = new Set(existingByKey.keys());

  // Default ON: a re-upload of the same roster is almost always a refresh.
  // Pass refresh:false to import as strictly additive.
  const refresh = b.refresh !== false;
  let added = 0;
  let updated = 0;
  const addedNames = [];
  const updatedNames = [];
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
        // Dates first: a date column holding 42464 is 2016-04-04, not the
        // number forty-two thousand. Checked before `number` so a date mapped
        // onto a numeric field can't be stored as a serial.
        if (f.data_type === "date" || isDateColumn(col) || isDateColumn(f.name)) {
          const c = coerceDate(v);
          if (c.value != null) v = c.value;
          else {
            if (c.unmatched) unmatched.push({ rowIndex: n + 1, name: row[mapping.full_name || "Full Name"] || `row ${n + 1}`, field: f.label || f.name, value: c.unmatched, why: "not a date we recognise" });
            continue;
          }
        } else if (f.data_type === "number") {
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
    if (season) data.season = season;
    // Remember what the sheet called the division so we can report it if the
    // brackets end up ignoring it (applyCreateRecord drops unknown values).
    const incomingDivision = hasVal(data.division) ? String(data.division).trim() : null;

    const displayName = data.full_name || data.name || `(row ${n + 1})`;
    const key = identityKey(data);

    // Refresh one existing record from this row. Shared by the exact-match
    // path below and the "same person" answer to an ambiguous row.
    function refreshInto(pid) {
      const row0 = getRow("records", pid);
      const before = row0 ? parse(row0.data) : null;
      if (!before) return { error: `no record #${pid}` };
      const patch = changedFields(before, data);
      if (hasVal(patch.age)) {
        const dv = assignDivision({ ...before, ...patch });
        if (dv && dv !== (before.division || "")) patch.division = dv;
      }
      if (!Object.keys(patch).length) return { changes: [] };
      const res = updateRecord(pid, patch, "user(import refresh)", `updated from ${sourceFile || "a re-upload"}`);
      if (res && res.error) return { error: res.error };
      return {
        changes: Object.keys(patch).map((k) => ({
          field: k,
          from: before[k] == null || before[k] === "" ? null : String(before[k]),
          to: String(patch[k]),
        })),
      };
    }

    // 0) The user told us who this is. Refresh them and move on.
    if (updateInto[n + 1]) {
      const pid = updateInto[n + 1];
      const r = refreshInto(pid);
      if (r.error) { skipped.push(`Row ${n + 1} (${displayName}): ${r.error}`); return; }
      if (r.changes.length) {
        updated++;
        updatedNames.push({ id: pid, name: displayName, rowIndex: n + 1, changes: r.changes });
      }
      recognizedNames.push({ id: pid, name: displayName, rowIndex: n + 1, updated: r.changes.length, changes: r.changes, merged: true });
      try { writeMasterRow({ record_type: rtype, source_file: sourceFile, source_district: source, source_league: data.league || null, season, identity_key: key, status: r.changes.length ? "updated" : "recognized", player_id: pid, raw_data: row }); } catch {}
      return;
    }

    // 1) Exact identity match → already in the system. Don't re-create.
    if (key && seenKeys.has(key)) {
      const hit = existingByKey.get(key) || {};
      // Already here — but the sheet may be newer than the record. A phone
      // number changes, a jersey size gets filled in, an age ticks over. Update
      // what the sheet actually says and leave everything else alone.
      let changed = null;
      if (refresh && hit.id) {
        const r = refreshInto(hit.id);
        if (r.error) skipped.push(`Row ${n + 1} (${displayName}): ${r.error}`);
        else if (r.changes.length) {
          updated++;
          changed = r.changes;
          updatedNames.push({ id: hit.id, name: displayName, rowIndex: n + 1, changes: changed });
        }
      }
      recognizedNames.push({ id: hit.id || null, name: displayName, rowIndex: n + 1, updated: changed ? changed.length : 0, changes: changed || [] });
      try { writeMasterRow({ record_type: rtype, source_file: sourceFile, source_district: source, source_league: data.league || null, season, identity_key: key, status: changed ? "updated" : "recognized", player_id: hit.id || null, raw_data: row }); } catch {}
      return;
    }

    // 2) Soft / ambiguous match (FR-1.3, OQ-1): same first+last, corroborating phone or age.
    //    Never silently merge. Surface for review unless the user already cleared this row.
    if (!allowAmbiguous.has(n + 1)) {
      // Season scoping: a look-alike from a different season isn't ambiguous —
      // it's the same kid registering again. Only same-season (or untagged)
      // records count as possible duplicates.
      const candidates = findAmbiguousMatches(rtype, data)
        .filter((c) => !otherSeasonIds.has(c.id));
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
    if (incomingDivision && !divisionOk(incomingDivision)) {
      unmatched.push({ rowIndex: n + 1, name: displayName, field: "Division", value: incomingDivision, why: "not a division in this season — sorted by age bracket instead" });
    }
    // Where they landed, so the import report can show the split. "Imported 42"
    // with 35 visible under one league is not a bug, but it looks like one
    // until something says the other 7 went to Unassigned.
    addedNames.push({ id: res?.id || null, name: displayName, rowIndex: n + 1, league: data.league || "", division: data.division || "", team: data.team || "" });
    if (key) { seenKeys.add(key); existingByKey.set(key, { id: res?.id || null, name: displayName }); }
    try {
      const wasAmbiguousOverride = allowAmbiguous.has(n + 1);
      writeMasterRow({
        record_type: rtype,
        source_file: sourceFile,
        source_district: source,
        source_league: data.league || null,
        season,
        identity_key: key,
        status: wasAmbiguousOverride ? "ambiguous_added" : "added",
        player_id: res?.id || null,
        raw_data: row,
      });
    } catch {}
  });

  return Response.json({
    season,
    added,
    addedNames,
    duplicates: recognizedNames.length, // back-compat for older clients
    recognized: recognizedNames.length,
    recognizedNames,
    updated,          // people already here whose details the sheet changed
    updatedNames,     // …and exactly what changed on each
    refresh,
    ambiguous,
    skipped,
    unmatched, // free-text select values we couldn't auto-coerce; field was left blank
  });
}
