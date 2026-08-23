// The backend toolbox — the same functions the AI calls and the UI uses.
// No arbitrary writes: every change is a named function that logs to the audit trail.
import { getDb, getRow, logAudit, now, SEASON_OWNED_TYPES } from "./db.js";
import { getActor } from "./actor.js";
import { buildSchedule, weekDate, clockTime, placeOnFields } from "./schedule.js";
import { HEADER_ALIASES, normHeader, splitName, namesFromRow } from "./import-helpers.js";
import { getSetting, setSetting } from "./memory.js";
import {
  currentScope, seasonSql, seasonSqlFor, seasonForWrite, assertWritable,
  ALL_SEASONS, NO_SEASON,
} from "./season-scope.js";

export const VALID_TYPES = ["text", "number", "date", "bool", "select"];

export const slug = (s) =>
  s == null ? null : String(s).trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");

// ---------------------------------------------------------------- construction
export function defineRecordType(name, label = null, description = "") {
  name = slug(name);
  if (!name) return { error: "name is required" };
  const d = getDb();
  if (d.prepare("SELECT 1 FROM record_types WHERE name=?").get(name))
    return { status: "exists", record_type: name };
  label = label || titleCase(name);
  const info = d.prepare(
    "INSERT INTO record_types(name,label,description,added_by,created_at) VALUES(?,?,?,?,?)"
  ).run(name, label, description, "ai", now());
  logAudit("ai", "create", "record_types", info.lastInsertRowid, null, { name, label }, "defined section");
  return { status: "created", record_type: name, label };
}

// Find an existing field that semantically matches `proposedName` / `proposedLabel`.
// Returns the existing field row, or null. Used by addField to avoid creating a
// duplicate when an alias of an existing field is requested — e.g. an AI tool
// call that asks for "scan_number" / "Scan Number" should match the existing
// key_tag field (whose label is "Scan number / key tag") and reuse it.
function findExistingField(record_type, proposedName, proposedLabel) {
  const rows = getDb().prepare("SELECT * FROM fields WHERE record_type=?").all(record_type);
  if (!rows.length) return null;
  const targetName = slug(proposedName) || "";
  const targetLabel = normHeader(proposedLabel || proposedName || "");
  if (!targetName && !targetLabel) return null;
  // 1) Exact slug match (rare here — addField's earlier slug check covers it)
  for (const r of rows) if (r.name === targetName) return r;
  // 2) Normalised-label exact match
  for (const r of rows) {
    if (normHeader(r.label || r.name) === targetLabel) return r;
  }
  // 3) HEADER_ALIASES: does the proposed name/label appear in the alias list of
  //    an existing field?
  for (const r of rows) {
    const aliases = HEADER_ALIASES[r.name] || [];
    const normAliases = aliases.map(normHeader);
    if (normAliases.includes(targetLabel) || normAliases.includes(normHeader(targetName))) return r;
  }
  // 4) Reverse: does the proposed name have an alias entry, and does that point
  //    to an existing field by name?
  const aliasKey = Object.keys(HEADER_ALIASES).find((k) => HEADER_ALIASES[k].some((a) => normHeader(a) === targetLabel));
  if (aliasKey) {
    const hit = rows.find((r) => r.name === aliasKey);
    if (hit) return hit;
  }
  return null;
}

export function addField(record_type, name, data_type, label = null, required = false, options = null) {
  record_type = slug(record_type); name = slug(name);
  if (!VALID_TYPES.includes(data_type)) return { error: `data_type must be one of ${VALID_TYPES.join(", ")}` };
  const d = getDb();
  if (!d.prepare("SELECT 1 FROM record_types WHERE name=?").get(record_type))
    return { error: `unknown section '${record_type}'. Define it first.` };
  // Exact-name dedup (legacy fast path).
  const exact = d.prepare("SELECT * FROM fields WHERE record_type=? AND name=?").get(record_type, name);
  if (exact) return { status: "exists", record_type, field: exact.name, label: exact.label, reused: "exact_name" };
  // Alias / label dedup — prevents the AI from creating "scan_number" alongside
  // an existing key_tag (label "Scan number / key tag"), which was the cause of
  // duplicate columns showing up in the players list.
  const alias = findExistingField(record_type, name, label);
  if (alias) return { status: "exists", record_type, field: alias.name, label: alias.label, reused: "alias_match" };
  const nxt = d.prepare("SELECT COALESCE(MAX(sort),0)+1 n FROM fields WHERE record_type=?").get(record_type).n;
  const info = d.prepare(
    `INSERT INTO fields(record_type,name,label,data_type,options,required,sort,added_by,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(record_type, name, label || titleCase(name), data_type,
    options ? JSON.stringify(options) : null, required ? 1 : 0, nxt, "ai", now());
  logAudit("ai", "create", "fields", info.lastInsertRowid, null, { record_type, name }, "added field");
  return { status: "created", record_type, field: name, data_type };
}

export function createRule(name, condition, action, kind = "reactive", record_type = null, hard = false) {
  const cond = typeof condition === "string" ? condition : JSON.stringify(condition);
  const act = typeof action === "string" ? action : JSON.stringify(action);
  const info = getDb().prepare(
    `INSERT INTO rules(name,kind,record_type,hard,condition,action,active,added_by,created_at)
     VALUES(?,?,?,?,?,?,1,?,?)`
  ).run(name, kind, record_type ? slug(record_type) : null, hard ? 1 : 0, cond, act, "ai", now());
  logAudit("ai", "create", "rules", info.lastInsertRowid, null, { name }, "created rule");
  return { status: "created", rule: name, id: info.lastInsertRowid };
}

export function createRecord(type, fields = {}, name = null) {
  const rtype = slug(type);
  const data = { ...(fields || {}) };
  const rname = name || data.name || data.full_name || null;
  if (!getDb().prepare("SELECT 1 FROM record_types WHERE name=?").get(rtype))
    return { error: `unknown section '${rtype}'` };
  return applyCreateRecord(rtype, rname, data, "user");
}

export function applyCreateRecord(rtype, rname, data, actor) {
  // auto-route based on assignment rules (e.g. age >= 13 -> Saturday Limerick).
  // Rules win over null / undefined / blank field values — picking "(skip)" in the
  // import form leaves the field as null, so the rule should fill it. Rules do NOT
  // override a non-blank value already on the record (CSV column won, or user typed).
  const assigns = evaluateAssignment(rtype, data);
  for (const [k, v] of Object.entries(assigns)) if (!hasValue(data[k])) data[k] = v;
  // "Upper Merion" means Sunday Upper Merion. Resolve it rather than inventing
  // a league — an invented one is invisible everywhere and strands the player.
  if (rtype === "player" && hasValue(data.league)) {
    const r = resolveLeague(data.league);
    if (r.error) return { error: r.error, status: r.status, candidates: r.candidates, field: "league" };
    data.league = r.value;
  }
  // Sort into a division by league + age (FR-2.1).
  //
  // A division is one of the brackets you defined — "Ages 9-10" — and nothing
  // else. Uploads arrive with columns called Group / Age Group / Grade holding
  // a bare age, and until now whatever was in them was written straight into
  // `division` and won, because this only auto-assigned when the field was
  // empty. That's how the Players page ended up with a group header reading
  // "10 · 32": it was grouping by the literal string "10".
  //
  // So an incoming division that isn't a real division for this season is
  // dropped, and the age brackets decide.
  if (rtype === "player") {
    if (hasValue(data.division) && !isKnownDivision(data.division)) {
      data.division_source = String(data.division).trim();   // keep what came in
      delete data.division;
    }
    const dv = assignDivision(data);
    if (dv && !hasValue(data.division)) data.division = dv;
  }
  // Every new player belongs to the current season unless one was given
  // explicitly (the import screen's season picker passes it). Keeps manually
  // added and AI-created players from floating across seasons untagged.
  // SEASON STAMPING. Every season-owned record is born into exactly one season:
  // the one the request is scoped to (the sidebar picker / the import screen's
  // season), falling back to the active season. The value goes in BOTH the
  // `season` column (source of truth, indexed) and the JSON blob (what the
  // existing UI reads), so the two can never disagree.
  let season = null;
  if (isSeasonOwned(rtype)) {
    season = hasValue(data.season) ? String(data.season).trim() : seasonForWrite();
    if (season) data.season = season;
    else delete data.season;
    const blocked = assertWritable(season);
    if (blocked) return { error: blocked };
  }
  const d = getDb();
  const info = d.prepare("INSERT INTO records(type,name,data,season,created_at) VALUES(?,?,?,?,?)")
    .run(rtype, rname, JSON.stringify(data), season || null, now());
  const row = getRow("records", info.lastInsertRowid);
  logAudit(actor, "create", "records", info.lastInsertRowid, null, row, "created record");
  return { status: "created", id: Number(info.lastInsertRowid), type: rtype, name: rname, season: season || null };
}

export function updateRecord(id, fields = {}, actor = "user", reason = "updated record") {
  const before = getRow("records", id);
  if (!before) return { error: `no record #${id}` };
  const owned = isSeasonOwned(before.type);
  if (owned) {
    const blocked = assertWritable(before.season);
    if (blocked) return { error: blocked };
  }
  const merged = { ...JSON.parse(before.data || "{}"), ...fields };
  // The season column stays the source of truth. A caller may deliberately
  // re-season a record (S-Dot's migrate tool does), but it has to say so by
  // passing `season` — it can never drift by accident.
  let season = before.season;
  if (owned) {
    if (Object.prototype.hasOwnProperty.call(fields, "season")) {
      season = hasValue(fields.season) ? String(fields.season).trim() : null;
      const blocked = assertWritable(season);
      if (blocked) return { error: blocked };
    }
    if (season) merged.season = season; else delete merged.season;
  }
  getDb().prepare("UPDATE records SET data=?, season=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(merged), owned ? (season || null) : before.season, now(), id);
  logAudit(actor, "update", "records", id, before, getRow("records", id), reason);
  return { status: "updated", id };
}

export function deleteRecord(id, actor = "user") {
  const before = getRow("records", id);
  if (!before) return { error: `no record #${id}` };
  if (isSeasonOwned(before.type)) {
    const blocked = assertWritable(before.season);
    if (blocked) return { error: blocked };
  }
  getDb().prepare("DELETE FROM records WHERE id=?").run(id);
  logAudit(actor, "delete", "records", id, before, null, "deleted record");
  return { status: "deleted", id };
}

export function queryData(sql) {
  if (!String(sql).trim().toLowerCase().startsWith("select")) return { error: "Only SELECT is allowed." };
  try {
    return { rows: getDb().prepare(sql).all(), };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------- schema mgmt
export function renameRecordType(name, new_label) {
  name = slug(name);
  const before = getDb().prepare("SELECT * FROM record_types WHERE name=?").get(name);
  if (!before) return { error: `no section '${name}'` };
  getDb().prepare("UPDATE record_types SET label=? WHERE name=?").run(new_label, name);
  logAudit("ai", "update", "record_types", before.id, before, getRow("record_types", before.id), "renamed section");
  return { status: "renamed", record_type: name, label: new_label };
}

export function renameField(record_type, name, new_label) {
  record_type = slug(record_type); name = slug(name);
  const before = getDb().prepare("SELECT * FROM fields WHERE record_type=? AND name=?").get(record_type, name);
  if (!before) return { error: `no field '${name}' on '${record_type}'` };
  getDb().prepare("UPDATE fields SET label=? WHERE id=?").run(new_label, before.id);
  logAudit("ai", "update", "fields", before.id, before, getRow("fields", before.id), "renamed field");
  return { status: "renamed", field: name, label: new_label };
}

export function removeField(record_type, name) {
  record_type = slug(record_type); name = slug(name);
  const before = getDb().prepare("SELECT * FROM fields WHERE record_type=? AND name=?").get(record_type, name);
  if (!before) return { error: `no field '${name}' on '${record_type}'` };
  getDb().prepare("DELETE FROM fields WHERE id=?").run(before.id);
  logAudit("ai", "delete", "fields", before.id, before, null, "removed field");
  return { status: "removed", record_type, field: name };
}

export function deleteRecordType(name, force = false) {
  name = slug(name);
  const d = getDb();
  const trow = d.prepare("SELECT * FROM record_types WHERE name=?").get(name);
  if (!trow) return { error: `no section '${name}'` };
  const n = d.prepare("SELECT COUNT(*) c FROM records WHERE type=?").get(name).c;
  if (n && !force) return { error: `'${name}' still has ${n} record(s). Remove those first, or confirm.` };
  for (const f of getFields(name)) removeField(name, f.name);
  if (force) d.prepare("DELETE FROM records WHERE type=?").run(name);
  d.prepare("DELETE FROM record_types WHERE id=?").run(trow.id);
  logAudit("ai", "delete", "record_types", trow.id, trow, null, "deleted section");
  return { status: "deleted", record_type: name };
}

// ---------------------------------------------------------------- options (townships / leagues)
export function addFieldOption(record_type, field, option) {
  record_type = slug(record_type); field = slug(field);
  const row = getDb().prepare("SELECT * FROM fields WHERE record_type=? AND name=?").get(record_type, field);
  if (!row) {
    // The choice field doesn't exist yet — create it as a select so "add a jersey size
    // choice of S, M, L" works in one step (this first option seeds it; later ones append).
    const label = field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const res = addField(record_type, field, "select", label, false, [option]);
    return res && res.error ? res : { status: "created", field, option };
  }
  if (row.data_type !== "select") return { error: `'${field}' isn't a choice field` };
  const opts = row.options ? JSON.parse(row.options) : [];
  if (opts.includes(option)) return { status: "exists", field, option };
  opts.push(option);
  getDb().prepare("UPDATE fields SET options=? WHERE id=?").run(JSON.stringify(opts), row.id);
  logAudit("ai", "update", "fields", row.id, row, getRow("fields", row.id), `added choice '${option}'`);
  return { status: "added", field, option };
}

export function getFieldOptions(record_type, field) {
  const f = getFields(record_type).find((x) => x.name === slug(field));
  return f && f.options ? JSON.parse(f.options) : [];
}

// ---------------------------------------------------------------- assignment rules
// A field is "missing" (rule can't match against it) when it's null/undefined or an
// empty/whitespace string. Treats data.foo === "" the same as data not having "foo"
// at all — keeps stray blank columns from making rules vacuously pass or fail.
function hasValue(v) {
  if (v == null) return false;
  if (typeof v === "string" && v.trim() === "") return false;
  return true;
}
function cmp(a, op, b) {
  if (!hasValue(a) || !hasValue(b)) return false;
  if ([">", ">=", "<", "<="].includes(op)) {
    const x = parseFloat(a), y = parseFloat(b);
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    return op === ">" ? x > y : op === ">=" ? x >= y : op === "<" ? x < y : x <= y;
  }
  const sa = String(a).trim().toLowerCase(), sb = String(b).trim().toLowerCase();
  if (op === "==") return sa === sb;
  if (op === "!=") return sa !== sb;
  return false;
}
function matchAll(conditions, data) {
  // An empty condition list ("match anything") is treated as a no-match — a rule
  // with no conditions would otherwise fire on every record and override real rules.
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  for (const c of conditions) {
    if (!c || !c.field || !hasValue(c.value)) return false;
    if (!hasValue(data[c.field])) return false;
    if (!cmp(data[c.field], c.op || "==", c.value)) return false;
  }
  return true;
}

export function createAssignmentRule(name, conditions, set_value, set_field = "league", record_type = "player") {
  const cond = JSON.stringify({ all: conditions || [] });
  const act = JSON.stringify({ set: slug(set_field), to: set_value });
  const info = getDb().prepare(
    `INSERT INTO rules(name,kind,record_type,hard,condition,action,active,added_by,created_at)
     VALUES(?,?,?,?,?,?,1,?,?)`
  ).run(name, "assignment", slug(record_type), 0, cond, act, "ai", now());
  logAudit("ai", "create", "rules", info.lastInsertRowid, null, { name }, "created assignment rule");
  return { status: "created", rule: name, id: info.lastInsertRowid, sets: `${slug(set_field)} = ${set_value}` };
}

export function getAssignmentRules(record_type = "player") {
  const rs = getDb().prepare("SELECT * FROM rules WHERE kind='assignment' AND record_type=? ORDER BY id")
    .all(slug(record_type));
  return rs.map((r) => {
    let conds = [], act = {};
    try { conds = JSON.parse(r.condition).all || []; } catch {}
    try { act = JSON.parse(r.action); } catch {}
    return { id: r.id, name: r.name, active: r.active, conditions: conds, set_field: act.set, set_value: act.to };
  });
}

export function evaluateAssignment(record_type, data) {
  const result = {};
  try {
    const rs = getDb().prepare(
      "SELECT condition,action FROM rules WHERE kind='assignment' AND record_type=? AND active=1 ORDER BY id"
    ).all(record_type);
    for (const r of rs) {
      let act, conds;
      try { act = JSON.parse(r.action); } catch { continue; }
      try { conds = JSON.parse(r.condition).all || []; } catch { continue; }
      const tgt = act && act.set;
      // Drop rules with no target field, no value to set, or already-resolved target
      // (first matching rule wins per field — by id order).
      if (!tgt || !hasValue(act.to) || tgt in result) continue;
      if (matchAll(conds, data)) result[tgt] = act.to;
    }
  } catch { return {}; }
  return result;
}

// List up to `limit` records of `record_type`, optionally matching `where`
// (single-field condition: { field, op, value }). Pagination via `offset`.
// Different from find_records: no name-search bias, no 25-default cap, returns
// the full data payload so callers can act on every row.
//   ops supported: ==, !=, >=, <=, >, <, empty, not_empty
//   returns: { records: [{id, name, data}], total }
export function listRecords({ record_type, where = null, limit = 1000, offset = 0, order = "id" } = {}) {
  const rtype = slug(record_type);
  if (!rtype) return { error: "record_type is required" };
  const all = getRecords(rtype);
  const lim = Math.max(1, Math.min(Number(limit) || 1000, 5000));
  const off = Math.max(0, Number(offset) || 0);
  function passes(d) {
    if (!where || !where.field) return true;
    const v = d[where.field];
    const op = where.op || "==";
    const tgt = where.value;
    if (op === "empty") return v == null || v === "";
    if (op === "not_empty") return v != null && v !== "";
    if (v == null) return false;
    if ([">", ">=", "<", "<="].includes(op)) {
      const x = parseFloat(v), y = parseFloat(tgt);
      if (Number.isNaN(x) || Number.isNaN(y)) return false;
      return op === ">" ? x > y : op === ">=" ? x >= y : op === "<" ? x < y : x <= y;
    }
    const sa = String(v).trim().toLowerCase(), sb = String(tgt).trim().toLowerCase();
    if (op === "==") return sa === sb;
    if (op === "!=") return sa !== sb;
    return false;
  }
  const filtered = [];
  for (const r of all) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if (passes(d)) filtered.push({ id: r.id, name: r.name, data: d });
  }
  const order_ = String(order || "id").toLowerCase();
  if (order_ === "name") filtered.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true }));
  else filtered.sort((a, b) => a.id - b.id);
  return { records: filtered.slice(off, off + lim), total: filtered.length };
}

// Set a single field's value on many records at once. Selector is the same as
// listRecords: either explicit `ids` or a `where` condition. Use this when the
// user wants the same value across a group (e.g. "tag every Limerick player
// with division U10"). For incrementing/numbering, use sequenceField instead.
export function bulkUpdateField({ record_type, field, value, ids = null, where = null } = {}) {
  const rtype = slug(record_type);
  if (!rtype) return { error: "record_type is required" };
  if (!field) return { error: "field is required" };
  const targets = ids && ids.length
    ? ids.map((id) => getRow("records", id)).filter((r) => r && r.type === rtype)
    : listRecords({ record_type: rtype, where, limit: 5000 }).records.map((r) => getRow("records", r.id)).filter(Boolean);
  let updated = 0, unchanged = 0;
  const blocked = [];
  for (const r of targets) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if ((d[field] == null ? "" : String(d[field])) === (value == null ? "" : String(value))) { unchanged++; continue; }
    // GUARDED BULK WRITES: through updateRecord so the season lock applies.
    const res = updateRecord(r.id, { [field]: value }, "user(bulk)", `bulk set ${field}`);
    if (res.error) { blocked.push({ id: r.id, name: r.name, reason: res.error }); continue; }
    updated++;
  }
  return {
    status: blocked.length ? "partial" : "ok",
    updated, unchanged, blocked: blocked.length, blocked_details: blocked.slice(0, 20),
    total: targets.length,
  };
}

// Assign sequential values (e.g. 1001, 1002, 1003…) to a field across a group of
// records, in `order` (default: id). Skips records that already have that field
// set unless `overwrite: true`. Used for "give every player a scan number
// starting at 1001" type asks.
export function sequenceField({ record_type, field, start = 1, step = 1, ids = null, where = null, order = "id", overwrite = false } = {}) {
  const rtype = slug(record_type);
  if (!rtype) return { error: "record_type is required" };
  if (!field) return { error: "field is required" };
  const all = ids && ids.length
    ? ids.map((id) => getRow("records", id)).filter((r) => r && r.type === rtype)
        .map((r) => { let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {} return { id: r.id, name: r.name, data: d }; })
    : listRecords({ record_type: rtype, where, limit: 5000, order }).records;
  let n = Number(start) || 1;
  const inc = Number(step) || 1;
  let assigned = 0, skipped = 0;
  const blocked = [];
  for (const rec of all) {
    if (!overwrite && rec.data[field] != null && rec.data[field] !== "") { skipped++; continue; }
    const value = String(n);
    const res = updateRecord(rec.id, { [field]: value }, "user(sequence)", `sequenced ${field}=${value}`);
    if (res.error) { blocked.push({ id: rec.id, name: rec.name, reason: res.error }); continue; }
    assigned++;
    n += inc;
  }
  return {
    status: blocked.length ? "partial" : "ok",
    assigned, skipped, blocked: blocked.length, blocked_details: blocked.slice(0, 20),
    total: all.length, next: n,
  };
}

// Re-apply assignment rules to every existing record of `record_type`. Used when
// rules change after a roster is loaded, or a player's data is edited and they
// should re-route. Behaviour, per record, per field a rule sets:
//   - rule matches and new value differs from current → overwrite
//   - rule matches and new value matches current      → no-op
//   - no rule matches                                 → leave existing value alone
// For players we also re-run assignDivision so a league change pulls the right division.
// Returns { scanned, updated, fields: { league: n, division: n, … }, changes: [...] }.
export function reassignAllRecords(record_type = "player") {
  const rtype = slug(record_type);
  const recs = getRecords(rtype);
  const byField = {};
  const changes = [];
  const blocked = [];
  let updated = 0;
  for (const r of recs) {
    let data;
    try { data = JSON.parse(r.data || "{}"); } catch { continue; }
    const assigns = evaluateAssignment(rtype, data);
    const patch = {};
    for (const [k, v] of Object.entries(assigns)) {
      if (data[k] !== v) { patch[k] = v; byField[k] = (byField[k] || 0) + 1; }
    }
    if (rtype === "player") {
      const projected = { ...data, ...patch };
      const dv = assignDivision(projected);
      if (dv && projected.division !== dv) { patch.division = dv; byField.division = (byField.division || 0) + 1; }
    }
    if (Object.keys(patch).length) {
      const res = updateRecord(r.id, patch, "user(reassign)", "reassigned by rules");
      if (res.error) { blocked.push({ id: r.id, name: r.name, reason: res.error }); continue; }
      changes.push({ id: r.id, name: r.name, patch });
      updated++;
    }
  }
  return {
    scanned: recs.length, updated, fields: byField, changes,
    blocked: blocked.length, blocked_details: blocked.slice(0, 20),
  };
}

// Edit an existing assignment rule in place. Any of name/conditions/set_value/
// set_field can be omitted to keep the current value. Returns the resulting rule
// shape so the caller can confirm the change.
export function updateAssignmentRule(id, { name = null, conditions = null, set_value = null, set_field = null } = {}) {
  const d = getDb();
  const row = d.prepare("SELECT * FROM rules WHERE id=? AND kind='assignment'").get(Number(id));
  if (!row) return { error: `no assignment rule with id ${id}` };
  let conds = []; try { conds = JSON.parse(row.condition).all || []; } catch {}
  let act = {}; try { act = JSON.parse(row.action); } catch {}
  const before = { name: row.name, conditions: conds, set_field: act.set, set_value: act.to };
  const nextName = name != null ? String(name) : row.name;
  const nextConds = Array.isArray(conditions) ? conditions : conds;
  const nextSetField = set_field != null ? slug(set_field) : act.set;
  const nextSetValue = set_value != null ? String(set_value) : act.to;
  d.prepare("UPDATE rules SET name=?, condition=?, action=? WHERE id=?").run(
    nextName,
    JSON.stringify({ all: nextConds }),
    JSON.stringify({ set: nextSetField, to: nextSetValue }),
    row.id,
  );
  const after = { name: nextName, conditions: nextConds, set_field: nextSetField, set_value: nextSetValue };
  logAudit("user", "update", "rules", row.id, before, after, "edited assignment rule");
  return { status: "updated", id: row.id, rule: after };
}

// Remove one choice from a select field. Refuses if any record currently uses
// that value (caller should reassign first) unless force=true.
export function removeFieldOption(record_type, field, option, { force = false } = {}) {
  const rtype = slug(record_type); const fname = slug(field);
  const d = getDb();
  const row = d.prepare("SELECT * FROM fields WHERE record_type=? AND name=?").get(rtype, fname);
  if (!row) return { error: `no field '${field}' on '${record_type}'` };
  if (row.data_type !== "select") return { error: `'${field}' isn't a choice field` };
  let opts = []; try { opts = JSON.parse(row.options || "[]"); } catch {}
  if (!opts.includes(option)) return { status: "missing", field: fname, option };
  if (!force) {
    let inUse = 0;
    for (const r of getRecords(rtype)) {
      let dd = {}; try { dd = JSON.parse(r.data || "{}"); } catch {}
      if (dd[fname] === option) inUse++;
    }
    if (inUse) return { error: `${inUse} record(s) still use '${option}'. Move them off first, or call again with force=true.`, inUse };
  }
  opts = opts.filter((o) => o !== option);
  d.prepare("UPDATE fields SET options=? WHERE id=?").run(JSON.stringify(opts), row.id);
  logAudit("user", "update", "fields", row.id, { ...row }, { ...row, options: JSON.stringify(opts) }, `removed choice '${option}'`);
  return { status: "removed", field: fname, option, remaining: opts };
}

// Rename a select option AND propagate the change to every record that uses it.
export function renameFieldOption(record_type, field, from, to) {
  const rtype = slug(record_type); const fname = slug(field);
  const d = getDb();
  const row = d.prepare("SELECT * FROM fields WHERE record_type=? AND name=?").get(rtype, fname);
  if (!row) return { error: `no field '${field}' on '${record_type}'` };
  if (row.data_type !== "select") return { error: `'${field}' isn't a choice field` };
  if (!from || !to) return { error: "from and to are required" };
  let opts = []; try { opts = JSON.parse(row.options || "[]"); } catch {}
  if (!opts.includes(from)) return { error: `'${from}' isn't a current choice` };
  opts = opts.map((o) => (o === from ? to : o));
  d.prepare("UPDATE fields SET options=? WHERE id=?").run(JSON.stringify(opts), row.id);
  // Update every record carrying the old value.
  let migrated = 0;
  const blocked = [];
  for (const r of getRecordsAll(rtype)) {
    let dd = {}; try { dd = JSON.parse(r.data || "{}"); } catch { continue; }
    if (dd[fname] !== from) continue;
    const res = updateRecord(r.id, { [fname]: to }, "user", `renamed choice '${from}' → '${to}'`);
    if (res.error) { blocked.push({ id: r.id, name: r.name, reason: res.error }); continue; }
    migrated++;
  }
  logAudit("user", "update", "fields", row.id, { ...row }, { ...row, options: JSON.stringify(opts) }, `renamed choice '${from}' → '${to}'`);
  return {
    status: blocked.length ? "partial" : "renamed",
    field: fname, from, to, migrated,
    blocked: blocked.length, blocked_details: blocked.slice(0, 20),
    options: opts,
  };
}

// Edit an existing division. Any of name/age_min/age_max/league can be omitted
// to keep the current value. After the update, players are re-sorted into the
// matching division based on age.
export function updateDivision(id, { name = null, age_min = null, age_max = null, league = null } = {}) {
  const d = getDb();
  const row = d.prepare("SELECT * FROM records WHERE id=? AND type='division'").get(Number(id));
  if (!row) return { error: `no division with id ${id}` };
  let data = {}; try { data = JSON.parse(row.data || "{}"); } catch {}
  const before = { ...data, name: row.name };
  if (name != null) data.name = String(name);
  if (age_min != null) data.age_min = Number(age_min);
  if (age_max != null) data.age_max = Number(age_max);
  if (league != null) data.league = String(league);
  const blockedSeason = assertWritable(row.season);
  if (blockedSeason) return { error: blockedSeason };
  const newName = name != null ? String(name) : row.name;
  const json = JSON.stringify(data);
  d.prepare("UPDATE records SET name=?, data=?, updated_at=? WHERE id=?").run(newName, json, now(), row.id);
  logAudit("user", "update", "records", row.id, before, { ...data, name: newName }, "edited division");
  reassignDivisions();
  return { status: "updated", id: row.id, division: { ...data, name: newName } };
}

export function deleteRule(id) {
  const before = getRow("rules", id);
  if (!before) return { error: "no such rule" };
  getDb().prepare("DELETE FROM rules WHERE id=?").run(id);
  logAudit("user", "delete", "rules", id, before, null, "deleted rule");
  return { status: "deleted", id };
}

// ---------------------------------------------------------------- team-builder rules
export function createTeamRule(type, field, label) {
  // Don't stack duplicates: if a rule of the same type + field already exists, reuse it.
  const dup = getTeamRules().find((r) => r.type === type && (r.field || "") === (field || ""));
  if (dup) return { status: "exists", id: dup.id, name: dup.name };
  const name = label || (type === "keep_together"
    ? `Keep together: ${field === "__siblings__" ? "siblings" : field}`
    : `Balance by ${field}`);
  const info = getDb().prepare(
    "INSERT INTO rules(name,kind,record_type,hard,condition,action,active,added_by,created_at) VALUES(?,?,?,?,?,?,1,?,?)"
  ).run(name, "team_rule", "player", 0, "{}", JSON.stringify({ type, field }), "user", now());
  logAudit("user", "create", "rules", info.lastInsertRowid, null, { name }, "created team rule");
  return { status: "created", id: info.lastInsertRowid, name };
}

export function getTeamRules() {
  return getDb().prepare("SELECT * FROM rules WHERE kind='team_rule' ORDER BY id").all().map((r) => {
    let a = {};
    try { a = JSON.parse(r.action); } catch {}
    return { id: r.id, name: r.name, active: r.active, type: a.type, field: a.field, max: a.max };
  });
}

// Cap how many "all-star" players land on one team (prevents a super-team). Adds the
// All-Star yes/no detail to players if needed, then upserts a single cap rule.
export function setAllStarCap(max = 2) {
  const m = Math.max(1, Math.floor(Number(max) || 2));
  if (!getFields("player").some((f) => f.name === "all_star")) addField("player", "all_star", "bool", "All-Star");
  for (const r of getTeamRules().filter((r) => r.type === "cap" && r.field === "all_star")) deleteRule(r.id);
  const name = `At most ${m} all-stars per team`;
  const info = getDb().prepare(
    "INSERT INTO rules(name,kind,record_type,hard,condition,action,active,added_by,created_at) VALUES(?,?,?,?,?,?,1,?,?)"
  ).run(name, "team_rule", "player", 0, "{}", JSON.stringify({ type: "cap", field: "all_star", max: m }), "user", now());
  logAudit("user", "create", "rules", info.lastInsertRowid, null, { name }, "set all-star cap");
  return { status: "ok", max: m, name };
}

// ---------------------------------------------------------------- dashboard flags (watch-for rules shown on Home)
export const FLAG_OPS = ["empty", "not_empty", "==", "!=", ">=", "<=", ">", "<"];

function flagMatch(op, val, target) {
  const empty = val === undefined || val === null || String(val).trim() === "";
  if (op === "empty") return empty;
  if (op === "not_empty") return !empty;
  if (empty) return false;
  return cmp(val, op, target);
}

export function createFlag(label, record_type = "player", field, op = "empty", value = "") {
  const rt = slug(record_type);
  const f = slug(field);
  const name = (label || "").trim() || `${f} ${op} ${value}`.trim();
  const action = JSON.stringify({ field: f, op: op || "empty", value: value ?? "", label: name });
  const info = getDb().prepare(
    "INSERT INTO rules(name,kind,record_type,hard,condition,action,active,added_by,created_at) VALUES(?,?,?,?,?,?,1,?,?)"
  ).run(name, "flag", rt, 0, "{}", action, "user", now());
  logAudit("user", "create", "rules", info.lastInsertRowid, null, { name }, "created flag");
  return { status: "created", id: info.lastInsertRowid, name };
}

export function getFlags() {
  return getDb().prepare("SELECT * FROM rules WHERE kind='flag' ORDER BY id").all().map((r) => {
    let a = {}; try { a = JSON.parse(r.action); } catch {}
    return { id: r.id, label: r.name, record_type: r.record_type, field: a.field, op: a.op, value: a.value, kind: a.kind || "field", rule: a.rule, weeks: a.weeks, active: r.active };
  });
}

export function evaluateFlags() {
  const attCache = {};
  return getFlags().map((f) => {
    if (f.kind === "attendance") {
      const n = Number(f.weeks) || 2;
      const set = attCache[n] || (attCache[n] = missedFirstWeeks(n));
      return { ...f, count: set.size, total: getRecords("player").length };
    }
    const recs = getRecords(f.record_type).map((r) => { try { return JSON.parse(r.data || "{}"); } catch { return {}; } });
    let count = 0;
    for (const d of recs) if (flagMatch(f.op, d[f.field], f.value)) count++;
    return { ...f, count, total: recs.length };
  });
}

// Seed the two original built-in flags once, so nothing is lost when the feature turns on.
export function seedDefaultFlags() {
  if (getFlags().length) return;
  if (!getRecordTypes().some((t) => t.name === "player")) return;
  const fields = getFields("player");
  if (fields.some((f) => f.name === "league")) createFlag("Not in a league", "player", "league", "empty", "");
  if (fields.some((f) => f.name === "jersey_size")) createFlag("Missing jersey size", "player", "jersey_size", "empty", "");
}

// ---------------------------------------------------------------- read helpers for the assistant (answer questions)
export function countWhere(record_type, field, op = "empty", value = "") {
  const rt = slug(record_type), f = slug(field);
  const recs = getRecords(rt).map((r) => { try { return JSON.parse(r.data || "{}"); } catch { return {}; } });
  let count = 0;
  for (const d of recs) if (flagMatch(op, d[f], value)) count++;
  return { record_type: rt, field: f, op, value, count, total: recs.length };
}

export function breakdown(record_type, field) {
  const rt = slug(record_type), f = slug(field);
  const recs = getRecords(rt).map((r) => { try { return JSON.parse(r.data || "{}"); } catch { return {}; } });
  const counts = {};
  let blank = 0;
  for (const d of recs) {
    const v = d[f];
    if (v === undefined || v === null || String(v).trim() === "") { blank++; continue; }
    const key = String(v);
    counts[key] = (counts[key] || 0) + 1;
  }
  const groups = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  if (blank) groups.push({ value: "(blank)", count: blank });
  return { record_type: rt, field: f, total: recs.length, groups };
}

// ---------------------------------------------------------------- divisions (age groups within leagues)
export function assignDivision(data) {
  const age = Number(data.age);
  if (Number.isNaN(age)) return null;
  const recs = getRecords("division").map((r) => { try { return JSON.parse(r.data || "{}"); } catch { return {}; } });
  for (const dv of recs) {
    const leagues = playerLeagues(data);
    if (dv.league && leagues.length && !leagues.includes(String(dv.league))) continue;
    const min = dv.age_min === "" || dv.age_min == null ? -Infinity : Number(dv.age_min);
    const max = dv.age_max === "" || dv.age_max == null ? Infinity : Number(dv.age_max);
    if (age >= min && age <= max) return dv.name;
  }
  return null;
}

// WHICH DIVISION IS THIS PLAYER IN?
//
// Ask this, never `data.division`. A division is an age RANGE, so a player is
// in "Ages 9-10" because they are 9 or 10 — not because a spreadsheet once
// wrote a string into that field. Filtering on the raw field is why picking a
// division still turned up "10" and grouped by bare ages: the stored value on
// 400 existing records is an age, and every filter in the app was comparing
// against it.
//
// Order:
//   1. A stored value that names a REAL bracket wins — someone set it on
//      purpose (a young kid playing up, say), and that decision is respected.
//   2. Otherwise the bracket whose age range contains their age, league-aware.
//   3. Otherwise "" — genuinely unsorted, and every screen says so plainly
//      rather than inventing a group.
//
// This means the app is correct BEFORE the stored field is cleaned up, and
// "Re-sort into brackets" just makes the database agree with what you see.
export function divisionOf(data) {
  const stored = String((data && data.division) || "").trim();
  if (stored && isKnownDivision(stored)) return stored;
  return assignDivision(data || {}) || "";
}

// How a roster reads: youngest bracket first, then team, then name A–Z.
//
// A sheet sorted by team alone puts everyone with no team in one anonymous
// block at the top, and a bracket called "Ages 9-10" sorts above "Ages 4-6"
// if you compare it as text. Both were happening on the attendance export.
//
// Returns a comparator; `order` is the division names in bracket order.
export function rosterOrder(order = null) {
  const names = order || getDivisions().map((d) => d.name);
  const rank = new Map(names.map((n, i) => [String(n).trim().toLowerCase(), i]));
  const dv = (p) => {
    const k = String(p.division || "").trim().toLowerCase();   // already resolved by the caller
    if (!k) return 9999;                                   // no division: last
    return rank.has(k) ? rank.get(k) : 9998;               // stray value: just before
  };
  const cmp = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" });
  return (a, b) =>
    dv(a) - dv(b)
    || cmp(a.division, b.division)          // strays among themselves
    || (!!a.team === !!b.team ? cmp(a.team, b.team) : (a.team ? -1 : 1))
    || cmp(a.name, b.name);
}

// ------------------------------------------------- saying what you mean
//
// People say "Upper Merion". The league is called "Sunday Upper Merion". Until
// now that went straight into the record, creating a league that doesn't
// exist — one nobody can filter to, that shows up nowhere, and that quietly
// takes a kid off every roster he was on.
//
// So: match what was said against the real list.
//   exact (ignoring case, spacing and punctuation) → that one
//   exactly one real option CONTAINS it, or it contains exactly one → that one
//   more than one → ambiguous, and the caller asks instead of guessing
//   none → unknown, and the caller says what the real options are
//
// Never invent. An unmatched value is an error with the list attached, not a
// new league.
const _key = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function resolveChoice(value, options = []) {
  const want = _key(value);
  const opts = (options || []).map((o) => String(o)).filter(Boolean);
  if (!want) return { value: "", status: "blank" };
  if (!opts.length) return { value: String(value), status: "no_options" };

  const exact = opts.find((o) => _key(o) === want);
  if (exact) return { value: exact, status: "exact" };

  // Whole-word containment either way: "upper merion" ⊂ "sunday upper merion",
  // and "sat limerick" ⊃ … no. Word-boundary, so "am" can't match "Team".
  const words = (o) => _key(o).split(" ").filter(Boolean);
  const hasRun = (hay, needle) => {
    const H = words(hay), N = words(needle);
    if (!N.length || N.length > H.length) return false;
    for (let i = 0; i + N.length <= H.length; i++) {
      if (N.every((w, j) => H[i + j] === w)) return true;
    }
    return false;
  };
  let hits = opts.filter((o) => hasRun(o, value));
  if (!hits.length) hits = opts.filter((o) => hasRun(value, o));
  if (hits.length === 1) return { value: hits[0], status: "matched", said: String(value) };
  if (hits.length > 1) return { error: `"${value}" could mean ${hits.join(" or ")} — which one?`, status: "ambiguous", candidates: hits };

  return {
    error: `There's no "${value}". The ones that exist are: ${opts.join(", ")}.`,
    status: "unknown", candidates: opts,
  };
}

// The real leagues, for resolving what someone said.
export function leagueNames() {
  const f = getFields("player").find((x) => x.name === "league");
  let opts = []; try { opts = f && f.options ? JSON.parse(f.options) : []; } catch { opts = []; }
  return (opts || []).map(String).filter(Boolean);
}

export function resolveLeague(value) { return resolveChoice(value, leagueNames()); }
export function resolveDivisionName(value) { return resolveChoice(value, divisionNames()); }
export function resolveTeamName(value, league = null) {
  return resolveChoice(value, scheduleTeams(league));
}

// What belongs in a LEAGUE dropdown.
//
// The leagues you configured — not the distinct values found on the players
// who happen to be in this season. Deriving it from the data means a league
// with nobody in it yet simply vanishes from the picker, so you can't select
// it to put anyone there. That's how the check-in board offered one league
// when two exist.
//
// A league picker shows THIS SEASON'S leagues. Not every league the system has
// ever had — "Wedn" was a typo two seasons ago and "Upper Merion" was invented
// by a bad move; neither has anything to do with the season on screen, and a
// picker full of them is worse than one missing an entry.
//
// In order:
//   1. The season declares its leagues → exactly those.
//   2. Otherwise, the configured leagues that anyone in this season is in.
//   3. If nobody is in any league yet (a fresh season), all configured ones —
//      otherwise there'd be nothing to route the first import into.
//
// Plus any league actually on a record IN THIS SEASON: unlike a division, a
// league isn't derived from anything, so dropping one would strand the players
// carrying it — but it has to be a league someone here is actually in.
export function leagueOptions(seen = [], seasonLeagues = null) {
  const f = getFields("player").find((x) => x.name === "league");
  let configured = []; try { configured = f && f.options ? JSON.parse(f.options) : []; } catch { configured = []; }
  configured = (configured || []).map(String).filter(Boolean);

  const inSeason = [...new Set((seen || []).map((x) => String(x || "").trim()).filter(Boolean))];
  const inSeasonKeys = new Set(inSeason.map((l) => l.toLowerCase()));

  let out;
  if (Array.isArray(seasonLeagues) && seasonLeagues.length) {
    const declared = new Set(seasonLeagues.map((l) => String(l).toLowerCase()));
    out = configured.filter((l) => declared.has(l.toLowerCase()));
  } else {
    out = configured.filter((l) => inSeasonKeys.has(l.toLowerCase()));
    if (!out.length && !inSeason.length) out = configured.slice();   // fresh season
  }

  // Anyone in this season who is in a league the list doesn't already have.
  const known = new Set(out.map((l) => l.toLowerCase()));
  for (const v of inSeason.sort()) if (!known.has(v.toLowerCase())) out.push(v);
  return out;
}

// What belongs in a Division dropdown, anywhere in the app.
//
// The brackets you DEFINED, youngest first — never the distinct strings found
// on player records. Deriving the list from the data is what put "10, 11, 12,
// 4, 5, 7, 9" in the check-in board's picker: those are ages an upload wrote
// into the division field, sorted as text.
//
// `seen` (the values actually on records) is still folded in, because a player
// carrying a stray value has to stay reachable — but the defined brackets come
// first and in age order, so the real ones are what you land on.
export function divisionOptions(seen = []) {
  // Only the brackets you defined. Stray values used to be appended so the
  // players carrying them stayed reachable — but nothing resolves to a stray
  // any more (see divisionOf), so offering one would filter to nobody.
  const defined = getDivisions();               // already sorted by age_min
  const known = new Set(defined.map((d) => String(d.name || "").trim().toLowerCase()));
  const out = defined.map((d) => d.name);
  for (const v of new Set((seen || []).map((x) => String(x || "").trim()).filter(Boolean))) {
    if (!known.has(v.toLowerCase())) continue;  // strays are resolved away, not listed
  }
  return out;
}

// The division names that actually exist in the season on screen.
export function divisionNames() {
  if (!getRecordTypes().some((t) => t.name === "division")) return [];
  return getRecords("division").map((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    return String(r.name || d.name || "").trim();
  }).filter(Boolean);
}

// Is this string one of them? Case- and space-insensitive, because "ages 9-10"
// typed into a spreadsheet is the same bracket as "Ages 9-10".
export function isKnownDivision(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase().replace(/\s+/g, " ");
  if (!v) return false;
  return divisionNames().some((n) => n.toLowerCase().replace(/\s+/g, " ") === v);
}

export function setupDivisions() {
  defineRecordType("division", "Divisions", "An age group within a league");
  addField("division", "name", "text", "Division name", true);
  const lf = getFields("player").find((f) => f.name === "league");
  let leagueOpts = [];
  try { leagueOpts = lf && lf.options ? JSON.parse(lf.options) : []; } catch {}
  addField("division", "league", "select", "League", false, leagueOpts.length ? leagueOpts : undefined);
  addField("division", "age_min", "number", "Min age");
  addField("division", "age_max", "number", "Max age");
  if (!getFields("player").some((f) => f.name === "division")) addField("player", "division", "text", "Division");
  return { status: "ready" };
}

export function reassignDivisions() {
  let updated = 0;
  for (const r of getRecords("player")) {
    const data = JSON.parse(r.data || "{}");
    const target = assignDivision(data) || ""; // clear when no bracket matches (keeps it honest)
    if ((data.division || "") !== target) { updateRecord(r.id, { division: target }); updated++; }
  }
  return { updated };
}

export function getDivisions() {
  if (!getRecordTypes().some((t) => t.name === "division")) return [];
  return getRecords("division").map((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    return { id: r.id, name: r.name || d.name || `#${r.id}`, league: d.league || "", age_min: d.age_min ?? "", age_max: d.age_max ?? "" };
  }).sort((a, b) => (Number(a.age_min) || 0) - (Number(b.age_min) || 0));
}

export function createDivision(name, league = "", age_min = null, age_max = null) {
  setupDivisions();
  const nm = String(name || "").trim();
  if (!nm) return { error: "Give the division a name." };
  const data = { name: nm, league: league || "", age_min: age_min === "" || age_min == null ? null : Number(age_min), age_max: age_max === "" || age_max == null ? null : Number(age_max) };
  createRecord("division", data, nm);
  const { updated } = reassignDivisions();
  return { status: "created", name: nm, reassigned: updated };
}

// Standard youth brackets covering ages 4–17 (league-agnostic; edit per league as needed).
export function seedStandardDivisions() {
  setupDivisions();
  const brackets = [["Ages 4-6", 4, 6], ["Ages 7-8", 7, 8], ["Ages 9-10", 9, 10], ["Ages 11-12", 11, 12], ["Ages 13-14", 13, 14], ["Ages 15-17", 15, 17]];
  const existing = new Set(getDivisions().map((d) => d.name.toLowerCase()));
  let added = 0;
  for (const [name, lo, hi] of brackets) {
    if (existing.has(name.toLowerCase())) continue;
    createRecord("division", { name, league: "", age_min: lo, age_max: hi }, name);
    added++;
  }
  const { updated } = reassignDivisions();
  return { status: "ready", added, reassigned: updated };
}

// ---------------------------------------------------------------- weekly attendance / check-in
export function seedAttendance() {
  if (!getRecordTypes().some((t) => t.name === "attendance")) defineRecordType("attendance", "Attendance", "A weekly player check-in");
  const has = (n) => getFields("attendance").some((f) => f.name === n);
  if (!has("player_id")) addField("attendance", "player_id", "number", "Player id");
  if (!has("player")) addField("attendance", "player", "text", "Player");
  if (!has("week")) addField("attendance", "week", "text", "Week");
  // A blank used to mean two different things — "they weren't here" and "nobody
  // took attendance". A sheet you can hand to a coach has to tell those apart,
  // so status is explicit and a record now exists for an absence too.
  if (!has("status")) addField("attendance", "status", "select", "Status", false, ATTENDANCE_STATUSES);
  if (!has("note")) addField("attendance", "note", "text", "Note");
  if (!has("marked_at")) addField("attendance", "marked_at", "text", "Marked at");
  if (!has("marked_by")) addField("attendance", "marked_by", "text", "Marked by");
  if (!has("via")) addField("attendance", "via", "text", "Marked via");
  return { status: "ready", record_type: "attendance" };
}

// Who was actually HERE this week. An "absent" or "excused" row is a record of
// attendance being taken, not of the player showing up — so it must not count.
export function getCheckins(week) {
  if (!getRecordTypes().some((t) => t.name === "attendance")) return new Set();
  const ids = new Set();
  for (const r of getRecords("attendance")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if (String(d.week) === String(week) && d.player_id != null && isPresentRow(d)) ids.add(Number(d.player_id));
  }
  return ids;
}

// ---------------------------------------------------------------- attendance analytics
const _pdata = (r) => { try { return JSON.parse(r.data || "{}"); } catch { return {}; } };
function _weekStartISO(iso) {
  if (!iso) return "";
  const d = new Date(String(iso).length <= 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return "";
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}
// Season weeks (Sunday ISO) from the schedule; falls back to weeks that already have check-ins.
// ------------------------------------------------- the weeks of the season
//
// ATTENDANCE WEEKS ARE NOT THE SCHEDULE. The schedule builder lays out
// fixtures; that's its job and it stops there. Attendance is "how many weeks
// does this season run, and who turned up in each" — a league takes attendance
// on weeks it never scheduled a game for, and a season's length is a decision
// someone makes, not something inferred from a fixture list.
//
// So: the season has a COUNT of weeks that you set, and they are called
// Week 1, Week 2, Week 3. No dates on them. Nobody checking a kid in thinks
// "Sunday the 16th"; they think "week 3".
//
// A week is still STORED under an ISO date — the Sunday of its calendar week —
// because every attendance record ever written hangs off that key and it must
// not move. That key is now purely internal: it is never shown, and week N's
// key is simply the anchor plus N-1 weeks. Any week that already has
// attendance but falls outside the count is kept and shown at the end, so
// shortening the season can never hide what was already recorded.
const WEEK_META_KEY = "week_meta";          // { "<iso>": { label?, cancelled? } }
const ATT_WEEK_COUNT_KEY = "attendance_week_count";
const ATT_WEEK_ANCHOR_KEY = "attendance_week_anchor";
const DEFAULT_WEEK_COUNT = 10;
const MAX_WEEK_COUNT = 40;

function _weekMeta() {
  try {
    const raw = getSetting(WEEK_META_KEY, null);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === "object" ? o : {};
  } catch { return {}; }
}
function _saveWeekMeta(map) {
  for (const k of Object.keys(map)) {
    const m = map[k];
    if (!m || (!m.label && !m.cancelled)) delete map[k];
  }
  setSetting(WEEK_META_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
}

const _addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const _thisWeekISO = () => {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
};

// Weeks that already have attendance recorded — never dropped, whatever the count.
function _recordedWeeks() {
  const set = new Set();
  for (const r of getRecords("attendance")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    if (d.week) set.add(String(d.week));
  }
  return [...set].sort();
}

// Week 1 starts here. Whatever was recorded first, else the anchor you set,
// else this week. Deliberately NOT the schedule.
function _anchorWeek() {
  const recorded = _recordedWeeks();
  if (recorded.length) return recorded[0];
  const saved = getSetting(ATT_WEEK_ANCHOR_KEY, null);
  if (saved && /^\d{4}-\d{2}-\d{2}$/.test(saved)) return saved;
  return _thisWeekISO();
}

export function getSeasonWeekCount() {
  const raw = Number(getSetting(ATT_WEEK_COUNT_KEY, null));
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, MAX_WEEK_COUNT) : DEFAULT_WEEK_COUNT;
}

// What changing the week count would do, before it does it. Shortening a
// season is the consequential direction: columns leave the grid, and if any of
// them have check-ins that's worth saying out loud (nothing is deleted — a
// recorded week stays visible as an extra — but you should know).
export function previewSeasonWeekCount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return { error: "How many weeks? Give a number of 1 or more." };
  if (v > MAX_WEEK_COUNT) return { error: `${MAX_WEEK_COUNT} weeks is the most a season can have.` };

  const from = getSeasonWeekCount();
  const before = seasonWeekList();
  const anchor = _anchorWeek();
  const keys = [];
  for (let i = 0; i < v; i++) keys.push(_addDays(anchor, i * 7));

  const planned = before.filter((w) => !w.beyond);
  const leaving = planned.filter((w) => !keys.includes(w.week));
  const returning = before.filter((w) => w.beyond && keys.includes(w.week));

  return {
    ok: true, from, to: v,
    added: Math.max(0, v - from),
    removing: leaving.map((w) => ({ week: w.week, label: w.label, recorded: w.recorded })),
    removing_with_checkins: leaving.filter((w) => w.recorded).map((w) => w.label),
    returning: returning.map((w) => w.label),
    unchanged: v === from,
  };
}

export function setSeasonWeekCount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return { error: "How many weeks? Give a number of 1 or more." };
  if (v > MAX_WEEK_COUNT) return { error: `${MAX_WEEK_COUNT} weeks is the most a season can have.` };
  setSetting(ATT_WEEK_COUNT_KEY, String(v));
  // Pin the anchor so the weeks don't slide forward as the calendar moves.
  if (!getSetting(ATT_WEEK_ANCHOR_KEY, null)) setSetting(ATT_WEEK_ANCHOR_KEY, _anchorWeek());
  return { ok: true, count: v, weeks: seasonWeekList() };
}

// The season's weeks: Week 1 … Week N, plus anything already recorded beyond N.
// `week` is the internal key. `label` is what a human sees. There is no date.
export function seasonWeekList() {
  const count = getSeasonWeekCount();
  const anchor = _anchorWeek();
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(_addDays(anchor, i * 7));

  // Anything recorded outside the planned run still has to be reachable.
  const extra = _recordedWeeks().filter((w) => !keys.includes(w));
  const all = [...new Set([...keys, ...extra])].sort();

  const meta = _weekMeta();
  const recorded = new Set(_recordedWeeks());
  const now = _thisWeekISO();
  let n = 0;
  return all.map((week) => {
    const m = meta[week] || {};
    const cancelled = !!m.cancelled;
    if (!cancelled) n++;                       // only weeks that happen take a number
    return {
      week,                                    // internal key — not for display
      index: cancelled ? null : n,
      label: m.label || (cancelled ? "Cancelled" : `Week ${n}`),
      named: !!m.label,
      cancelled,
      recorded: recorded.has(week),            // somebody has been checked in
      beyond: !keys.includes(week),            // recorded outside the planned run
      current: week === now,
    };
  });
}

// Rename a week. Blank restores the automatic "Week N".
export function setWeekLabel(week, label) {
  const w = String(week || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w)) return { error: "Which week?" };
  const map = _weekMeta();
  const name = String(label == null ? "" : label).trim();
  map[w] = { ...(map[w] || {}) };
  if (name) map[w].label = name.slice(0, 60); else delete map[w].label;
  _saveWeekMeta(map);
  return { ok: true, week: w, label: name || null, weeks: seasonWeekList() };
}

// Cancel a week — it gives up its number and every week after it moves up one,
// which is what happens in real life when a Saturday is rained off.
export function setWeekCancelled(week, cancelled = true) {
  const w = String(week || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w)) return { error: "Which week?" };
  const map = _weekMeta();
  map[w] = { ...(map[w] || {}) };
  if (cancelled) map[w].cancelled = true; else delete map[w].cancelled;
  _saveWeekMeta(map);
  return { ok: true, week: w, cancelled: !!cancelled, weeks: seasonWeekList() };
}

export function seasonWeeks() {
  const set = new Set();
  for (const r of getRecords("game")) { const w = _weekStartISO(_pdata(r).date); if (w) set.add(w); }
  if (!set.size) for (const r of getRecords("attendance")) { const w = _pdata(r).week; if (w) set.add(String(w)); }
  return [...set].sort();
}
// player_id -> Set of weeks attended
export function attendanceByPlayer() {
  const by = {};
  for (const r of getRecords("attendance")) {
    const d = _pdata(r);
    const id = Number(d.player_id);
    if (id && d.week && isPresentRow(d)) (by[id] = by[id] || new Set()).add(String(d.week));
  }
  return by;
}
// Players who attended ZERO of the first n season weeks (only once those n weeks exist).
export function missedFirstWeeks(n = 2) {
  const out = new Set();
  const weeks = seasonWeeks().slice(0, n);
  if (weeks.length < n) return out;
  const by = attendanceByPlayer();
  for (const r of getRecords("player")) { const set = by[r.id]; if (!weeks.some((w) => set && set.has(w))) out.add(r.id); }
  return out;
}
// Players who've attended fewer than half the weeks so far (low availability).
export function lowAvailabilitySet() {
  const out = new Set();
  const weeks = seasonWeeks();
  if (!weeks.length) return out;
  const need = Math.ceil(weeks.length / 2);
  const by = attendanceByPlayer();
  for (const r of getRecords("player")) { const set = by[r.id]; const a = weeks.filter((w) => set && set.has(w)).length; if (a < need) out.add(r.id); }
  return out;
}
// (Re)create the "missed first 2 weeks — hold jersey" attendance flag if it isn't there.
export function ensureJerseyHoldFlag() {
  if (!getRecordTypes().some((t) => t.name === "player")) return { status: "skipped" };
  if (getFlags().some((f) => f.kind === "attendance" && f.rule === "missed_first")) return { status: "exists" };
  const action = JSON.stringify({ kind: "attendance", rule: "missed_first", weeks: 2, label: "Missed first 2 weeks — hold jersey" });
  const info = getDb().prepare("INSERT INTO rules(name,kind,record_type,hard,condition,action,active,added_by,created_at) VALUES(?,?,?,?,?,?,1,?,?)")
    .run("Missed first 2 weeks — hold jersey", "flag", "player", 0, "{}", action, "user", now());
  logAudit("user", "create", "rules", info.lastInsertRowid, null, { name: "Missed first 2 weeks — hold jersey" }, "created jersey-hold flag");
  return { status: "created", id: info.lastInsertRowid };
}

// Which active player flags does this player trip? (for the game-day board)
export function flagsForPlayer(player) {
  let missed = null;
  return getFlags()
    .filter((f) => {
      if (!f.active || f.record_type !== "player") return false;
      if (f.kind === "attendance") { missed = missed || missedFirstWeeks(Number(f.weeks) || 2); return Number(player.id) && missed.has(Number(player.id)); }
      return flagMatch(f.op, player[f.field], f.value);
    })
    .map((f) => f.label);
}

export function ensurePlayerNotes() {
  if (getRecordTypes().some((t) => t.name === "player") && !getFields("player").some((f) => f.name === "notes")) addField("player", "notes", "text", "Notes");
  return { status: "ok" };
}

// Ensure the scan number / key tag detail exists on players (so scans key off it, and it's editable).
export function ensurePlayerKeyTag() {
  if (getRecordTypes().some((t) => t.name === "player") && !getFields("player").some((f) => f.name === "key_tag")) addField("player", "key_tag", "text", "Scan number / key tag");
  return { status: "ok" };
}

// Ensure the All-Star boolean detail exists on players. Independently visible
// even when no cap rule is set, so admins can mark all-stars proactively and the
// list / board show the chip immediately.
export function ensurePlayerAllStar() {
  if (getRecordTypes().some((t) => t.name === "player") && !getFields("player").some((f) => f.name === "all_star")) addField("player", "all_star", "bool", "All-Star");
  return { status: "ok" };
}

export const ATTENDANCE_STATUSES = ["present", "absent", "excused"];

// A row counts as "here" unless it explicitly says otherwise. Records written
// before status existed have none, and those were only ever created on a
// check-in — so no status means present.
export const isPresentRow = (d) => {
  const st = String(d?.status || "").toLowerCase();
  return st === "" || st === "present";
};

function attendanceRowsFor(week, playerId = null) {
  const wk = String(week);
  return getRecords("attendance").filter((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { return false; }
    if (String(d.week) !== wk) return false;
    return playerId == null || Number(d.player_id) === Number(playerId);
  });
}

// The one write path for attendance. Every check-in in the app comes through
// here — the Team Board, the kiosk scanner, the referee kiosk, the Attendance
// grid and S-Dot — so a check-in means the same thing and lands in the same
// place whichever door it came through.
//
// `present` may be a boolean (the old callers) or a status string.
export function setCheckin(playerId, playerName, week, present, opts = {}) {
  seedAttendance();
  const pid = Number(playerId);
  if (!Number.isFinite(pid)) return { error: "A player id is required." };
  const wk = String(week || "").trim();
  if (!wk) return { error: "A week is required (the Sunday that starts it, YYYY-MM-DD)." };

  let status;
  if (typeof present === "string") {
    status = present.toLowerCase();
    if (!ATTENDANCE_STATUSES.includes(status) && status !== "clear") {
      return { error: `Status must be one of: ${ATTENDANCE_STATUSES.join(", ")} (or "clear").` };
    }
  } else {
    status = present ? "present" : "clear";
  }

  const existing = attendanceRowsFor(wk, pid);

  // "clear" = attendance was never taken for this player this week. That is a
  // different fact from "absent", and the sheet shows it differently.
  if (status === "clear") {
    let removed = 0;
    for (const r of existing) { const res = deleteRecord(r.id, "user"); if (!res.error) removed++; }
    return { status: "cleared", removed };
  }

  const stamp = {
    status,
    note: opts.note == null ? undefined : String(opts.note),
    marked_at: now(),
    marked_by: (typeof getActor === "function" ? getActor() : "user"),
    via: opts.via || "app",
  };
  for (const k of Object.keys(stamp)) if (stamp[k] === undefined) delete stamp[k];

  if (existing.length) {
    const res = updateRecord(existing[0].id, stamp, "user", `attendance ${status}`);
    if (res.error) return { error: res.error };
    // Collapse any accidental duplicates for the same player-week.
    for (const dup of existing.slice(1)) deleteRecord(dup.id, "user");
    return { status: status === "present" ? "checked_in" : status, id: existing[0].id };
  }

  const created = applyCreateRecord("attendance",
    `${playerName || pid} — ${wk}`,
    { player_id: pid, player: playerName || "", week: wk, ...stamp },
    "user");
  if (created.error) return { error: created.error };
  return { status: status === "present" ? "checked_in" : status, id: created.id };
}

// ---------------------------------------------------------------- one week
// The exportable, editable unit: one week's sheet for the season on screen.
// Everyone on the roster appears, with what we know about them that week —
// including "not taken", which is why a blank row still shows up.
export function attendanceWeek({ week, league = null, division = null, team = null } = {}) {
  seedAttendance();
  const wk = String(week || "").trim();
  if (!wk) return { error: "Which week? (the Sunday that starts it, YYYY-MM-DD)" };

  const marks = new Map();
  for (const r of attendanceRowsFor(wk)) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    marks.set(Number(d.player_id), {
      record_id: r.id,
      status: String(d.status || "present").toLowerCase(),
      note: d.note || "",
      marked_at: d.marked_at || "",
      marked_by: d.marked_by || "",
      via: d.via || "",
    });
  }

  const rows = [];
  for (const r of getRecords("player")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    if (league && (d.league || "") !== league && (d.second_league || "") !== league) continue;
    if (division && divisionOf(d) !== division) continue;
    if (team && (d.team || "") !== team) continue;
    const m = marks.get(r.id);
    rows.push({
      id: r.id,
      name: r.name || d.full_name || `#${r.id}`,
      league: d.league || "", division: divisionOf(d), team: d.team || "",
      status: m ? m.status : "",          // "" = not taken
      note: m ? m.note : "",
      marked_at: m ? m.marked_at : "",
      marked_by: m ? m.marked_by : "",
      via: m ? m.via : "",
    });
  }
  // Division (youngest bracket first), then team, then name A–Z — the same
  // order the export and the grid use, so a printed sheet and a screen match.
  rows.sort(rosterOrder());

  const count = (st) => rows.filter((r) => r.status === st).length;
  return {
    week: wk,
    rows,
    totals: {
      roster: rows.length,
      present: count("present"),
      absent: count("absent"),
      excused: count("excused"),
      not_taken: rows.filter((r) => !r.status).length,
    },
    filters: { league, division, team },
  };
}

// Save a whole week in one go — what the Save button on the Attendance page
// sends. One transaction, audited per player, and it reports what was refused
// rather than counting a blocked write as saved.
export function saveAttendanceWeek({ week, entries = [], via = "sheet" } = {}) {
  const wk = String(week || "").trim();
  if (!wk) return { error: "Which week?" };
  if (!Array.isArray(entries) || !entries.length) return { error: "Nothing to save." };

  const saved = [], blocked = [];
  const tx = getDb().transaction(() => {
    for (const e of entries) {
      const pid = Number(e.id ?? e.player_id);
      if (!Number.isFinite(pid)) { blocked.push({ id: e.id, reason: "Not a player id." }); continue; }
      const res = setCheckin(pid, e.name || e.player || "", wk, e.status ?? "clear", { note: e.note, via });
      if (res.error) blocked.push({ id: pid, name: e.name || "", reason: res.error });
      else saved.push(pid);
    }
  });
  tx();

  const after = attendanceWeek({ week: wk });
  return {
    status: blocked.length ? "partial" : "saved",
    week: wk, saved: saved.length,
    blocked: blocked.length, blocked_details: blocked.slice(0, 20),
    totals: after.totals,
  };
}

// Every week the season knows about: the schedule's game weeks, plus any week
// somebody has already marked. Chronological.
export function attendanceWeeks(league = null) {
  seedAttendance();
  const set = new Set();
  for (const r of getRecords("game")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    if (league && (d.league || "") !== league) continue;
    const w = _weekStartISO(d.date);
    if (w) set.add(w);
  }
  for (const r of getRecords("attendance")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    if (d.week) set.add(String(d.week));
  }
  return [...set].sort();
}

// ---------------------------------------------------------------- validation & reads
// Rank ladder for jersey sizes (and similar select fields). Pairs (band, size) onto
// a single numeric scale so we can fall back to the nearest configured option when
// the exact band+size combo isn't in the list. Adult S is roughly the same physical
// size as Youth XL, so they share rank 5 and either is a fine substitute.
const _SIZE_RANK = {
  YXXS: 0, YXS: 1, YS: 2, YM: 3, YL: 4, YXL: 5, YXXL: 6,
  AXXS: 3, AXS: 4, AS: 5, AM: 6, AL: 7, AXL: 8, AXXL: 9, AXXXL: 10,
  // Adult-equivalent ranks for plain "S"/"M"/"L"/"XL" (no band)
  XXS: 3, XS: 4, S: 5, M: 6, L: 7, XL: 8, XXL: 9, XXXL: 10,
};

// Round-up-within-band lookup. Returns the configured option label (string) or null.
// Used by both the text-parse path and the numeric-size path.
function _coerceFromBandRank(targetBand, targetRank, opts) {
  const ranked = opts
    .map((o) => {
      const ou = String(o).toUpperCase();
      const r = _SIZE_RANK[ou];
      if (r == null) return null;
      return { opt: o, key: ou, rank: r, band: ou.startsWith("Y") ? "Y" : "A" };
    })
    .filter(Boolean);
  if (!ranked.length) return null;
  const sameBand = ranked.filter((r) => r.band === targetBand);
  const asc = (a, b) => a.rank - b.rank;
  const desc = (a, b) => b.rank - a.rank;
  const sbUp = sameBand.filter((r) => r.rank >= targetRank).sort(asc);
  if (sbUp.length) return sbUp[0].opt;
  const upAny = ranked.filter((r) => r.rank >= targetRank).sort(asc);
  if (upAny.length) return upAny[0].opt;
  const sbDown = sameBand.sort(desc);
  if (sbDown.length) return sbDown[0].opt;
  return ranked.sort(desc)[0].opt;
}

function _parseSizeKey(norm) {
  // Returns "YXL" / "AS" / "AXXL" / null, given a normalized lowercase tokenised string.
  // Band tokens (broad — handles plural / possessive forms via prefix-match):
  // youth / kid / child / jr / boy / girl  -> Y
  // adult / men / women / mens / unisex    -> A
  let band = null;
  if (/\b(youth|youths|kid|kids|child|children|childrens|jr|jrs|junior|juniors|boy|boys|girl|girls)\b|^y\b|\by$/.test(norm)) band = "Y";
  else if (/\b(adult|adults|men|mens|man|woman|women|womens|unisex)\b|^a\b|\ba$/.test(norm)) band = "A";

  // Size — order matters: longest patterns first so "extra large" isn't eaten by "small".
  let size = null;
  if (/(triple\s*x|3\s*x|xxxl|3xl)/.test(norm) || /xxx large/.test(norm)) size = "XXXL";
  else if (/(double\s*x|2\s*x|xxl|2xl)/.test(norm) || /xx large/.test(norm)) size = "XXL";
  else if (/(extra\s*large|x\s*large|xl)/.test(norm)) size = "XL";
  else if (/(extra\s*small|x\s*small|xs)/.test(norm)) size = "XS";
  else if (/\b(large|lg|lrg|lge|l)\b/.test(norm)) size = "L";
  else if (/\b(medium|med|md|m)\b/.test(norm)) size = "M";
  else if (/\b(small|sm|sml|s)\b/.test(norm)) size = "S";

  if (!size) return null;
  return (band || "") + size;
}

// Best-effort coercion for free-text values into a fixed set of select options.
// Returns one of: { value: <matched option> } | { value: null } | { value: null, unmatched: <raw> }.
//   - Blank input              → { value: null }
//   - Exact / CI match         → that option
//   - Token-aware parse + rank → nearest available option on the size ladder
//   - Bare numeric youth size  → YS/YM/YL
//   - Unparseable              → { value: null, unmatched: raw }
export function coerceSelectValue(raw, allowedOptions) {
  if (raw == null) return { value: null };
  const s = String(raw).trim();
  if (!s) return { value: null };
  const opts = Array.isArray(allowedOptions) ? allowedOptions : [];
  if (!opts.length) return { value: s };

  // 1) Exact / case-insensitive exact
  if (opts.includes(s)) return { value: s };
  const upper = s.toUpperCase();
  const ciHit = opts.find((o) => String(o).toUpperCase() === upper);
  if (ciHit) return { value: ciHit };

  // Normalize for fuzzy matching. Strip punctuation/hyphens, lower, collapse spaces.
  // "Y-XL" → "y xl", "T-Shirt L" → "t shirt l", "Adlt-M" → "adlt m".
  const norm = s.toLowerCase().replace(/[-_/]+/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const normOptHit = opts.find((o) => String(o).toLowerCase().replace(/[-_/]+/g, " ").replace(/[^a-z0-9]+/g, " ").trim() === norm);
  if (normOptHit) return { value: normOptHit };

  // 2) Try to parse a (band, size) key, then find the best configured option.
  //    "Too big is wearable, too small isn't" — round up within band, then across.
  //    No band token → treat as Adult (most ambiguous "Small"/"Medium"/"XL" inputs).
  const key = _parseSizeKey(norm);
  if (key && _SIZE_RANK[key] != null) {
    const targetBand = key.startsWith("Y") ? "Y" : "A";
    const hit = _coerceFromBandRank(targetBand, _SIZE_RANK[key], opts);
    if (hit) return { value: hit };
  }

  // 3) Numeric youth sizes (4–8 → S, 9–12 → M, 13–16 → L, 17+ → XL → AS fallback).
  const numMatch = norm.match(/\b(\d{1,2})(?:\s*\/\s*\d{1,2})?\b/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    let synthKey = null;
    if (n >= 4 && n <= 8) synthKey = "YS";
    else if (n >= 9 && n <= 12) synthKey = "YM";
    else if (n >= 13 && n <= 16) synthKey = "YL";
    else if (n >= 17 && n <= 20) synthKey = "YXL";
    if (synthKey && _SIZE_RANK[synthKey] != null) {
      const r = _coerceFromBandRank("Y", _SIZE_RANK[synthKey], opts);
      if (r) return { value: r };
    }
  }

  return { value: null, unmatched: s };
}

export function validateRecord(record_type, data) {
  const errors = [];
  for (const f of getFields(record_type)) {
    const v = data[f.name];
    const missing = v === undefined || v === null || v === "";
    if (f.required && missing) errors.push(`${f.label || f.name} is required`);
    if (f.data_type === "number" && !missing && Number.isNaN(parseFloat(v)))
      errors.push(`${f.label || f.name} must be a number`);
    if (f.data_type === "select" && !missing && f.options) {
      const allowed = JSON.parse(f.options);
      if (!allowed.includes(v)) errors.push(`${f.label || f.name} must be one of: ${allowed.join(", ")} (got "${v}")`);
    }
  }
  return errors;
}

// Composite identity key for dedup (FR-1.3): normalized name + age/DOB + phone/email.
// Returns null when there isn't enough to safely match (name alone is unreliable).
const _normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const _digits = (s) => String(s || "").replace(/\D+/g, "");
export function identityKey(data) {
  const name = _normName(data.full_name || data.name);
  const dob = data.dob || data.date_of_birth;
  const agePart = dob ? _normName(dob) : (data.age != null && data.age !== "" ? String(parseFloat(data.age) || data.age) : "");
  const contact = _digits(data.parent_phone || data.phone) || String(data.email || "").toLowerCase().trim();
  if (!name || (!agePart && !contact)) return null;
  return [name, agePart, contact].join("|");
}

// Soft / fuzzy identity (OQ-1): drops middle name tokens so "Kai Pena" and "Kai J. Pena"
// produce the same first+last key. Used ONLY for ambiguity detection on re-upload, never
// for silent merging. A soft match without an exact identityKey match → flagged for review.
function _softNameKey(name) {
  const parts = String(name || "").trim().split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((w) => w && w.length > 1); // drop initials like "J." → "j"
  if (parts.length < 2) return parts.join("");
  return parts[0] + "|" + parts[parts.length - 1];
}
export function softIdentitySig(data) {
  const nameKey = _softNameKey(data.full_name || data.name);
  if (!nameKey) return null;
  const contact = _digits(data.parent_phone || data.phone).slice(-4);
  const age = (data.age != null && data.age !== "") ? Number(parseFloat(data.age)) : null;
  return { nameKey, contact, age: Number.isFinite(age) ? age : null };
}
export function findAmbiguousMatches(rtype, data) {
  // Returns existing records that share first+last name AND corroborate via phone-last-4
  // or age within ±1 — but whose strict identityKey differs from the incoming row.
  const incomingStrict = identityKey(data);
  const incomingSoft = softIdentitySig(data);
  if (!incomingSoft) return [];
  const matches = [];
  for (const r of getRecords(rtype)) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    const otherStrict = identityKey(d);
    if (incomingStrict && otherStrict && incomingStrict === otherStrict) continue; // exact dupe handled elsewhere
    const otherSoft = softIdentitySig(d);
    if (!otherSoft || otherSoft.nameKey !== incomingSoft.nameKey) continue;
    const phoneMatch = !!(incomingSoft.contact && otherSoft.contact && incomingSoft.contact === otherSoft.contact);
    const ageMatch = !!(incomingSoft.age != null && otherSoft.age != null && Math.abs(incomingSoft.age - otherSoft.age) <= 1);
    if (phoneMatch || ageMatch) {
      matches.push({
        id: r.id,
        name: r.name || d.full_name || `#${r.id}`,
        age: d.age ?? null,
        phone_last4: _digits(d.parent_phone || d.phone).slice(-4) || null,
        phoneMatch, ageMatch,
      });
    }
  }
  return matches;
}

export const getRecordTypes = () => getDb().prepare("SELECT * FROM record_types ORDER BY name").all();
export const getFields = (t) => getDb().prepare("SELECT * FROM fields WHERE record_type=? ORDER BY sort,id").all(slug(t));
// Season-scoped by default. This one line is what stops "how many players?"
// from quietly counting last year: every caller in the app reads through it,
// and the answer is always about the season on screen. Reach for
// getRecordsAll() only when you genuinely mean every season (the season
// registry, cross-season migration, the cleanup report).
export const getRecords = (t) => {
  const type = slug(t);
  if (!isSeasonOwned(type)) return getRecordsAll(type);
  const { sql, params } = seasonSql();
  return getDb().prepare(`SELECT * FROM records WHERE type=?${sql} ORDER BY id`).all(type, ...params);
};

// Every season, no scoping. Say what you mean.
export const getRecordsAll = (t) =>
  getDb().prepare("SELECT * FROM records WHERE type=? ORDER BY id").all(slug(t));

// One named season, regardless of the request's scope.
export const getRecordsForSeason = (t, season) => {
  const { sql, params } = seasonSqlFor(season);
  return getDb().prepare(`SELECT * FROM records WHERE type=?${sql} ORDER BY id`).all(slug(t), ...params);
};

// Which record types belong to a season (re-exported so routes and the AI
// tool layer can ask without importing db.js).
export const isSeasonOwned = (t) => SEASON_OWNED_TYPES.includes(slug(t));
export { SEASON_OWNED_TYPES };
export function listRules(record_type = null) {
  const rs = record_type
    ? getDb().prepare("SELECT * FROM rules WHERE record_type=? ORDER BY id").all(slug(record_type))
    : getDb().prepare("SELECT * FROM rules ORDER BY id").all();
  return rs.map((r) => ({ id: r.id, name: r.name, kind: r.kind, active: r.active, condition: r.condition, action: r.action }));
}
export function setRuleActive(id, active) {
  const before = getRow("rules", id);
  getDb().prepare("UPDATE rules SET active=? WHERE id=?").run(active ? 1 : 0, id);
  logAudit("user", "update", "rules", id, before, getRow("rules", id), "toggled rule");
  return { status: "ok" };
}
export function listSchema(record_type = null) {
  const out = {};
  for (const t of getRecordTypes()) {
    if (record_type && t.name !== slug(record_type)) continue;
    out[t.name] = {
      label: t.label,
      fields: getFields(t.name).map((f) => ({
        name: f.name, type: f.data_type, options: f.options ? JSON.parse(f.options) : null,
      })),
    };
  }
  return out;
}

export function seedStandardPlayers() {
  defineRecordType("player", "Players", "A registered kid");
  addField("player", "full_name", "text", "Full Name", true);
  addField("player", "age", "number", "Age");
  addField("player", "township", "select", "Township", false,
    ["Limerick", "Upper Merion", "Phoenixville", "Payne Township", "Plymouth Township"]);
  addField("player", "league", "select", "League", false, ["Saturday Limerick", "Sunday Upper Merion"]);
  // Optional secondary league — a player can be in both leagues at once (moves are managed on the Leagues page).
  {
    const has = (n) => getFields("player").some((f) => f.name === n);
    let leagueOpts = ["Saturday Limerick", "Sunday Upper Merion"];
    try { const lf = getFields("player").find((f) => f.name === "league"); if (lf?.options) leagueOpts = JSON.parse(lf.options); } catch {}
    if (!has("second_league")) addField("player", "second_league", "select", "Second league (optional)", false, leagueOpts);
  }
  addField("player", "jersey_size", "select", "Jersey Size", false, ["YS", "YM", "YL", "AS", "AM", "AL"]);
  addField("player", "parent_phone", "text", "Parent Phone");
  addField("player", "key_tag", "text", "Scan number / key tag");
  if (!getFields("player").some((f) => f.name === "link_group")) addField("player", "link_group", "text", "Link group");
  if (!getFields("player").some((f) => f.name === "link_reason")) addField("player", "link_reason", "text", "Link reason");
  // Size confirmation — on-site gate before printing. Stamped at check-in when a staff member
  // shows the player their current jersey size and confirms or corrects it.
  if (!getFields("player").some((f) => f.name === "size_confirmed_at")) addField("player", "size_confirmed_at", "text", "Size confirmed at (ISO)");
  if (!getFields("player").some((f) => f.name === "size_confirmed_by")) addField("player", "size_confirmed_by", "text", "Size confirmed by");
  if (!getFields("player").some((f) => f.name === "press_override")) addField("player", "press_override", "text", "Press cleared");
  // Legacy installs may have created press_override with the older verbose label —
  // normalize it so the column header matches the new single-checkbox UI.
  (() => {
    const d = getDb(); const row = d.prepare("SELECT * FROM fields WHERE record_type='player' AND name='press_override'").get();
    if (row && /override.*(clear|hold)/i.test(row.label || "")) d.prepare("UPDATE fields SET label=? WHERE id=?").run("Press cleared", row.id);
  })();
  if (!getFields("player").some((f) => f.name === "press_override_reason")) addField("player", "press_override_reason", "text", "Press override reason");
  if (!getFields("player").some((f) => f.name === "press_override_by")) addField("player", "press_override_by", "text", "Press override by");
  if (!getFields("player").some((f) => f.name === "press_override_at")) addField("player", "press_override_at", "text", "Press override at");
  // Hard constraint: players 13 and older route automatically to the Saturday Limerick league.
  createAssignmentRule("Age 13+ → Saturday Limerick", [{ field: "age", op: ">=", value: "13" }], "Saturday Limerick", "league", "player");
  return { status: "ready", record_type: "player" };
}

// Standard Coaches section. The Team Builder keeps a coach's child on their team and spreads coaches evenly.
export function seedCoaches() {
  if (!getRecordTypes().some((t) => t.name === "coach")) defineRecordType("coach", "Coaches", "A team coach or assistant");
  const has = (n) => getFields("coach").some((f) => f.name === n);
  if (!has("full_name")) addField("coach", "full_name", "text", "Full Name", true);
  if (!has("phone")) addField("coach", "phone", "text", "Phone");
  if (!has("role")) addField("coach", "role", "select", "Role", false, ["Head Coach", "Assistant Coach"]);
  // Coach type — descriptive label so the form can adapt for non-parent coaches.
  // "Parent" / "Stepparent" → expect a child name; "External volunteer" → leave child blank.
  // The Team Builder's pinning uses child_name regardless of coach_type, so a stepparent's
  // child gets pinned the same way once their name is typed in (it doesn't need to match
  // the coach's last name).
  if (!has("coach_type")) addField("coach", "coach_type", "select", "Coach type", false, ["Parent", "Stepparent", "External volunteer"]);
  let leagues = [];
  try { const pl = getFields("player").find((f) => f.name === "league"); leagues = pl && pl.options ? JSON.parse(pl.options) : []; } catch {}
  if (!has("league")) addField("coach", "league", "select", "League", false, leagues);
  // Child name — manual entry (the typeahead suggests existing players as you type).
  // Step/foster/non-parent coaches: type the child's name as registered, last name doesn't have to match yours.
  // External volunteers with no child: leave blank.
  const CHILD_LABEL = "Child's name(s) — type the player's name as registered (any last name); leave blank if no child";
  if (!has("child_name")) addField("coach", "child_name", "text", CHILD_LABEL);
  else { try { renameField("coach", "child_name", CHILD_LABEL); } catch {} }
  if (!has("team")) addField("coach", "team", "text", "Team");
  // Admin-toggleable rule (on by default): keep each coach's child on their team.
  if (!getTeamRules().some((r) => r.type === "coach_child")) createTeamRule("coach_child", "", "Keep each coach's child on their team");
  return { status: "ready", record_type: "coach" };
}

// Standard Referees section — the officials who work each field. Used by the Referee view.
export function seedReferees() {
  if (!getRecordTypes().some((t) => t.name === "referee")) defineRecordType("referee", "Referees", "A game official");
  const has = (n) => getFields("referee").some((f) => f.name === n);
  if (!has("full_name")) addField("referee", "full_name", "text", "Full Name", true);
  if (!has("phone")) addField("referee", "phone", "text", "Phone");
  let leagues = [];
  try { const pl = getFields("player").find((f) => f.name === "league"); leagues = pl && pl.options ? JSON.parse(pl.options) : []; } catch {}
  if (!has("league")) addField("referee", "league", "select", "League", false, leagues);
  if (!has("field")) addField("referee", "field", "text", "Field");
  if (!has("key_tag")) addField("referee", "key_tag", "text", "Scan number / key tag");
  if (!has("rate_per_game")) addField("referee", "rate_per_game", "number", "Pay rate per game ($)");
  return { status: "ready", record_type: "referee" };
}

export function seedTournaments() {
  if (!getRecordTypes().some((t) => t.name === "tournament")) defineRecordType("tournament", "Tournaments", "A single-elimination tournament");
  const has = (n) => getFields("tournament").some((f) => f.name === n);
  if (!has("name")) addField("tournament", "name", "text", "Name", true);
  if (!has("date")) addField("tournament", "date", "date", "Date");
  if (!has("state")) addField("tournament", "state", "text", "Bracket data");   // JSON blob the Tournaments page reads/writes
  return { status: "ready", record_type: "tournament" };
}

// ---------------------------------------------------------------- end-of-season ranking (feeds FR-2.10)
// A 1-5 ranking set at the end of each season; next season it becomes the team-builder's
// "balance" input so skill is spread evenly. Recurring: re-rank every season; finalize snapshots history.
export function ensureRankingFields() {
  if (!getRecordTypes().some((t) => t.name === "player")) return { error: "no players section yet" };
  const has = (n) => getFields("player").some((f) => f.name === n);
  if (!has("end_season_rank")) addField("player", "end_season_rank", "number", "End-of-Season Rank (1-5)");
  if (!has("rank_season")) addField("player", "rank_season", "text", "Rank Season");
  if (!has("rank_history")) addField("player", "rank_history", "text", "Rank History");
  return { status: "ready" };
}

export function rankingStatus() {
  ensureRankingFields();
  const players = getRecords("player");
  let ranked = 0, season = "";
  for (const r of players) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    const v = Number(d.end_season_rank);
    if (v >= 1 && v <= 5) ranked++;
    if (d.rank_season) season = d.rank_season;
  }
  const balanceOn = getTeamRules().some((r) => r.type === "balance" && r.field === "end_season_rank");
  return { status: "ok", ranked, total: players.length, balanceOn, season };
}

// Toggle FR-2.10 to use the ranking: when on, ranking becomes the sole team-balance field.
export function setBalanceByRank(on) {
  ensureRankingFields();
  const rules = getTeamRules();
  if (on) {
    for (const r of rules.filter((r) => r.type === "balance" && r.field !== "end_season_rank")) deleteRule(r.id);
    createTeamRule("balance", "end_season_rank", "Balance teams by end-of-season rank");
  } else {
    for (const r of rules.filter((r) => r.type === "balance" && r.field === "end_season_rank")) deleteRule(r.id);
  }
  return rankingStatus();
}

// End the season: stamp the season label on each ranked player and append to their history,
// so the ranking recurs season over season and prior seasons are preserved.
export function finalizeSeason(label = "") {
  ensureRankingFields();
  let finalized = 0;
  for (const r of getRecords("player")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    const v = Number(d.end_season_rank);
    if (!(v >= 1 && v <= 5)) continue;
    let hist = []; try { hist = JSON.parse(d.rank_history || "[]"); } catch {}
    if (!Array.isArray(hist)) hist = [];
    hist.push({ season: label, rank: v });
    updateRecord(r.id, { rank_season: label, rank_history: JSON.stringify(hist) });
    finalized++;
  }
  return { status: "finalized", finalized, season: label };
}

export function getCoaches(league = null) {
  if (!getRecordTypes().some((t) => t.name === "coach")) return [];
  return getRecords("coach").map((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    return { id: r.id, name: r.name || d.full_name || `#${r.id}`, role: d.role || "", league: d.league || "", child: d.child_name || "" };
  }).filter((c) => !league || !c.league || c.league === league);
}

// Build + save teams in one shot for a scoped slice of players. Used by S-Dot
// (and the UI) so an autonomous "build teams" request doesn't need a separate
// preview → save round-trip. Scope: by league and/or division (or both blank
// for every player). Sizing: pass target_size (default 10) OR num_teams.
//
// Steps:
//   1) collect players in scope + active team-builder rules + coaches + links
//   2) run buildTeams (the same heuristic the preview UI uses)
//   3) write `team` field on each placed player, and on each coach assigned
//   4) ensure the `team` field exists on player (and coach if needed)
// Returns: { built: [{ league, division, teams, players, sample_team }], saved, coachesSaved }.
export async function buildAndSaveTeams({ league = null, division = null, target_size = null, num_teams = null, perDivision = false } = {}) {
  // Local import to avoid a top-of-file circular import — teams.js depends on
  // nothing from this module, so this is safe even when called recursively.
  const { buildTeams } = await import("./teams.js");

  const players = getRecords("player").map((r) => ({ id: r.id, name: r.name, ...(safeParse(r.data)) }));
  function inScope(p, lg, dv) {
    if (lg && (p.league || "") !== lg && (p.second_league || "") !== lg) return false;
    if (dv && divisionOf(p) !== dv) return false;
    return true;
  }

  const allRules = getTeamRules();
  const rules = allRules.filter((r) => r.active).map((r) => ({ type: r.type, field: r.field, max: r.max }));
  const coachChildRule = allRules.find((r) => r.type === "coach_child");
  const coachChild = coachChildRule ? !!coachChildRule.active : true;
  const links = listLinks();

  // Decide the slices to build. perDivision=true splits the scope by division so
  // 4–6, 7–8, 9–10… each get their own balanced bracket.
  const slices = [];
  if (perDivision) {
    const divisions = getDivisions();
    if (!divisions.length) {
      slices.push({ league, division: null, players: players.filter((p) => inScope(p, league, null)) });
    } else {
      for (const dv of divisions) {
        slices.push({ league, division: dv.name, players: players.filter((p) => inScope(p, league, dv.name)) });
      }
      // Also build a slice for players without a division (e.g. age outside any bracket).
      const noDiv = players.filter((p) => inScope(p, league, null) && !p.division);
      if (noDiv.length) slices.push({ league, division: "(no division)", players: noDiv });
    }
  } else {
    slices.push({ league, division, players: players.filter((p) => inScope(p, league, division)) });
  }

  // Ensure target fields exist before writing.
  if (!getFields("player").some((f) => f.name === "team")) addField("player", "team", "text", "Team");
  const hasCoachSection = getRecordTypes().some((t) => t.name === "coach");
  if (hasCoachSection && !getFields("coach").some((f) => f.name === "team")) addField("coach", "team", "text", "Team");

  const built = [];
  let saved = 0, coachesSaved = 0;

  for (const slice of slices) {
    if (!slice.players.length) continue;
    const coaches = getCoaches(slice.league || null);
    const result = buildTeams(slice.players, {
      numTeams: num_teams ? Number(num_teams) : null,
      targetSize: target_size ? Number(target_size) : null,
      rules, coaches, coachChild, links,
    });
    const teams = result.teams || [];

    // Commit: prefix team names with the division when slicing per-division, so
    // "Team 1" doesn't collide across brackets (e.g. "9-10 / Team 1").
    const prefix = slice.division && slice.division !== "(no division)" ? `${slice.division} / ` : "";
    for (const t of teams) {
      const teamName = prefix + t.name;
      for (const p of (t.players || [])) {
        updateRecord(p.id, { team: teamName }, "user(buildTeams)");
        saved++;
      }
      if (hasCoachSection) {
        for (const c of (t.coaches || [])) {
          updateRecord(c.id, { team: teamName }, "user(buildTeams)");
          coachesSaved++;
        }
      }
    }
    built.push({
      league: slice.league || null,
      division: slice.division || null,
      teams: teams.length,
      players: slice.players.length,
      sample_team: teams[0] ? { name: prefix + teams[0].name, size: teams[0].size } : null,
    });
  }
  return { built, saved, coachesSaved, target_size: target_size ?? 10, num_teams: num_teams || null };
}

function safeParse(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }

// ---------------------------------------------------------------- season schedule (round-robin games)
// STRICT season check: a record belongs to exactly one season. Untagged
// (legacy) records live in the "(no season)" bucket only.
function _seasonOk(d, season) {
  if (!season) return true; // "All seasons"
  const s = d && d.season ? String(d.season) : "";
  if (String(season) === "(no season)") return !s;
  return s === String(season);
}

// Which division does each team belong to? Team name → division.
//
// Teams built per bracket are named for it ("Ages 9-10 / Team 1"), but plenty
// of teams are just "Team 7" — built before divisions existed, or renamed. So
// the name is only a hint: the real answer is WHO IS ON THE TEAM. Every player
// resolves to a bracket by age (divisionOf), and the team takes the bracket
// its players are in.
//
// A team whose players span two brackets is reported as mixed, with "" for its
// division, so the schedule refuses to guess rather than quietly putting
// eight-year-olds against fifteen-year-olds.
export function teamDivisionMap(league = null, season = null) {
  const counts = new Map();          // team -> Map(division -> n)
  for (const r of getRecords("player")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if (!d.team) continue;
    if (league && (d.league || "") !== league && (d.second_league || "") !== league) continue;
    if (!_seasonOk(d, season)) continue;
    const t = String(d.team);
    const dv = divisionOf(d);
    if (!counts.has(t)) counts.set(t, new Map());
    const m = counts.get(t);
    m.set(dv, (m.get(dv) || 0) + 1);
  }
  const out = new Map();
  for (const [team, m] of counts) {
    const seen = [...m.entries()].filter(([dv]) => dv);          // ignore the unsorted
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (!seen.length) {
      // Nobody on the team resolves to a bracket — fall back to the name.
      out.set(team, { division: _divisionOfTeam(team), mixed: false, players: total, from: "name" });
      continue;
    }
    seen.sort((a, b) => b[1] - a[1]);
    const [top, n] = seen[0];
    out.set(team, {
      division: seen.length > 1 ? "" : top,
      dominant: top,
      mixed: seen.length > 1,
      breakdown: Object.fromEntries(seen),
      players: total,
      from: "players",
    });
  }
  return out;
}

export function scheduleTeams(league = null, season = null) {
  const set = new Set();
  for (const r of getRecords("player")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if (!d.team) continue;
    if (league && (d.league || "") !== league) continue;
    if (!_seasonOk(d, season)) continue;
    set.add(String(d.team));
  }
  return [...set].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

// Teams grouped by the division they actually play in — what the schedule
// builder needs, and what the build form shows you before you commit.
export function scheduleTeamsByDivision(league = null, season = null) {
  const map = teamDivisionMap(league, season);
  const order = getDivisions().map((d) => d.name);
  const groups = new Map(order.map((d) => [d, []]));
  const mixed = [], unsorted = [];
  for (const [team, info] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
    if (info.mixed) { mixed.push({ team, breakdown: info.breakdown }); continue; }
    const dv = info.division;
    if (!dv) { unsorted.push(team); continue; }
    if (!groups.has(dv)) groups.set(dv, []);
    groups.get(dv).push(team);
  }
  return {
    divisions: [...groups.entries()].filter(([, list]) => list.length).map(([division, teams]) => ({ division, teams })),
    mixed,        // teams spanning two brackets — the schedule can't place these
    unsorted,     // teams whose players are in no bracket
    total: map.size,
  };
}

export function seedGamesSection() {
  if (!getRecordTypes().some((t) => t.name === "game")) defineRecordType("game", "Games", "A scheduled game");
  const has = (n) => getFields("game").some((f) => f.name === n);
  if (!has("week")) addField("game", "week", "number", "Week");
  if (!has("date")) addField("game", "date", "date", "Date");
  if (!has("time")) addField("game", "time", "text", "Time");
  let leagues = [];
  try { const pl = getFields("player").find((f) => f.name === "league"); leagues = pl && pl.options ? JSON.parse(pl.options) : []; } catch {}
  if (!has("league")) addField("game", "league", "select", "League", false, leagues);
  if (!has("home_team")) addField("game", "home_team", "text", "Home");
  if (!has("away_team")) addField("game", "away_team", "text", "Away");
  if (!has("location")) addField("game", "location", "text", "Location");
  if (!has("referee")) addField("game", "referee", "text", "Referee");
  const ghas = (n) => getFields("game").some((f) => f.name === n);
  if (!ghas("worked_by")) addField("game", "worked_by", "text", "Worked by (ref names, comma-separated)");
  if (!ghas("worked_at")) addField("game", "worked_at", "text", "Worked at (ISO)");
  if (!ghas("home_score")) addField("game", "home_score", "number", "Home score");
  if (!ghas("away_score")) addField("game", "away_score", "number", "Away score");
  if (!ghas("winner")) addField("game", "winner", "text", "Winner (home/away/tie/forfeit_home/forfeit_away)");
  if (!ghas("score_at")) addField("game", "score_at", "text", "Score entered at (ISO)");
  if (!ghas("score_by")) addField("game", "score_by", "text", "Score entered by");
  if (!ghas("score_note")) addField("game", "score_note", "text", "Score note");
  if (!ghas("season")) addField("game", "season", "text", "Season");
  return { status: "ready", record_type: "game" };
}

export function getSchedule(league = null, season = null) {
  const out = [];
  for (const r of (season ? getRecordsForSeason("game", season) : getRecords("game"))) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if (league && (d.league || "") !== league) continue;
    if (!_seasonOk(d, season)) continue;
    out.push({ id: r.id, week: Number(d.week) || 0, date: d.date || "", time: d.time || "", league: d.league || "", home: d.home_team || "", away: d.away_team || "", location: d.location || "", referee: d.referee || "", worked_by: d.worked_by || "", worked_at: d.worked_at || "",
      home_score: d.home_score === "" || d.home_score == null ? null : Number(d.home_score),
      away_score: d.away_score === "" || d.away_score == null ? null : Number(d.away_score),
      winner: d.winner || "",
      score_at: d.score_at || "",
      score_by: d.score_by || "",
      score_note: d.score_note || "",
    });
  }
  out.sort((a, b) => a.week - b.week || a.id - b.id);
  return out;
}

export function saveSchedule(league = null, games = [], season = null) {
  seedGamesSection();
  // STRICT season scoping on delete: saving/clearing a schedule only replaces
  // games whose season tag matches exactly. Saving "Fall 2026" can never wipe
  // Spring's games (tagged or untagged) for the same league.
  const sn = season == null ? "" : String(season);
  for (const r of getRecords("game")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if ((d.league || "") === (league || "") && String(d.season || "") === sn) deleteRecord(r.id, "user");
  }
  // Drop cross-division matchups before writing — teams in different divisions
  // never play each other. Caller gets the dropped count back so the UI can
  // surface it if anything got filtered out.
  let saved = 0, droppedCrossDivision = 0;
  for (const g of games || []) {
    const hd = _divisionOfTeam(g.home);
    const ad = _divisionOfTeam(g.away);
    if (hd && ad && hd !== ad) { droppedCrossDivision++; continue; }
    createRecord("game", { week: g.week, date: g.date || "", time: g.time || "", league: league || "", season: sn, home_team: g.home, away_team: g.away, location: g.location || "", referee: g.referee || "" }, `Week ${g.week}: ${g.home} vs ${g.away}`);
    saved++;
  }
  return { saved, dropped_cross_division: droppedCrossDivision, season: sn || null };
}

// Sweep existing saved games and delete any cross-division matchups. Used as a
// one-shot cleanup if old data got in (legacy schedules from before the per-
// division build). Idempotent — safe to run multiple times.
// Delete fixtures that pair two teams from different age brackets.
//
// A team's bracket comes from WHO IS ON IT (teamDivisionMap), not from its
// name, so this also catches schedules built before divisions existed — teams
// called "Team 7" that the old name-only check couldn't tell apart.
export function pruneCrossDivisionGames(league = null) {
  const games = getRecords("game");
  const dvMap = teamDivisionMap(league);
  const divOf = (name) => {
    const info = dvMap.get(String(name || ""));
    if (info && !info.mixed && info.division) return info.division;
    return _divisionOfTeam(name || "");
  };
  let removed = 0;
  const examples = [];
  for (const r of games) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    if (league && (d.league || "") !== league) continue;
    const hd = divOf(d.home_team);
    const ad = divOf(d.away_team);
    if (hd && ad && hd !== ad) {
      if (examples.length < 5) examples.push({ id: r.id, home: d.home_team, away: d.away_team, date: d.date, league: d.league });
      deleteRecord(r.id, "user(prune-cross-division)");
      removed++;
    }
  }
  return { ok: true, removed, examples };
}

// One-shot for the assistant: build + save a round-robin for a league.
//
// Now accepts fields (array) OR fields_count (auto-named "Field 1"..."Field N")
// so games get distributed across fields with no clashes via placeOnFields.
// Accepts `weeks` to extend/repeat the round-robin, and `blocked_weeks` (1-based
// week numbers from the start date) which become blackouts so those weekends
// are skipped when computing dates.
// Pull a division name out of a team name like "Ages 11-12 / Team 1".
function _divisionOfTeam(name) {
  const i = String(name || "").indexOf(" / ");
  return i > 0 ? String(name).slice(0, i) : "";
}

export function generateSchedule(league = null, opts = {}) {
  // Strict input check — the schedule needs every parameter the Build form
  // requires. We list ALL missing pieces in one error so callers (especially
  // S-Dot) gather them in a single follow-up instead of trial-and-error.
  const missing = [];
  if (!league) missing.push("league (the schedule has to belong to one league)");
  if (!opts.startDate && !opts.start_date) missing.push("start_date (first game date, YYYY-MM-DD)");
  const _weeks = Number(opts.weeks || 0);
  if (!_weeks || _weeks < 1) missing.push("weeks (how many weeks of games — e.g. 8)");
  // games_per_day is required: each team plays this many games on each game day.
  // 1 is the most common (default), but tournaments / pool play might run 2+.
  const _gpd = Number(opts.gamesPerDay || opts.games_per_day || 0);
  if (!_gpd || _gpd < 1) missing.push("games_per_day (how many games per team each day — usually 1)");
  // slot_mins is required: each division needs slot × games_per_day of runway
  // before the next division can kick off, so we have to know how long a slot is.
  const _slot = Number(opts.slotMins || opts.slot_mins || 0);
  if (!_slot || _slot < 5) missing.push("slot_mins (how long each game / time slot is — e.g. 60)");
  const hasFields = (Array.isArray(opts.fields) && opts.fields.length) || Number(opts.fields_count) > 0;
  if (!hasFields) missing.push("fields or fields_count (e.g. 4 means \"Field 1\"…\"Field 4\")");
  if (missing.length) return { error: "Missing inputs: " + missing.join("; ") + ".", missing };

  const teams = scheduleTeams(league);
  if (teams.length < 2) return { error: "Need at least two saved teams in that league first — build and save teams, then try again." };

  // Per-division start times. Same league = same day; divisions stagger via
  // their own first-game time. Required when the league has divisions; if no
  // teams carry a division prefix, fall back to opts.start_time/startTime so
  // single-bracket leagues still work.
  const divisionStarts = opts.division_start_times || opts.divisionStartTimes || {};
  // Group teams by the division they REALLY play in — from their players'
  // ages, falling back to the name prefix. A round-robin is then built inside
  // each bracket and never across them, so nobody is scheduled against a team
  // four years older.
  const dvMap = teamDivisionMap(league);
  const teamsByDiv = new Map();
  const mixedTeams = [];
  for (const t of teams) {
    const info = dvMap.get(t) || { division: _divisionOfTeam(t), mixed: false };
    if (info.mixed) { mixedTeams.push({ team: t, breakdown: info.breakdown }); continue; }
    const dv = info.division || "";
    if (!teamsByDiv.has(dv)) teamsByDiv.set(dv, []);
    teamsByDiv.get(dv).push(t);
  }
  if (mixedTeams.length) {
    return {
      error: `These teams have players from more than one age bracket, so there's no division to schedule them in: ${mixedTeams.map((m) => m.team).join(", ")}. Rebuild the teams per division, or move those players, then try again.`,
      mixed_teams: mixedTeams,
    };
  }
  const realDivisions = [...teamsByDiv.keys()].filter((d) => !!d);
  // A bracket with a single team can't play anyone — say so rather than
  // dropping it silently and producing a short schedule.
  const lonely = realDivisions.filter((d) => (teamsByDiv.get(d) || []).length < 2);
  if (lonely.length && realDivisions.length > lonely.length) {
    // not fatal — the rest can still be built; reported on the result below
  }
  const fallbackStart = opts.startTime || opts.start_time || null;
  if (realDivisions.length) {
    const missingTimes = realDivisions.filter((d) => !String(divisionStarts[d] || "").trim());
    if (missingTimes.length) {
      return {
        error: "Each division needs a first-game time (HH:MM). Missing: " + missingTimes.join(", ") + ".",
        missing_division_start_times: missingTimes,
        divisions: realDivisions,
      };
    }
  } else if (!fallbackStart) {
    return {
      error: "First game time is required (HH:MM).",
      missing: ["start_time"],
    };
  }

  // Fields: explicit array beats fields_count; default to "Field 1"..."Field 4".
  let fields = Array.isArray(opts.fields) && opts.fields.length ? opts.fields.slice() : null;
  if (!fields && opts.fields_count) {
    const n = Math.max(1, Math.min(20, Number(opts.fields_count) || 0));
    fields = Array.from({ length: n }, (_, i) => `Field ${i + 1}`);
  }
  if (!fields) fields = ["Field 1", "Field 2", "Field 3", "Field 4"]; // sensible default

  // Pre-add blackouts for blocked_weeks BEFORE we compute week dates, so the
  // weekDate walker skips them. We use the league-scoped blackouts where the
  // user provided a league, otherwise the all-leagues set.
  const startISO = opts.startDate || opts.start_date || null;
  const blocked = Array.isArray(opts.blocked_weeks) ? opts.blocked_weeks.map((n) => Number(n)).filter((n) => n >= 1) : [];
  const addedBlackouts = [];
  if (startISO && blocked.length) {
    const baseSet = blackoutDateSet(league); // existing blackouts to respect
    for (const wk of blocked) {
      // wk is 1-based — week 3 means the 3rd calendar week from startISO,
      // i.e. startISO + (wk-1)*7 days. Skip if it's already a blackout.
      const d = new Date(startISO + "T00:00:00");
      d.setDate(d.getDate() + (wk - 1) * 7);
      const iso = d.toISOString().slice(0, 10);
      if (baseSet.has(iso)) continue;
      const res = addBlackout(iso, league || "", opts.blocked_reason || `Blocked week ${wk}`);
      if (!res.error) addedBlackouts.push(iso);
    }
  }

  // Build a separate round-robin per division (or one bracket if no divisions).
  // Same league plays the same day — but each division starts at its own time
  // so they don't clash on fields. Per-week, we place each division independently
  // with its own start time, then concatenate.
  const requestedWeeks = Number(opts.weeks || 0);
  function extendOrCap(mat) {
    if (requestedWeeks > 0 && mat.length < requestedWeeks) {
      const original = mat.slice();
      while (mat.length < requestedWeeks) mat = mat.concat(original.map((wk) => wk.slice()));
      mat = mat.slice(0, requestedWeeks);
    } else if (requestedWeeks > 0) {
      mat = mat.slice(0, requestedWeeks);
    }
    return mat;
  }
  const divisionPlan = []; // [{ division, start_time, weeksMat }]
  if (realDivisions.length) {
    for (const dv of realDivisions) {
      const list = teamsByDiv.get(dv) || [];
      if (list.length < 2) continue; // can't round-robin with < 2 teams
      const mat = extendOrCap(buildSchedule(list, opts));
      divisionPlan.push({ division: dv, start_time: divisionStarts[dv], weeksMat: mat });
    }
  } else {
    divisionPlan.push({ division: "", start_time: fallbackStart, weeksMat: extendOrCap(buildSchedule(teams, opts)) });
  }
  const totalWeeks = Math.max(...divisionPlan.map((p) => p.weeksMat.length), 0);
  const perDivisionPlan = divisionPlan.map((p) => ({
    division: p.division || "(no division)",
    teams: (teamsByDiv.get(p.division) || []).length,
    start_time: p.start_time,
    weeks: p.weeksMat.length,
  }));
  const skippedDivisions = realDivisions
    .filter((d) => (teamsByDiv.get(d) || []).length < 2)
    .map((d) => ({ division: d, teams: (teamsByDiv.get(d) || []).length, reason: "needs at least two teams to play" }));

  const blackoutSet = blackoutDateSet(league);
  const gap = Number(opts.slotMins || opts.slot_mins) || 0;
  const games = [];
  for (let i = 0; i < totalWeeks; i++) {
    const date = startISO ? weekDate(startISO, i, blackoutSet) : "";
    for (const plan of divisionPlan) {
      const wkArr = plan.weeksMat[i] || [];
      const wkGames = wkArr.map((g) => ({ week: i + 1, home: g.home, away: g.away }));
      const placed = placeOnFields(wkGames, fields, plan.start_time, gap);
      for (const g of placed) games.push({ ...g, date });
    }
  }

  const res = saveSchedule(league, games, opts.season != null ? opts.season : null);
  return {
    status: "created",
    league: league || "",
    teams: teams.length,
    weeks: totalWeeks,
    games: res.saved,
    fields,
    divisions: realDivisions,
    // One round-robin per bracket — teams only ever play inside their own.
    per_division: perDivisionPlan,
    skipped_divisions: skippedDivisions,
    division_start_times: realDivisions.length ? divisionStarts : null,
    blocked_weeks: blocked,
    added_blackouts: addedBlackouts,
  };
}

// ---------------------------------------------------------------- multi-league + roster lock
export function playerLeagues(data) {
  return [data?.league, data?.second_league].filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

// Roster locks are per (season, league). Locking Saturday Limerick for Fall
// 2026 leaves the Fall 2023 roster exactly as it was.
const _lockSeason = () => seasonForWrite() || "";

export function getLeagueLocks() {
  const s = currentScope();
  const rows = s.mode === "all"
    ? getDb().prepare("SELECT season, league, locked, locked_at, locked_by FROM league_locks").all()
    : getDb().prepare("SELECT season, league, locked, locked_at, locked_by FROM league_locks WHERE COALESCE(season,'')=?")
        .all(s.mode === "none" ? "" : (s.season || ""));
  return rows.map((r) => ({
    season: r.season || "", league: r.league, locked: !!r.locked,
    locked_at: r.locked_at, locked_by: r.locked_by,
  }));
}

export function isLeagueLocked(league, season = undefined) {
  if (!league) return false;
  const sn = season === undefined ? _lockSeason() : (season || "");
  const row = getDb().prepare("SELECT locked FROM league_locks WHERE COALESCE(season,'')=? AND league=?")
    .get(sn, league);
  return !!(row && row.locked);
}

export function setLeagueLock(league, locked, actor = null, season = undefined) {
  if (!league) return { error: "League name required." };
  const sn = season === undefined ? _lockSeason() : (season || "");
  const a = actor || (typeof getActor === "function" ? getActor() : "user");
  getDb().prepare(
    `INSERT INTO league_locks(season, league, locked, locked_at, locked_by) VALUES(?,?,?,?,?)
     ON CONFLICT(season, league) DO UPDATE SET locked=excluded.locked, locked_at=excluded.locked_at, locked_by=excluded.locked_by`
  ).run(sn, league, locked ? 1 : 0, now(), a);
  logAudit(a, locked ? "lock_league" : "unlock_league", "league_locks", null, null,
    { season: sn, league, locked: !!locked }, "");
  return { ok: true, season: sn, league, locked: !!locked };
}

export function movePlayer(id, changes) {
  const player = getRow("records", id);
  if (!player || player.type !== "player") return { error: "Player not found." };
  let data = {}; try { data = JSON.parse(player.data || "{}"); } catch {}

  const blockedSeason = assertWritable(player.season);
  if (blockedSeason) return { error: blockedSeason };

  const before = {
    league: data.league || "", second_league: data.second_league || "",
    division: data.division || "", team: data.team || "",
  };
  const after = { ...before };

  // Resolve what was ASKED FOR against what exists, so "Upper Merion" lands in
  // "Sunday Upper Merion" instead of creating a league nobody can see.
  const said = [];
  for (const [field, resolver] of [["league", resolveLeague], ["second_league", resolveLeague], ["division", resolveDivisionName]]) {
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    const raw = changes[field];
    if (raw == null || String(raw).trim() === "") { after[field] = ""; continue; }
    const r = resolver(raw);
    if (r.error) return { error: r.error, status: r.status, candidates: r.candidates, field };
    after[field] = r.value;
    if (r.status === "matched") said.push(`took "${r.said}" to mean ${r.value}`);
  }
  // Team moves go through the same guarded path as league/division moves, so
  // "put Maya on Team 3" is locked, audited and undoable like everything else.
  if (Object.prototype.hasOwnProperty.call(changes, "team")) {
    const raw = changes.team;
    if (raw == null || String(raw).trim() === "") after.team = "";
    else {
      // Teams are free text (a brand-new team name is legitimate), so only a
      // near-miss on an EXISTING team is corrected; anything else is taken
      // literally.
      const r = resolveTeamName(raw, after.league || null);
      after.team = r.value && !r.error ? r.value : String(raw);
      if (r.status === "matched") said.push(`took "${r.said}" to mean ${r.value}`);
    }
  }
  // Changing a player's SEASON is a migration, not a move. It has its own tool
  // (enrollPlayersInSeason) so nobody can silently empty last year's roster.
  if (Object.prototype.hasOwnProperty.call(changes, "season")) {
    return { error: "Use \"enroll in season\" to move a player between seasons — a plain move can't change the season." };
  }

  // Dedup: if second_league equals league, drop it
  if (after.second_league && after.second_league === after.league) after.second_league = "";

  // Lock check: any league being added OR removed must not be locked.
  const beforeSet = new Set(playerLeagues(before));
  const afterSet = new Set(playerLeagues(after));
  const touched = new Set([...beforeSet, ...afterSet].filter((l) => beforeSet.has(l) !== afterSet.has(l)));
  for (const l of touched) {
    if (isLeagueLocked(l)) return { error: `Roster for "${l}" is locked. Unlock it before moving players in or out.` };
  }

  // Division must belong to one of the player's resulting leagues (or have no league constraint).
  if (after.division) {
    const div = getDivisions().find((d) => d.name === after.division);
    if (div && div.league && !afterSet.has(div.league)) {
      return { error: `Division "${after.division}" belongs to ${div.league}, which the player isn't in.` };
    }
  }

  // A team belongs to a division; moving to a team from another division without
  // also moving the division is the kind of half-move that quietly corrupts a
  // roster, so name it instead of doing it.
  if (after.team && after.team !== before.team) {
    const teamDiv = String(after.team).includes("/") ? String(after.team).split("/")[0].trim() : "";
    if (teamDiv && after.division && teamDiv !== after.division) {
      return { error: `Team "${after.team}" is in ${teamDiv}, but the player is in ${after.division}. Move the division too, or pick a team in ${after.division}.` };
    }
  }

  const updates = {};
  if (after.league !== before.league) updates.league = after.league;
  if (after.second_league !== before.second_league) updates.second_league = after.second_league;
  if (after.division !== before.division) updates.division = after.division;
  if (after.team !== before.team) updates.team = after.team;
  if (!Object.keys(updates).length) return { ok: true, unchanged: true, after, interpreted: said.length ? said : undefined };

  updateRecord(id, updates);
  // `interpreted` lets the caller say "I took 'Upper Merion' to mean Sunday
  // Upper Merion" instead of silently doing something the user didn't ask for.
  return { ok: true, before, after, interpreted: said.length ? said : undefined };
}

export function bulkMovePlayers(ids, changes, mode = "set") {
  // Resolve the target names ONCE, before touching anybody. A misheard league
  // should be one clear question, not the same error repeated three hundred
  // times with nothing moved.
  const interpreted = [];
  const resolved = { ...changes };
  for (const [field, resolver] of [["league", resolveLeague], ["second_league", resolveLeague], ["division", resolveDivisionName]]) {
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    const raw = changes[field];
    if (raw == null || String(raw).trim() === "") continue;
    const r = resolver(raw);
    if (r.error) return { error: r.error, status: r.status, candidates: r.candidates, field, moved: 0, blocked: [] };
    resolved[field] = r.value;
    if (r.status === "matched") interpreted.push(`took "${r.said}" to mean ${r.value}`);
  }
  changes = resolved;

  // mode "set" = replace fields. mode "add" = add to second_league (only when league is provided and player already has primary).
  const moved = [];
  const blocked = [];
  for (const id of ids || []) {
    const player = getRow("records", Number(id));
    if (!player || player.type !== "player") { blocked.push({ id, reason: "Not found." }); continue; }
    let data = {}; try { data = JSON.parse(player.data || "{}"); } catch {}
    let effective = {};
    if (mode === "add" && changes.league && (data.league || "").trim() && data.league !== changes.league) {
      effective.second_league = changes.league;
      if (changes.division) effective.division = changes.division;
    } else {
      if (Object.prototype.hasOwnProperty.call(changes, "league")) effective.league = changes.league;
      if (Object.prototype.hasOwnProperty.call(changes, "second_league")) effective.second_league = changes.second_league;
      if (Object.prototype.hasOwnProperty.call(changes, "division")) effective.division = changes.division;
      if (Object.prototype.hasOwnProperty.call(changes, "team")) effective.team = changes.team;
    }
    const res = movePlayer(Number(id), effective);
    if (res.error) blocked.push({ id, reason: res.error });
    else moved.push({ id, before: res.before, after: res.after });
  }
  return { moved: moved.length, blocked, details: moved, interpreted: interpreted.length ? interpreted : undefined };
}

function titleCase(s) {
  return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------- referee shifts & pay
function _splitNames(s) {
  return String(s || "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}
function _normRefName(s) { return String(s || "").trim().toLowerCase(); }

export function markGameWorked(gameId, refName) {
  const row = getRow("records", Number(gameId));
  if (!row || row.type !== "game") return { error: "Game not found." };
  let d = {}; try { d = JSON.parse(row.data || "{}"); } catch {}
  const name = String(refName || "").trim();
  if (!name) return { error: "Referee name required." };
  const names = _splitNames(d.worked_by);
  if (!names.some((n) => _normRefName(n) === _normRefName(name))) names.push(name);
  const patch = { worked_by: names.join(", "), worked_at: now() };
  const res = updateRecord(Number(gameId), patch);
  if (res.error) return { error: res.error };
  return { ok: true, gameId: Number(gameId), worked_by: patch.worked_by, worked_at: patch.worked_at };
}

export function unmarkGameWorked(gameId, refName) {
  const row = getRow("records", Number(gameId));
  if (!row || row.type !== "game") return { error: "Game not found." };
  let d = {}; try { d = JSON.parse(row.data || "{}"); } catch {}
  const name = String(refName || "").trim();
  const names = _splitNames(d.worked_by).filter((n) => _normRefName(n) !== _normRefName(name));
  const patch = { worked_by: names.join(", ") };
  if (!names.length) patch.worked_at = "";
  const res = updateRecord(Number(gameId), patch);
  if (res.error) return { error: res.error };
  return { ok: true, gameId: Number(gameId), worked_by: patch.worked_by };
}

export function logRefShift(refName, action) {
  // action: "in" or "out". Pure audit log — no DB record.
  const a = (typeof getActor === "function" ? getActor() : "user");
  logAudit(a, action === "out" ? "ref_check_out" : "ref_check_in", "referee", null, null, { ref: refName || "" }, "");
  return { ok: true };
}

// ---------------------------------------------------------------- generalized player links
// A "link" is a set of rows in player_links sharing the same link_id. Each row points to ONE
// entity (player_id OR coach_id). Kinds:
//   sibling / carpool      — 2+ players, must share a team
//   coach_player           — 1 coach + 1+ players, players pinned to coach's team
//   do_not_link            — 2+ players, must NOT share a team
// The legacy link_group / __siblings__ / coach.child_name systems still work; these are extra
// evidence the builder honors.
export const LINK_KINDS = new Set(["sibling", "coach_player", "carpool", "do_not_link"]);

function _linkIdNew() {
  return "lnk-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 36 ** 4).toString(36);
}

export function listLinks() {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM player_links ORDER BY link_id, id").all();
  const groups = new Map();
  for (const r of rows) {
    const g = groups.get(r.link_id) || { link_id: r.link_id, kind: r.kind, reason: r.reason || "", players: [], coaches: [], created_at: r.created_at, created_by: r.created_by };
    if (r.kind && !g.kind) g.kind = r.kind;
    if (r.reason && !g.reason) g.reason = r.reason;
    if (r.player_id) g.players.push(Number(r.player_id));
    if (r.coach_id) g.coaches.push(Number(r.coach_id));
    groups.set(r.link_id, g);
  }
  // Enrich with names for the UI
  const playerNames = new Map();
  for (const p of (getRecordTypes().some((t) => t.name === "player") ? getRecords("player") : [])) {
    let d = {}; try { d = JSON.parse(p.data || "{}"); } catch {}
    playerNames.set(p.id, p.name || d.full_name || `#${p.id}`);
  }
  const coachNames = new Map();
  for (const c of (getRecordTypes().some((t) => t.name === "coach") ? getRecords("coach") : [])) {
    let d = {}; try { d = JSON.parse(c.data || "{}"); } catch {}
    coachNames.set(c.id, c.name || d.full_name || `#${c.id}`);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    playerNames: g.players.map((id) => ({ id, name: playerNames.get(id) || `#${id}` })),
    coachNames: g.coaches.map((id) => ({ id, name: coachNames.get(id) || `#${id}` })),
  }));
}

export function createLink({ kind, playerIds = [], coachIds = [], reason = "" }) {
  if (!LINK_KINDS.has(kind)) return { error: "Unknown link kind: " + kind };
  const totalMembers = (playerIds || []).length + (coachIds || []).length;
  if (kind === "do_not_link" && (playerIds || []).length < 2) return { error: "Do-not-link needs at least 2 players." };
  if (kind === "coach_player" && ((coachIds || []).length < 1 || (playerIds || []).length < 1)) return { error: "Coach-to-player needs a coach and at least one player." };
  if ((kind === "sibling" || kind === "carpool") && (playerIds || []).length < 2) return { error: kind + " needs at least 2 players." };
  if (totalMembers === 0) return { error: "Link needs members." };

  const link_id = _linkIdNew();
  const db = getDb();
  const ins = db.prepare("INSERT INTO player_links(link_id, kind, player_id, coach_id, reason, created_at, created_by) VALUES(?,?,?,?,?,?,?)");
  const actor = (typeof getActor === "function" ? getActor() : "user");
  const tx = db.transaction(() => {
    for (const pid of playerIds || []) ins.run(link_id, kind, Number(pid), null, reason || null, now(), actor);
    for (const cid of coachIds || []) ins.run(link_id, kind, null, Number(cid), reason || null, now(), actor);
  });
  tx();
  logAudit(actor, "create_link", "player_links", null, null, { link_id, kind, playerIds, coachIds, reason }, "");
  return { ok: true, link_id, kind };
}

export function addLinkMember(link_id, { playerId = null, coachId = null }) {
  if (!playerId && !coachId) return { error: "Need a player or coach." };
  const db = getDb();
  const head = db.prepare("SELECT kind FROM player_links WHERE link_id=? LIMIT 1").get(link_id);
  if (!head) return { error: "Link not found." };
  // Block duplicates
  if (playerId) {
    const dup = db.prepare("SELECT id FROM player_links WHERE link_id=? AND player_id=?").get(link_id, Number(playerId));
    if (dup) return { error: "Already a member." };
  }
  if (coachId) {
    const dup = db.prepare("SELECT id FROM player_links WHERE link_id=? AND coach_id=?").get(link_id, Number(coachId));
    if (dup) return { error: "Already a member." };
  }
  db.prepare("INSERT INTO player_links(link_id, kind, player_id, coach_id, reason, created_at, created_by) VALUES(?,?,?,?,?,?,?)")
    .run(link_id, head.kind, playerId ? Number(playerId) : null, coachId ? Number(coachId) : null, null, now(), (typeof getActor === "function" ? getActor() : "user"));
  return { ok: true };
}

export function removeLinkMember(link_id, { playerId = null, coachId = null }) {
  const db = getDb();
  if (playerId) db.prepare("DELETE FROM player_links WHERE link_id=? AND player_id=?").run(link_id, Number(playerId));
  if (coachId) db.prepare("DELETE FROM player_links WHERE link_id=? AND coach_id=?").run(link_id, Number(coachId));
  // Auto-delete the link if it now has fewer than 2 entities (no point keeping a singleton link).
  const left = db.prepare("SELECT COUNT(*) c FROM player_links WHERE link_id=?").get(link_id);
  if (!left || left.c < 2) db.prepare("DELETE FROM player_links WHERE link_id=?").run(link_id);
  return { ok: true };
}

export function deleteLink(link_id) {
  const db = getDb();
  const before = db.prepare("SELECT * FROM player_links WHERE link_id=?").all(link_id);
  db.prepare("DELETE FROM player_links WHERE link_id=?").run(link_id);
  logAudit((typeof getActor === "function" ? getActor() : "user"), "delete_link", "player_links", null, { link_id, rows: before }, null, "");
  return { ok: true };
}

export function setLinkReason(link_id, reason) {
  const db = getDb();
  db.prepare("UPDATE player_links SET reason=? WHERE link_id=?").run(reason || null, link_id);
  return { ok: true };
}

// Returns the shape the team builder wants:
//   { positive: [[playerIds]], doNotLink: [[playerIds]], coachAttach: { coachId: [playerIds] } }
export function linkData() {
  const all = listLinks();
  const positive = [];
  const doNotLink = [];
  const coachAttach = {};
  for (const g of all) {
    const pids = g.players.slice();
    if (g.kind === "do_not_link") {
      if (pids.length >= 2) doNotLink.push(pids);
    } else if (g.kind === "coach_player") {
      if (pids.length >= 1) positive.push(pids); // players still need to share a team
      for (const cid of g.coaches) coachAttach[cid] = (coachAttach[cid] || []).concat(pids);
    } else {
      if (pids.length >= 2) positive.push(pids);
    }
  }
  return { positive, doNotLink, coachAttach };
}

export function payReport(opts = {}) {
  const from = opts.from || null;
  const to = opts.to || null;
  const league = opts.league || null;
  const field = opts.field || null;
  // Build per-ref rate map from referee records (fallback 0)
  const rates = {};
  for (const r of (getRecordTypes().some((t) => t.name === "referee") ? getRecords("referee") : [])) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    const nm = d.full_name || r.name || "";
    if (!nm) continue;
    rates[_normRefName(nm)] = { name: nm, rate: Number(d.rate_per_game) || 0 };
  }
  // Walk games, tally
  const totals = {}; // key: normName -> { name, rate, games, total, gameRows: [] }
  for (const g of (getRecordTypes().some((t) => t.name === "game") ? getRecords("game") : [])) {
    let d = {}; try { d = JSON.parse(g.data || "{}"); } catch {}
    if (!d.worked_by) continue;
    if (from && d.date && d.date < from) continue;
    if (to && d.date && d.date > to) continue;
    if (league && d.league && d.league !== league) continue;
    if (field && d.location && d.location !== field) continue;
    for (const nm of _splitNames(d.worked_by)) {
      const k = _normRefName(nm);
      const rateInfo = rates[k] || { name: nm, rate: 0 };
      const entry = totals[k] || { name: rateInfo.name, rate: rateInfo.rate, games: 0, total: 0, gameRows: [] };
      entry.games += 1;
      entry.total += rateInfo.rate;
      entry.gameRows.push({ id: g.id, date: d.date || "", time: d.time || "", league: d.league || "", location: d.location || "", home: d.home_team || "", away: d.away_team || "", worked_at: d.worked_at || "" });
      totals[k] = entry;
    }
  }
  return Object.values(totals).sort((a, b) => b.games - a.games);
}

// ---------------------------------------------------------------- final scores + standings
function _deriveWinner(home, away, forfeit) {
  if (forfeit === "home") return "forfeit_home"; // away wins by forfeit-out from home
  if (forfeit === "away") return "forfeit_away";
  if (home == null || away == null || Number.isNaN(Number(home)) || Number.isNaN(Number(away))) return "";
  const h = Number(home), a = Number(away);
  if (h > a) return "home";
  if (a > h) return "away";
  return "tie";
}

export function setGameScore(gameId, payload = {}) {
  const row = getRow("records", Number(gameId));
  if (!row || row.type !== "game") return { error: "Game not found." };
  let d = {}; try { d = JSON.parse(row.data || "{}"); } catch {}
  const home = payload.home_score == null || payload.home_score === "" ? null : Number(payload.home_score);
  const away = payload.away_score == null || payload.away_score === "" ? null : Number(payload.away_score);
  const forfeit = payload.forfeit || "";  // "" | "home" | "away"
  if (forfeit && forfeit !== "home" && forfeit !== "away") return { error: "forfeit must be 'home' or 'away'." };
  if (!forfeit) {
    if (home == null || away == null) return { error: "Enter both home and away scores (or set a forfeit)." };
    if (Number.isNaN(home) || Number.isNaN(away)) return { error: "Scores must be numbers." };
    if (home < 0 || away < 0) return { error: "Scores can't be negative." };
  }
  const winner = _deriveWinner(home, away, forfeit);
  const patch = {
    home_score: home == null ? "" : home,
    away_score: away == null ? "" : away,
    winner,
    score_at: now(),
    score_by: (typeof getActor === "function" ? getActor() : "user"),
    score_note: payload.note || "",
  };
  const res = updateRecord(Number(gameId), patch);
  if (res.error) return { error: res.error };
  return { ok: true, gameId: Number(gameId), winner, home_score: home, away_score: away };
}

export function clearGameScore(gameId) {
  const row = getRow("records", Number(gameId));
  if (!row || row.type !== "game") return { error: "Game not found." };
  const res = updateRecord(Number(gameId), { home_score: "", away_score: "", winner: "", score_at: "", score_by: "", score_note: "" });
  if (res.error) return { error: res.error };
  return { ok: true, gameId: Number(gameId) };
}

export function getStandings(league = null, season = null) {
  // Roll up wins / losses / ties / points for / points against per team.
  if (!getRecordTypes().some((t) => t.name === "game")) return [];
  const teams = {}; // name -> { team, league, wins, losses, ties, pf, pa, played }
  const ensure = (team, lg) => (teams[team] = teams[team] || { team, league: lg || "", wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, played: 0 });
  // A named season wins over the request's scope — otherwise asking for last
  // season's standings while looking at this season returns an empty table.
  for (const r of (season ? getRecordsForSeason("game", season) : getRecords("game"))) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if (!d.winner) continue;
    if (league && d.league && d.league !== league) continue;
    if (!_seasonOk(d, season)) continue;
    const home = d.home_team || "";
    const away = d.away_team || "";
    if (!home || !away) continue;
    const h = Number(d.home_score) || 0;
    const a = Number(d.away_score) || 0;
    const hRow = ensure(home, d.league);
    const aRow = ensure(away, d.league);
    hRow.played++; aRow.played++;
    hRow.pf += h; hRow.pa += a; aRow.pf += a; aRow.pa += h;
    if (d.winner === "tie") { hRow.ties++; aRow.ties++; }
    else if (d.winner === "home" || d.winner === "forfeit_away") { hRow.wins++; aRow.losses++; }
    else if (d.winner === "away" || d.winner === "forfeit_home") { aRow.wins++; hRow.losses++; }
  }
  return Object.values(teams).sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (b.pf - b.pa) - (a.pf - a.pa));
}

// ---------------------------------------------------------------- blackouts + rainout shift
const _isoDate = (s) => String(s || "").slice(0, 10); // YYYY-MM-DD only

// ------------------------------------------------- late arrivals onto teams
// Registration doesn't stop when the teams are built. Somebody signs up in
// week two, gets imported, and has no team.
//
// Rebuilding is the wrong answer: buildTeams starts from scratch and every
// roster changes, so eight kids get moved to seat one. This does the opposite
// — it NEVER touches a player who already has a team. It only fills seats.
//
// How a seat is chosen, in order:
//   1. Only teams in the same league, and the same division when the player
//      has one — you don't put a 9-year-old on an Ages 13-14 team.
//   2. Anyone sharing a link group with an already-placed player goes to that
//      player's team, cap or no cap. Siblings and carpools stay together;
//      that's the whole point of the link.
//   3. Otherwise the smallest team. Ties broken by whichever team's average
//      age ends up closest to the division's average — the same balance idea
//      the builder uses, applied one player at a time.
//   4. A team at max_size is skipped unless every team is full, in which case
//      the smallest still wins and the result says the cap was exceeded.
//
// dry_run is the default. Nothing moves until you ask twice.
export function placeUnassignedPlayers({
  league = null, division = null, ids = null,
  max_size = null, dry_run = true, actor = "user(place late)", reason = "placed after team build",
} = {}) {
  const lg = league ? String(league).trim() : null;
  const dv = division ? String(division).trim() : null;
  const wantIds = Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;

  const all = [];
  for (const r of getRecords("player")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    if (lg && (d.league || "") !== lg && (d.second_league || "") !== lg) continue;
    all.push({ id: r.id, name: r.name || d.full_name || `#${r.id}`, season: r.season || "", d });
  }
  if (!all.length) return { error: lg ? `No players in ${lg} this season.` : "No players in this season." };

  const teamOf = (p) => String(p.d.team || "").trim();
  const divOf = (p) => divisionOf(p.d);

  // The teams that already exist, from the players sitting on them.
  const teams = new Map(); // name -> { name, division, size, ageSum, ids }
  for (const p of all) {
    const t = teamOf(p);
    if (!t) continue;
    const e = teams.get(t) || { name: t, divisions: new Set(), size: 0, ageSum: 0, ageN: 0, ids: [] };
    e.size++; e.ids.push(p.id);
    if (divOf(p)) e.divisions.add(divOf(p));
    const a = Number(p.d.age);
    if (Number.isFinite(a)) { e.ageSum += a; e.ageN++; }
    teams.set(t, e);
  }
  if (!teams.size) {
    return { error: `No teams exist${lg ? ` in ${lg}` : ""} this season yet — there's nothing to add anyone to. Build the teams first, and everyone imported so far goes in at once.` };
  }

  // Who needs a seat.
  let waiting = all.filter((p) => !teamOf(p));
  if (dv) waiting = waiting.filter((p) => divOf(p) === dv);
  if (wantIds) waiting = waiting.filter((p) => wantIds.has(p.id));
  if (!waiting.length) {
    return {
      status: "nothing to do", league: lg, division: dv,
      season: currentScope().season || NO_SEASON,
      teams: [...teams.values()].map((t) => ({ team: t.name, size: t.size })).sort((a, b) => a.team.localeCompare(b.team)),
      message: `Everyone${lg ? ` in ${lg}` : ""}${dv ? ` / ${dv}` : ""} already has a team.`,
    };
  }

  const cap = max_size == null || max_size === "" ? null : Number(max_size);
  const before = [...teams.values()].map((t) => ({ team: t.name, size: t.size })).sort((a, b) => a.team.localeCompare(b.team));

  // Where each link group already sits, so late siblings join their own team.
  const teamByLink = new Map();
  for (const p of all) {
    const g = String(p.d.link_group || "").trim();
    if (g && teamOf(p) && !teamByLink.has(g)) teamByLink.set(g, teamOf(p));
  }

  // Are the existing teams organised by age bracket? If they are, a player
  // with no bracket can't be seated safely.
  const divisionedTeams = [...teams.values()].some((t) => t.divisions.size > 0);
  const avgAge = (t) => (t.ageN ? t.ageSum / t.ageN : null);
  const globalAvg = (() => {
    let s = 0, n = 0;
    for (const t of teams.values()) { s += t.ageSum; n += t.ageN; }
    return n ? s / n : null;
  })();

  function chooseTeam(p) {
    const g = String(p.d.link_group || "").trim();
    if (g && teamByLink.has(g)) {
      const t = teams.get(teamByLink.get(g));
      if (t) return { team: t, why: `link group "${g}"` };
    }
    const pdv = divOf(p);
    let pool = [...teams.values()];
    if (pdv) {
      const same = pool.filter((t) => t.divisions.has(pdv));
      if (same.length) pool = same;
      else return { team: null, why: `no team in ${pdv}${lg ? ` for ${lg}` : ""}` };
    } else if (divisionedTeams) {
      // The teams are organised by age bracket and this player has none.
      // Guessing would put a nine-year-old on a 13-14 team. Say so instead.
      return { team: null, why: "no division yet — sort them into an age bracket first" };
    }
    let usable = cap ? pool.filter((t) => t.size < cap) : pool;
    let overCap = false;
    if (!usable.length) { usable = pool; overCap = true; }

    const min = Math.min(...usable.map((t) => t.size));
    let best = usable.filter((t) => t.size === min);
    if (best.length > 1 && globalAvg != null && Number.isFinite(Number(p.d.age))) {
      const a = Number(p.d.age);
      // Whose average moves closest to the middle by taking this player.
      best = best.slice().sort((x, y) => {
        const dist = (t) => Math.abs(((t.ageSum + a) / (t.ageN + 1)) - globalAvg);
        return dist(x) - dist(y);
      });
    } else {
      best = best.slice().sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
    }
    return { team: best[0], why: overCap ? `smallest team (all teams at the ${cap} cap)` : "smallest team", overCap };
  }

  const placements = [], skipped = [];
  for (const p of waiting.slice().sort((a, b) => (Number(b.d.age) || 0) - (Number(a.d.age) || 0))) {
    const { team, why, overCap } = chooseTeam(p);
    if (!team) { skipped.push({ id: p.id, name: p.name, reason: why }); continue; }
    placements.push({
      id: p.id, name: p.name, age: p.d.age ?? null, division: divOf(p) || null,
      league: p.d.league || "", team: team.name, why, over_cap: !!overCap,
    });
    // Book the seat so the next player sees the new size.
    team.size++; team.ids.push(p.id);
    const a = Number(p.d.age);
    if (Number.isFinite(a)) { team.ageSum += a; team.ageN++; }
    if (divOf(p)) team.divisions.add(divOf(p));
  }

  const after = [...teams.values()].map((t) => ({ team: t.name, size: t.size })).sort((a, b) => a.team.localeCompare(b.team));

  if (dry_run) {
    return {
      status: "preview", dry_run: true, league: lg, division: dv,
      season: currentScope().season || NO_SEASON,
      would_place: placements.length, placements, skipped,
      teams_before: before, teams_after: after,
      note: "Nothing has changed. Nobody already on a team is touched by this — it only fills seats.",
    };
  }

  let placed = 0; const blocked = [];
  for (const pl of placements) {
    const res = updateRecord(pl.id, { team: pl.team }, actor, reason);
    if (res.error) blocked.push({ id: pl.id, name: pl.name, reason: res.error });
    else placed++;
  }
  return {
    status: blocked.length ? "partial" : "placed", dry_run: false,
    league: lg, division: dv, season: currentScope().season || NO_SEASON,
    placed, blocked: blocked.length, blocked_details: blocked.slice(0, 20),
    placements, skipped, teams_before: before, teams_after: after,
    note: "Only players who had no team were changed. Every change is in the Change Log.",
  };
}

// ---------------------------------------------------------------- bulk selection
// One way to say "which records do you mean", used by every bulk operation so
// the set that gets counted is exactly the set that gets changed. Always inside
// the current season scope — a bulk delete can never reach into another season.
//
// Selector: explicit ids, OR a league, OR a simple field/op/value, in any
// combination (they AND together).
export function selectRecords({ record_type = "player", ids = null, league = null, division = null, team = null, field = null, op = "==", value = null } = {}) {
  const rtype = slug(record_type);
  let rows = getRecords(rtype);

  if (Array.isArray(ids) && ids.length) {
    const want = new Set(ids.map(Number));
    rows = rows.filter((r) => want.has(r.id));
  }
  const test = (d) => {
    if (league && (d.league || "") !== league && (d.second_league || "") !== league) return false;
    if (division && divisionOf(d) !== division) return false;
    if (team && (d.team || "") !== team) return false;
    if (field) {
      const v = d[field];
      if (op === "empty") return v == null || v === "";
      if (op === "not_empty") return v != null && v !== "";
      if (v == null) return false;
      if ([">", ">=", "<", "<="].includes(op)) {
        const x = parseFloat(v), y = parseFloat(value);
        if (Number.isNaN(x) || Number.isNaN(y)) return false;
        return op === ">" ? x > y : op === ">=" ? x >= y : op === "<" ? x < y : x <= y;
      }
      const a = String(v).trim().toLowerCase(), b = String(value == null ? "" : value).trim().toLowerCase();
      if (op === "==") return a === b;
      if (op === "!=") return a !== b;
      return false;
    }
    return true;
  };

  const out = [];
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    if (test(d)) out.push({ id: r.id, name: r.name || d.full_name || `#${r.id}`, season: r.season || "", data: d });
  }
  return out;
}

// What would a bulk operation touch? THIS is where a count comes from — read
// from the database, in the season on screen. Never from what's on screen: a
// page shows a slice, and a slice counted as a total is how "302 players"
// becomes "14".
export function countMatching(sel = {}) {
  const rows = selectRecords(sel);
  const byLeague = {}, byTeam = {};
  for (const r of rows) {
    const lg = r.data.league || "(none)";
    byLeague[lg] = (byLeague[lg] || 0) + 1;
    const tm = r.data.team || "(no team)";
    byTeam[tm] = (byTeam[tm] || 0) + 1;
  }
  return {
    count: rows.length,
    season: currentScope().season || NO_SEASON,
    record_type: slug(sel.record_type || "player"),
    by_league: byLeague,
    sample: rows.slice(0, 8).map((r) => ({ id: r.id, name: r.name, league: r.data.league || "", team: r.data.team || "" })),
    teams: Object.keys(byTeam).length,
  };
}

// ---------------------------------------------------------------- bulk delete
// Deleting a lot of records at once, safely.
//
//   1. The caller must pass `expect_count` — the number it told the user.
//   2. We re-count from the database at execution time.
//   3. If the two disagree, NOTHING is deleted and the error says both numbers.
//
// That last step is the whole point. An assistant that miscounted, or a roster
// that changed between the question and the confirmation, cannot delete a
// different number of people than the one you agreed to.
//
// Every row goes through deleteRecord, so each deletion is audited individually
// and Time Machine can put them back.
export function bulkDeleteRecords({
  record_type = "player", ids = null, league = null, division = null, team = null,
  field = null, op = "==", value = null, expect_count = null, reason = "",
} = {}) {
  const sel = { record_type, ids, league, division, team, field, op, value };
  const rows = selectRecords(sel);
  const n = rows.length;

  if (!n) return { error: "Nothing matches that — nothing was deleted." };

  if (expect_count == null) {
    return {
      error: `Refusing to delete without a confirmed count. ${n} ${slug(record_type)} record(s) match in ${currentScope().season || "this scope"}. Call again with expect_count: ${n}.`,
      would_delete: n,
    };
  }
  if (Number(expect_count) !== n) {
    return {
      error: `Count mismatch — you asked to delete ${expect_count}, but ${n} record(s) actually match right now. Nothing was deleted. Re-check with count_matching and try again.`,
      expected: Number(expect_count), actual: n,
    };
  }

  // One locked season is enough to stop the whole thing; a half-done delete is
  // worse than a refused one.
  for (const r of rows) {
    const blocked = assertWritable(r.season);
    if (blocked) return { error: `${blocked} Nothing was deleted.` };
  }

  const deleted = [], failed = [];
  const tx = getDb().transaction(() => {
    for (const r of rows) {
      const res = deleteRecord(r.id, "user(bulk delete)");
      if (res.error) failed.push({ id: r.id, name: r.name, reason: res.error });
      else deleted.push({ id: r.id, name: r.name });
    }
  });
  tx();

  return {
    status: failed.length ? "partial" : "deleted",
    deleted: deleted.length,
    failed: failed.length,
    failed_details: failed.slice(0, 20),
    record_type: slug(record_type),
    season: currentScope().season || NO_SEASON,
    reason: reason || "",
    note: "Every deletion is in the Change Log and can be restored from Time Machine.",
  };
}

// "Clear out Saturday Limerick" — everything belonging to one league in the
// season on screen. Reports per type, and the same expect_count contract.
export const CLEARABLE_TYPES = ["player", "coach", "game", "team", "division"];

export function countLeagueContents(league, types = ["player", "coach", "game"]) {
  const lg = String(league || "").trim();
  if (!lg) return { error: "Which league?" };
  const list = (types || []).map(slug).filter((t) => CLEARABLE_TYPES.includes(t));
  const per = {};
  let total = 0;
  for (const t of list) {
    const n = selectRecords({ record_type: t, league: lg }).length;
    per[t] = n; total += n;
  }
  return { league: lg, season: currentScope().season || NO_SEASON, per_type: per, total, types: list };
}

export function clearLeague({ league, types = ["player", "coach", "game"], expect_count = null, reason = "" } = {}) {
  const pre = countLeagueContents(league, types);
  if (pre.error) return pre;
  if (!pre.total) return { error: `Nothing to clear — ${pre.league} has no records in ${pre.season}.` };

  if (expect_count == null) {
    return {
      error: `Refusing to clear ${pre.league} without a confirmed count. It holds ${pre.total} record(s) in ${pre.season} (${Object.entries(pre.per_type).map(([k, v]) => `${v} ${k}`).join(", ")}). Call again with expect_count: ${pre.total}.`,
      would_delete: pre.total, per_type: pre.per_type,
    };
  }
  if (Number(expect_count) !== pre.total) {
    return {
      error: `Count mismatch — you asked to clear ${expect_count}, but ${pre.league} holds ${pre.total} record(s) right now. Nothing was deleted.`,
      expected: Number(expect_count), actual: pre.total, per_type: pre.per_type,
    };
  }

  const per = {}; let deleted = 0; const failed = [];
  for (const t of pre.types) {
    const res = bulkDeleteRecords({ record_type: t, league: pre.league, expect_count: pre.per_type[t], reason });
    if (res.error) return { error: `${t}: ${res.error}`, cleared_so_far: per };
    per[t] = res.deleted; deleted += res.deleted;
    if (res.failed) failed.push(...(res.failed_details || []));
  }
  return {
    status: "cleared", league: pre.league, season: pre.season,
    deleted, per_type: per, failed: failed.length, failed_details: failed.slice(0, 20),
    note: "Every deletion is in the Change Log and can be restored from Time Machine.",
  };
}

// ---------------------------------------------------------------- editing one game
// Games are records, so they were always editable by id — but only if you
// already knew the id, and find_records searches full_name, which a game
// doesn't have. These two close that gap: search a schedule the way a person
// describes it ("Team 3's game on the 19th"), then change that one game.

const GAME_FIELDS = ["week", "date", "time", "location", "league", "home_team", "away_team", "referee"];

export function findGames({ league = null, team = null, date = null, week = null, field = null, limit = 25 } = {}) {
  const want = (v) => String(v || "").trim().toLowerCase();
  const t = want(team), f = want(field);
  const d = date ? _isoDate(date) : null;
  const w = week == null || week === "" ? null : Number(week);
  const out = [];
  for (const r of getRecords("game")) {
    let g = {}; try { g = JSON.parse(r.data || "{}"); } catch { continue; }
    if (league && (g.league || "") !== league) continue;
    if (d && _isoDate(g.date) !== d) continue;
    if (w != null && Number(g.week) !== w) continue;
    if (f && !want(g.location).includes(f)) continue;
    if (t && !(want(g.home_team).includes(t) || want(g.away_team).includes(t))) continue;
    out.push({
      id: r.id, week: g.week ?? "", date: g.date || "", time: g.time || "",
      field: g.location || "", league: g.league || "",
      home: g.home_team || "", away: g.away_team || "", referee: g.referee || "",
      home_score: g.home_score ?? null, away_score: g.away_score ?? null, winner: g.winner || "",
      label: `${g.home_team || "?"} v ${g.away_team || "?"} — ${g.date || "?"} ${g.time || ""} ${g.location || ""}`.trim(),
    });
    if (out.length >= Math.max(1, Math.min(Number(limit) || 25, 200))) break;
  }
  out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time)));
  return { games: out, total: out.length };
}

// Change one game. Only the fields you name are touched; anything else is left
// alone. Refuses on a locked season, and refuses a date that's blacked out for
// that league rather than quietly scheduling into it.
export function editGame(gameId, changes = {}) {
  const row = getRow("records", Number(gameId));
  if (!row || row.type !== "game") return { error: `No game #${gameId}.` };
  const blockedSeason = assertWritable(row.season);
  if (blockedSeason) return { error: blockedSeason };

  let data = {}; try { data = JSON.parse(row.data || "{}"); } catch {}
  const patch = {};
  const unknown = [];
  for (const [k, v] of Object.entries(changes || {})) {
    if (v === undefined) continue;
    // "field" is what a person calls it; "location" is what the record calls it.
    const key = k === "field" ? "location" : k;
    if (!GAME_FIELDS.includes(key)) { unknown.push(k); continue; }
    patch[key] = key === "week" ? (v === "" || v == null ? "" : Number(v)) : (v == null ? "" : String(v));
  }
  if (unknown.length) {
    return { error: `Can't set ${unknown.join(", ")} on a game. Changeable: ${GAME_FIELDS.map((f) => (f === "location" ? "field" : f)).join(", ")}. Use set_game_score for scores.` };
  }
  if (!Object.keys(patch).length) return { error: "Nothing to change." };

  if (patch.date) {
    const iso = _isoDate(patch.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { error: "Invalid date (use YYYY-MM-DD)." };
    patch.date = iso;
    const lg = patch.league || data.league || null;
    if (blackoutDateSet(lg).has(iso)) {
      return { error: `${iso} is blacked out${lg ? ` for ${lg}` : ""}. Remove the blackout first, or pick another date.` };
    }
  }
  if (patch.time && !/^\d{1,2}:\d{2}$/.test(String(patch.time).trim())) {
    return { error: "Time should look like 09:00 or 14:30." };
  }
  const after = { ...data, ...patch };
  if (after.home_team && after.away_team && after.home_team === after.away_team) {
    return { error: "A team can't play itself." };
  }

  const before = {};
  for (const k of Object.keys(patch)) before[k] = data[k] ?? "";
  const res = updateRecord(Number(gameId), patch, "user", "edited game");
  if (res.error) return { error: res.error };
  return {
    ok: true, id: Number(gameId), before, after: patch,
    game: findGames({ limit: 200 }).games.find((g) => g.id === Number(gameId)) || null,
  };
}

// Add one game to the saved schedule — the "we're squeezing in a make-up game"
// case, without regenerating the whole thing.
export function addGame({ league, date, time, field = "", home_team, away_team, week = null, referee = "" } = {}) {
  if (!league) return { error: "Which league?" };
  if (!home_team || !away_team) return { error: "Both teams are needed." };
  if (home_team === away_team) return { error: "A team can't play itself." };
  const iso = _isoDate(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { error: "Invalid date (use YYYY-MM-DD)." };
  if (blackoutDateSet(league).has(iso)) return { error: `${iso} is blacked out for ${league}.` };
  const data = {
    league, date: iso, time: time || "", location: field || "",
    home_team, away_team, referee: referee || "",
    week: week == null || week === "" ? "" : Number(week),
  };
  const res = applyCreateRecord("game", `${home_team} vs ${away_team}`, data, "user");
  if (res.error) return res;
  return { ok: true, id: res.id, game: data };
}

export function listBlackouts(league = null) {
  const db = getDb();
  const { sql, params } = seasonSql();
  const rows = league
    ? db.prepare(`SELECT * FROM schedule_blackouts WHERE (league=? OR league='' OR league IS NULL)${sql} ORDER BY date`).all(league, ...params)
    : db.prepare(`SELECT * FROM schedule_blackouts WHERE 1=1${sql} ORDER BY date`).all(...params);
  return rows.map((r) => ({ id: r.id, date: _isoDate(r.date), league: r.league || "", season: r.season || "", reason: r.reason || "", created_at: r.created_at, created_by: r.created_by }));
}

export function blackoutDateSet(league = null) {
  // Set of date strings (YYYY-MM-DD) for a given league (or global only when league is null).
  const list = listBlackouts(league);
  return new Set(list.map((b) => b.date));
}

export function addBlackout(date, league = null, reason = "") {
  const d = _isoDate(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: "Invalid date (use YYYY-MM-DD)." };
  const db = getDb();
  const lg = league || "";
  const sn = seasonForWrite() || "";
  const blockedSeason = assertWritable(sn);
  if (blockedSeason) return { error: blockedSeason };
  // Avoid duplicates; UPSERT semantics — scoped to this season.
  const existing = db.prepare(
    "SELECT id FROM schedule_blackouts WHERE date=? AND COALESCE(league,'')=? AND COALESCE(season,'')=?"
  ).get(d, lg, sn);
  let blackoutId;
  if (existing) {
    if (reason) db.prepare("UPDATE schedule_blackouts SET reason=? WHERE id=?").run(reason, existing.id);
    blackoutId = existing.id;
  } else {
    const actor = (typeof getActor === "function" ? getActor() : "user");
    const info = db.prepare(
      "INSERT INTO schedule_blackouts(date, league, season, reason, created_at, created_by) VALUES(?,?,?,?,?,?)"
    ).run(d, lg, sn || null, reason || null, now(), actor);
    logAudit(actor, "create", "schedule_blackouts", info.lastInsertRowid, null, { date: d, league: lg, season: sn, reason }, "");
    blackoutId = info.lastInsertRowid;
  }

  // Enforce the blackout: any existing games on this date that fall in scope
  // get pushed forward to the next non-blackout Saturday. Without this step a
  // blackout day could still show games (e.g. when the blackout is added after
  // a schedule was built), which is exactly the surprise the user flagged.
  const games = getRecords("game").map((r) => {
    let dd = {}; try { dd = JSON.parse(r.data || "{}"); } catch {}
    return { id: r.id, ...dd };
  }).filter((g) => g.date && _isoDate(g.date) === d && (lg ? (g.league || "") === lg : true));
  let movedTo = null, moved = 0;
  if (games.length) {
    // Use the league-scoped blackout set when scoped, else the global set.
    const bset = blackoutDateSet(lg || null);
    // Walk forward from the blacked-out date, skipping any further blackouts.
    movedTo = _advance7Skipping(d, bset, false);
    for (const g of games) {
      const res = updateRecord(g.id, { date: movedTo }, "user(blackout)");
      if (!res.error) moved++;
    }
  }
  return { ok: true, id: blackoutId, date: d, league: lg, reason, moved, moved_to: movedTo };
}

export function removeBlackout(id) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM schedule_blackouts WHERE id=?").get(Number(id));
  if (!row) return { error: "Blackout not found." };
  db.prepare("DELETE FROM schedule_blackouts WHERE id=?").run(Number(id));
  logAudit((typeof getActor === "function" ? getActor() : "user"), "delete", "schedule_blackouts", Number(id), row, null, "");
  return { ok: true };
}

// Walk a starting date forward, skipping any date in `blackoutSet`. Returns YYYY-MM-DD.
function _advance7Skipping(fromISO, blackoutSet, includeSameDay = false) {
  if (!fromISO) return "";
  let d = new Date(fromISO + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  if (!includeSameDay) d.setDate(d.getDate() + 7);
  for (let safety = 0; safety < 520; safety++) {
    const iso = d.toISOString().slice(0, 10);
    if (!blackoutSet.has(iso)) return iso;
    d.setDate(d.getDate() + 7);
  }
  return d.toISOString().slice(0, 10); // give up — return the next week even if blacked out
}

// Apply a rainout: mark `date` as a blackout (with reason), then push every saved game
// in this league on/after `date` to the next non-blackout slot in week order.
// Returns { moved, blackoutId, mapping: [{from, to, count}] }.
export function applyRainout({ date, league = null, reason = "Rainout" }) {
  const target = _isoDate(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return { error: "Invalid date." };
  // 1) Add blackout
  const bo = addBlackout(target, league || "", reason || "Rainout");
  if (bo.error) return bo;

  // 2) Find affected games in saved schedule for this league
  const games = getRecords("game").map((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    return { id: r.id, ...d };
  }).filter((g) => g.date && _isoDate(g.date) >= target && (league ? (g.league || "") === league : true));

  if (!games.length) return { ok: true, moved: 0, blackoutId: bo.id, mapping: [] };

  // 3) Build the date mapping: unique old dates in ascending order get pushed to a fresh
  //    cascade of non-blackout dates starting from (target + 7) days forward.
  const uniqueOldDates = [...new Set(games.map((g) => _isoDate(g.date)))].sort();
  const blackoutSet = blackoutDateSet(league);
  const mapping = {};
  let cursor = target; // includeSameDay=false will advance to target+7 first
  for (const oldDate of uniqueOldDates) {
    cursor = _advance7Skipping(cursor, blackoutSet, false);
    mapping[oldDate] = cursor;
  }

  // 4) Apply updates
  let moved = 0;
  for (const g of games) {
    const newDate = mapping[_isoDate(g.date)];
    if (!newDate || newDate === _isoDate(g.date)) continue;
    updateRecord(g.id, { date: newDate });
    moved++;
  }

  return { ok: true, moved, blackoutId: bo.id, mapping: uniqueOldDates.map((d) => ({ from: d, to: mapping[d], count: games.filter((g) => _isoDate(g.date) === d).length })) };
}

// Move every game on `from` to `to` for one (or all) league(s). Unlike rainout,
// this doesn't add a blackout and doesn't cascade — it only touches games on
// the chosen date. Use this when the user knows the target weekend they want
// the games to land on (e.g. "shift July 5 games to July 19").
//
// Pass dry=true to preview without committing.
export function rescheduleDate({ from, to, league = null, dry = false } = {}) {
  const src = _isoDate(from);
  const dst = _isoDate(to);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(src)) return { error: "Invalid `from` date." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dst)) return { error: "Invalid `to` date." };
  if (src === dst) return { ok: true, moved: 0, mapping: [{ from: src, to: dst, count: 0 }] };
  const games = getRecords("game").map((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    return { id: r.id, ...d };
  }).filter((g) => g.date && _isoDate(g.date) === src && (league ? (g.league || "") === league : true));
  if (!games.length) return { ok: true, moved: 0, mapping: [{ from: src, to: dst, count: 0 }] };
  if (dry) return { ok: true, moved: 0, dry: true, mapping: [{ from: src, to: dst, count: games.length }] };
  let moved = 0;
  const blocked = [];
  for (const g of games) {
    const res = updateRecord(g.id, { date: dst }, "user", `rescheduled ${src} → ${dst}`);
    if (res.error) { blocked.push({ id: g.id, reason: res.error }); continue; }
    moved++;
  }
  if (blocked.length && !moved) return { error: blocked[0].reason };
  return {
    ok: true, moved, blocked: blocked.length, blocked_details: blocked.slice(0, 10),
    mapping: [{ from: src, to: dst, count: games.length }],
  };
}

// Preview the rainout shift without committing — for the UI to show what will change.
export function previewRainout({ date, league = null }) {
  const target = _isoDate(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return { error: "Invalid date." };
  const games = getRecords("game").map((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    return { id: r.id, ...d };
  }).filter((g) => g.date && _isoDate(g.date) >= target && (league ? (g.league || "") === league : true));
  const uniqueOldDates = [...new Set(games.map((g) => _isoDate(g.date)))].sort();
  // Include the target itself in the blackout set we're simulating
  const blackoutSet = blackoutDateSet(league);
  blackoutSet.add(target);
  const mapping = {};
  let cursor = target;
  for (const oldDate of uniqueOldDates) {
    cursor = _advance7Skipping(cursor, blackoutSet, false);
    mapping[oldDate] = cursor;
  }
  return {
    ok: true,
    affected: games.length,
    mapping: uniqueOldDates.map((d) => ({ from: d, to: mapping[d], count: games.filter((g) => _isoDate(g.date) === d).length })),
  };
}

// ---------------------------------------------------------------- jersey press clearance
//
// Spec: a player is marked "cleared to press" automatically when:
//   (1) a staff member confirmed their jersey size at check-in (size_confirmed_at)
//   AND
//   (2) the jersey has actually been issued to them            (jersey_issued)
//   AND
//   (3) they attended at least one of the first two weeks of the season
//
// (1) and (2) together are what "size confirmed at check-in" means in practice.
// A size ticked off on a screen is a guess until somebody hands the kid the
// shirt and it fits — the league is about to print a name on it, and reprints
// cost more than one more checkbox at the table.
//
// Stops the league from press-printing custom jerseys for no-shows.
//
// Admin override short-circuits the auto-rule:
//   press_override         — "clear" (force eligible) | "hold" (force ineligible) | ""
//   press_override_reason  — free-text note
//   press_override_by      — actor stamp
//   press_override_at      — epoch ms when set
//
// Status surfaces three buckets — cleared / waiting / hold — matching the FlagsSettings UI.

function _parsePlayerData(r) {
  let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
  return d;
}

export function pressStatusFor(playerId, opts = {}) {
  // opts: { firstWeeks?: Set<weekISO>, byPlayer?: {pid: Set<weekISO>}, data?: parsed player data }
  const row = opts.data ? null : getRow("records", Number(playerId));
  if (!opts.data && (!row || row.type !== "player")) {
    return { cleared: false, status: "waiting", reason: "Player not found.", missing: ["player"], source: "auto" };
  }
  const d = opts.data || _parsePlayerData(row);

  // 1) Override path.
  const override = (d.press_override || "").toLowerCase();
  if (override === "hold") {
    return {
      cleared: false, status: "hold",
      reason: d.press_override_reason || "Held by admin",
      missing: [], source: "override",
    };
  }
  if (override === "clear") {
    return {
      cleared: true, status: "cleared",
      reason: d.press_override_reason || "Cleared by admin",
      missing: [], source: "override",
    };
  }

  // 2) Auto-rule — exactly the two criteria from the spec.
  const firstWeeks = opts.firstWeeks instanceof Set
    ? opts.firstWeeks
    : new Set(seasonWeeks().slice(0, 2));
  const byPlayer = opts.byPlayer || attendanceByPlayer();
  const attended = byPlayer[Number(playerId)] || new Set();
  const attendedFirst = [...firstWeeks].some((w) => attended.has(w));
  const sizeOk = !!d.size_confirmed_at;
  const issuedOk = d.jersey_issued === true;
  const seasonStarted = firstWeeks.size >= 1;

  const missing = [];
  if (!sizeOk) missing.push("size_confirmed");
  if (!issuedOk) missing.push("jersey_issued");
  if (!attendedFirst && seasonStarted) missing.push("first_weeks_attendance");
  if (!seasonStarted) missing.push("season_started");

  if (!missing.length) {
    return { cleared: true, status: "cleared", reason: "Size confirmed + jersey issued + attended", missing: [], source: "auto" };
  }
  const phrases = {
    size_confirmed: "size not confirmed at check-in",
    jersey_issued: "jersey not issued yet",
    first_weeks_attendance: "missed the first two weeks of the season",
    season_started: "season hasn't started",
  };
  const reason = missing.map((k) => phrases[k] || k).join(" · ");
  return { cleared: false, status: "waiting", reason, missing, source: "auto" };
}

export function getPressQueue(league = null) {
  if (!getRecordTypes().some((t) => t.name === "player")) {
    return { cleared: [], waiting: [], hold: [], firstWeeks: [] };
  }
  const firstWeeks = new Set(seasonWeeks().slice(0, 2));
  const byPlayer = attendanceByPlayer();
  const buckets = { cleared: [], waiting: [], hold: [] };
  for (const r of getRecords("player")) {
    const d = _parsePlayerData(r);
    if (league && (d.league || "") !== league && (d.second_league || "") !== league) continue;
    const status = pressStatusFor(r.id, { firstWeeks, byPlayer, data: d });
    const row = {
      id: r.id,
      name: r.name || d.full_name || `#${r.id}`,
      league: d.league || "",
      second_league: d.second_league || "",
      team: d.team || "",
      jersey_size: d.jersey_size || "",
      size_confirmed_at: d.size_confirmed_at || "",
      jersey_issued: d.jersey_issued === true,
      override: d.press_override || "",
      override_reason: d.press_override_reason || "",
      override_by: d.press_override_by || "",
      override_at: d.press_override_at || "",
      status: status.status,
      reason: status.reason,
      missing: status.missing,
      source: status.source,
    };
    (buckets[status.status] || buckets.waiting).push(row);
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name));
  for (const k of Object.keys(buckets)) buckets[k].sort(byName);
  return { ...buckets, firstWeeks: [...firstWeeks] };
}

export function setPressOverride(playerId, override, reason = "") {
  const row = getRow("records", Number(playerId));
  if (!row || row.type !== "player") return { error: "Player not found." };
  const norm = (override || "").toLowerCase();
  if (norm && norm !== "clear" && norm !== "hold") return { error: "Override must be 'clear', 'hold', or empty." };
  const actor = (typeof getActor === "function" ? getActor() : "user");
  const patch = {
    press_override: norm,
    press_override_reason: norm ? (reason || "") : "",
    press_override_by: norm ? actor : "",
    press_override_at: norm ? now() : "",
  };
  const _po = updateRecord(Number(playerId), patch);
  if (_po.error) return { error: _po.error };
  return { ok: true, player_id: Number(playerId), ...patch };
}

// ---------------------------------------------------------------- import master spreadsheet
// Every imported row gets captured here, including columns the system doesn't know about.
// The master is a denormalized union — header row = union of every column ever seen.

export function writeMasterRow({ record_type, source_file, source_district, source_league, season, identity_key, status, player_id, raw_data }) {
  const actor = (typeof getActor === "function" ? getActor() : "user(import)");
  // The master sheet is per season. Every imported row records which season it
  // was imported into, so "the master sheet" always means this season's master
  // sheet unless you deliberately ask for all of them.
  const sn = season != null && String(season).trim() ? String(season).trim() : (seasonForWrite() || null);
  getDb().prepare(
    `INSERT INTO import_master(record_type, source_file, source_district, source_league, season, identity_key, status, player_id, raw_data, imported_at, imported_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    record_type || "player",
    source_file || null,
    source_district || null,
    source_league || null,
    sn,
    identity_key || null,
    status || "added",
    player_id || null,
    JSON.stringify(raw_data || {}),
    now(),
    actor,
  );
}

// `season` defaults to the request's scope. Pass "*" for every season.
function _masterWhere({ record_type = null, district = null, season = undefined } = {}) {
  const where = ["1=1"];
  const params = [];
  if (record_type) { where.push("record_type=?"); params.push(record_type); }
  if (district) { where.push("source_district=?"); params.push(district); }
  const sc = season === undefined ? seasonSql() : seasonSqlFor(season);
  return { sql: where.join(" AND ") + sc.sql, params: [...params, ...sc.params] };
}

export function readMaster({ record_type = null, district = null, season = undefined, limit = 10000 } = {}) {
  const w = _masterWhere({ record_type, district, season });
  const params = [...w.params, Math.max(1, Math.min(50000, Number(limit) || 10000))];
  const rows = getDb().prepare(`SELECT * FROM import_master WHERE ${w.sql} ORDER BY id DESC LIMIT ?`).all(...params);

  // First / last name on every master row. Uploads arrive with the name in
  // whatever shape the district's software exports — one "Player Name" column,
  // separate First/Last columns, or "Last, First". The master sheet shouldn't
  // make you deal with that: it always has a First Name and a Last Name column.
  // A sheet that already had them is believed as-is; otherwise the full name is
  // split (see splitName). If the raw row has no name at all we fall back to the
  // matched player record rather than leaving it blank.
  const linked = new Map();
  const ids = [...new Set(rows.map((r) => r.player_id).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    for (const p of getDb().prepare(
      `SELECT id, name FROM records WHERE id IN (${chunk.map(() => "?").join(",")})`).all(...chunk)) {
      linked.set(p.id, p.name || "");
    }
  }

  return rows.map((r) => {
    let d = {}; try { d = JSON.parse(r.raw_data || "{}"); } catch {}
    const nm = namesFromRow(d, r.player_id ? linked.get(r.player_id) || "" : "");
    return {
      id: r.id, record_type: r.record_type, source_file: r.source_file, source_district: r.source_district,
      source_league: r.source_league, season: r.season || "", identity_key: r.identity_key, status: r.status,
      player_id: r.player_id, imported_at: r.imported_at, imported_by: r.imported_by,
      first_name: nm.first, last_name: nm.last, name_source: nm.source,
      data: d,
    };
  });
}

export function masterColumns(record_type = null, season = undefined) {
  // Union of every column name that's ever appeared in raw_data for this
  // record type IN THIS SEASON — so a column that only existed in an old
  // season's spreadsheet doesn't pad this season's export with empties.
  const w = _masterWhere({ record_type, season });
  const rows = getDb().prepare(`SELECT raw_data FROM import_master WHERE ${w.sql}`).all(...w.params);
  const set = new Set();
  for (const r of rows) { try { const d = JSON.parse(r.raw_data || "{}"); for (const k of Object.keys(d)) set.add(k); } catch {} }
  return [...set].sort();
}

export function masterSummary(record_type = null, season = undefined) {
  const w = _masterWhere({ record_type, season });
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) c FROM import_master WHERE ${w.sql}`).get(...w.params).c;
  const districts = db.prepare(`SELECT source_district, COUNT(*) c FROM import_master WHERE ${w.sql} GROUP BY source_district ORDER BY c DESC`).all(...w.params);
  const files = db.prepare(`SELECT source_file, COUNT(*) c FROM import_master WHERE ${w.sql} GROUP BY source_file ORDER BY c DESC LIMIT 20`).all(...w.params);
  const seasons = db.prepare(`SELECT COALESCE(NULLIF(TRIM(season),''),'(no season)') season, COUNT(*) c FROM import_master ${record_type ? "WHERE record_type=?" : ""} GROUP BY 1 ORDER BY c DESC`).all(...(record_type ? [record_type] : []));
  return { total, districts, files, seasons, columns: masterColumns(record_type, season) };
}
