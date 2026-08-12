// The backend toolbox — the same functions the AI calls and the UI uses.
// No arbitrary writes: every change is a named function that logs to the audit trail.
import { getDb, getRow, logAudit, now } from "./db.js";
import { getActor } from "./actor.js";
import { buildSchedule, weekDate, clockTime, placeOnFields } from "./schedule.js";
import { HEADER_ALIASES, normHeader } from "./import-helpers.js";
import { getSetting } from "./memory.js";

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
  // sort into a division by league + age (FR-2.1)
  if (rtype === "player") { const dv = assignDivision(data); if (dv && !data.division) data.division = dv; }
  // Every new player belongs to the current season unless one was given
  // explicitly (the import screen's season picker passes it). Keeps manually
  // added and AI-created players from floating across seasons untagged.
  if (rtype === "player" && !hasValue(data.season)) {
    try { const sn = getSetting("active_season", null); if (sn) data.season = sn; } catch {}
  }
  const d = getDb();
  const info = d.prepare("INSERT INTO records(type,name,data,created_at) VALUES(?,?,?,?)")
    .run(rtype, rname, JSON.stringify(data), now());
  const row = getRow("records", info.lastInsertRowid);
  logAudit(actor, "create", "records", info.lastInsertRowid, null, row, "created record");
  return { status: "created", id: Number(info.lastInsertRowid), type: rtype, name: rname };
}

export function updateRecord(id, fields = {}, actor = "user") {
  const before = getRow("records", id);
  if (!before) return { error: `no record #${id}` };
  const merged = { ...JSON.parse(before.data || "{}"), ...fields };
  getDb().prepare("UPDATE records SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(merged), now(), id);
  logAudit(actor, "update", "records", id, before, getRow("records", id), "updated record");
  return { status: "updated", id };
}

export function deleteRecord(id, actor = "user") {
  const before = getRow("records", id);
  if (!before) return { error: `no record #${id}` };
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
  for (const r of targets) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if ((d[field] == null ? "" : String(d[field])) === (value == null ? "" : String(value))) { unchanged++; continue; }
    const before = { ...d };
    d[field] = value;
    const json = JSON.stringify(d);
    getDb().prepare("UPDATE records SET data=?, updated_at=? WHERE id=?").run(json, now(), r.id);
    logAudit("user(bulk)", "update", "records", r.id, { ...r, data: JSON.stringify(before) }, { ...r, data: json }, `bulk set ${field}`);
    updated++;
  }
  return { status: "ok", updated, unchanged, total: targets.length };
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
  for (const rec of all) {
    if (!overwrite && rec.data[field] != null && rec.data[field] !== "") { skipped++; continue; }
    const value = String(n);
    const before = { ...rec.data };
    const data = { ...rec.data, [field]: value };
    const json = JSON.stringify(data);
    getDb().prepare("UPDATE records SET data=?, updated_at=? WHERE id=?").run(json, now(), rec.id);
    logAudit("user(sequence)", "update", "records", rec.id, { id: rec.id, data: JSON.stringify(before) }, { id: rec.id, data: json }, `sequenced ${field}=${value}`);
    assigned++;
    n += inc;
  }
  return { status: "ok", assigned, skipped, total: all.length, next: n };
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
      const before = { ...data };
      const after = { ...data, ...patch };
      getDb().prepare("UPDATE records SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(after), now(), r.id);
      logAudit("user(reassign)", "update", "records", r.id, { ...r, data: JSON.stringify(before) }, { ...r, data: JSON.stringify(after) }, "reassigned by rules");
      changes.push({ id: r.id, name: r.name, patch });
      updated++;
    }
  }
  return { scanned: recs.length, updated, fields: byField, changes };
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
  for (const r of getRecords(rtype)) {
    let dd = {}; try { dd = JSON.parse(r.data || "{}"); } catch { continue; }
    if (dd[fname] !== from) continue;
    const before = { ...dd };
    dd[fname] = to;
    const json = JSON.stringify(dd);
    d.prepare("UPDATE records SET data=?, updated_at=? WHERE id=?").run(json, now(), r.id);
    logAudit("user", "update", "records", r.id, { ...r, data: JSON.stringify(before) }, { ...r, data: json }, `renamed choice '${from}' → '${to}'`);
    migrated++;
  }
  logAudit("user", "update", "fields", row.id, { ...row }, { ...row, options: JSON.stringify(opts) }, `renamed choice '${from}' → '${to}'`);
  return { status: "renamed", field: fname, from, to, migrated, options: opts };
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
  return { status: "ready", record_type: "attendance" };
}

export function getCheckins(week) {
  if (!getRecordTypes().some((t) => t.name === "attendance")) return new Set();
  const ids = new Set();
  for (const r of getRecords("attendance")) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    if (String(d.week) === String(week) && d.player_id != null) ids.add(Number(d.player_id));
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
export function seasonWeeks() {
  const set = new Set();
  for (const r of getRecords("game")) { const w = _weekStartISO(_pdata(r).date); if (w) set.add(w); }
  if (!set.size) for (const r of getRecords("attendance")) { const w = _pdata(r).week; if (w) set.add(String(w)); }
  return [...set].sort();
}
// player_id -> Set of weeks attended
export function attendanceByPlayer() {
  const by = {};
  for (const r of getRecords("attendance")) { const d = _pdata(r); const id = Number(d.player_id); if (id && d.week) (by[id] = by[id] || new Set()).add(String(d.week)); }
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

export function setCheckin(playerId, playerName, week, present) {
  seedAttendance();
  const pid = Number(playerId);
  const existing = getRecords("attendance").filter((r) => {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch {}
    return Number(d.player_id) === pid && String(d.week) === String(week);
  });
  if (present) {
    if (!existing.length) createRecord("attendance", { player_id: pid, player: playerName || "", week: String(week) }, `${playerName || pid} — ${week}`);
    return { status: "checked_in" };
  }
  for (const r of existing) deleteRecord(r.id, "user");
  return { status: "checked_out" };
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
export const getRecords = (t) => getDb().prepare("SELECT * FROM records WHERE type=? ORDER BY id").all(slug(t));
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
    if (dv && (p.division || "") !== dv) return false;
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
// Lenient season check for reads: untagged records show under every season.
// (Writes and deletes stay STRICT — see saveSchedule.)
function _seasonOk(d, season) {
  if (!season) return true;
  const s = d && d.season ? String(d.season) : "";
  return !s || s === String(season);
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
  for (const r of getRecords("game")) {
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
export function pruneCrossDivisionGames(league = null) {
  const games = getRecords("game");
  let removed = 0;
  const examples = [];
  for (const r of games) {
    let d = {}; try { d = JSON.parse(r.data || "{}"); } catch { continue; }
    if (league && (d.league || "") !== league) continue;
    const hd = _divisionOfTeam(d.home_team || "");
    const ad = _divisionOfTeam(d.away_team || "");
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
  const teamsByDiv = new Map();
  for (const t of teams) {
    const dv = _divisionOfTeam(t);
    if (!teamsByDiv.has(dv)) teamsByDiv.set(dv, []);
    teamsByDiv.get(dv).push(t);
  }
  const realDivisions = [...teamsByDiv.keys()].filter((d) => !!d);
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

export function getLeagueLocks() {
  return getDb().prepare("SELECT league, locked, locked_at, locked_by FROM league_locks").all()
    .map((r) => ({ league: r.league, locked: !!r.locked, locked_at: r.locked_at, locked_by: r.locked_by }));
}

export function isLeagueLocked(league) {
  if (!league) return false;
  const row = getDb().prepare("SELECT locked FROM league_locks WHERE league=?").get(league);
  return !!(row && row.locked);
}

export function setLeagueLock(league, locked, actor = null) {
  if (!league) return { error: "League name required." };
  const a = actor || (typeof getActor === "function" ? getActor() : "user");
  getDb().prepare(
    `INSERT INTO league_locks(league, locked, locked_at, locked_by) VALUES(?,?,?,?)
     ON CONFLICT(league) DO UPDATE SET locked=excluded.locked, locked_at=excluded.locked_at, locked_by=excluded.locked_by`
  ).run(league, locked ? 1 : 0, now(), a);
  logAudit(a, locked ? "lock_league" : "unlock_league", "league_locks", null, null, { league, locked: !!locked }, "");
  return { ok: true, league, locked: !!locked };
}

export function movePlayer(id, changes) {
  const player = getRow("records", id);
  if (!player || player.type !== "player") return { error: "Player not found." };
  let data = {}; try { data = JSON.parse(player.data || "{}"); } catch {}

  const before = { league: data.league || "", second_league: data.second_league || "", division: data.division || "" };
  const after = { ...before };

  if (Object.prototype.hasOwnProperty.call(changes, "league")) after.league = changes.league || "";
  if (Object.prototype.hasOwnProperty.call(changes, "second_league")) after.second_league = changes.second_league || "";
  if (Object.prototype.hasOwnProperty.call(changes, "division")) after.division = changes.division || "";

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

  const updates = {};
  if (after.league !== before.league) updates.league = after.league;
  if (after.second_league !== before.second_league) updates.second_league = after.second_league;
  if (after.division !== before.division) updates.division = after.division;
  if (!Object.keys(updates).length) return { ok: true, unchanged: true, after };

  updateRecord(id, updates);
  return { ok: true, before, after };
}

export function bulkMovePlayers(ids, changes, mode = "set") {
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
    }
    const res = movePlayer(Number(id), effective);
    if (res.error) blocked.push({ id, reason: res.error });
    else moved.push({ id, before: res.before, after: res.after });
  }
  return { moved: moved.length, blocked, details: moved };
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
  updateRecord(Number(gameId), patch);
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
  updateRecord(Number(gameId), patch);
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
  updateRecord(Number(gameId), patch);
  return { ok: true, gameId: Number(gameId), winner, home_score: home, away_score: away };
}

export function clearGameScore(gameId) {
  const row = getRow("records", Number(gameId));
  if (!row || row.type !== "game") return { error: "Game not found." };
  updateRecord(Number(gameId), { home_score: "", away_score: "", winner: "", score_at: "", score_by: "", score_note: "" });
  return { ok: true, gameId: Number(gameId) };
}

export function getStandings(league = null, season = null) {
  // Roll up wins / losses / ties / points for / points against per team.
  if (!getRecordTypes().some((t) => t.name === "game")) return [];
  const teams = {}; // name -> { team, league, wins, losses, ties, pf, pa, played }
  const ensure = (team, lg) => (teams[team] = teams[team] || { team, league: lg || "", wins: 0, losses: 0, ties: 0, pf: 0, pa: 0, played: 0 });
  for (const r of getRecords("game")) {
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

export function listBlackouts(league = null) {
  const db = getDb();
  const rows = league
    ? db.prepare("SELECT * FROM schedule_blackouts WHERE league=? OR league='' OR league IS NULL ORDER BY date").all(league)
    : db.prepare("SELECT * FROM schedule_blackouts ORDER BY date").all();
  return rows.map((r) => ({ id: r.id, date: _isoDate(r.date), league: r.league || "", reason: r.reason || "", created_at: r.created_at, created_by: r.created_by }));
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
  // Avoid duplicates; UPSERT semantics
  const existing = db.prepare("SELECT id FROM schedule_blackouts WHERE date=? AND COALESCE(league,'')=?").get(d, lg);
  let blackoutId;
  if (existing) {
    if (reason) db.prepare("UPDATE schedule_blackouts SET reason=? WHERE id=?").run(reason, existing.id);
    blackoutId = existing.id;
  } else {
    const actor = (typeof getActor === "function" ? getActor() : "user");
    const info = db.prepare(
      "INSERT INTO schedule_blackouts(date, league, reason, created_at, created_by) VALUES(?,?,?,?,?)"
    ).run(d, lg, reason || null, now(), actor);
    logAudit(actor, "create", "schedule_blackouts", info.lastInsertRowid, null, { date: d, league: lg, reason }, "");
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
    for (const g of games) { updateRecord(g.id, { date: movedTo }, "user(blackout)"); moved++; }
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
  for (const g of games) { updateRecord(g.id, { date: dst }); moved++; }
  return { ok: true, moved, mapping: [{ from: src, to: dst, count: games.length }] };
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
//   (1) they confirmed their jersey size at check-in   (size_confirmed_at set)
//   AND
//   (2) they attended at least one of the first two weeks of the season
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
  const seasonStarted = firstWeeks.size >= 1;

  const missing = [];
  if (!sizeOk) missing.push("size_confirmed");
  if (!attendedFirst && seasonStarted) missing.push("first_weeks_attendance");
  if (!seasonStarted) missing.push("season_started");

  if (!missing.length) {
    return { cleared: true, status: "cleared", reason: "Attended + size confirmed", missing: [], source: "auto" };
  }
  const phrases = {
    size_confirmed: "size not confirmed at check-in",
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
  updateRecord(Number(playerId), patch);
  return { ok: true, player_id: Number(playerId), ...patch };
}

// ---------------------------------------------------------------- import master spreadsheet
// Every imported row gets captured here, including columns the system doesn't know about.
// The master is a denormalized union — header row = union of every column ever seen.

export function writeMasterRow({ record_type, source_file, source_district, source_league, identity_key, status, player_id, raw_data }) {
  const actor = (typeof getActor === "function" ? getActor() : "user(import)");
  getDb().prepare(
    `INSERT INTO import_master(record_type, source_file, source_district, source_league, identity_key, status, player_id, raw_data, imported_at, imported_by)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    record_type || "player",
    source_file || null,
    source_district || null,
    source_league || null,
    identity_key || null,
    status || "added",
    player_id || null,
    JSON.stringify(raw_data || {}),
    now(),
    actor,
  );
}

export function readMaster({ record_type = null, district = null, limit = 10000 } = {}) {
  const where = [];
  const params = [];
  if (record_type) { where.push("record_type=?"); params.push(record_type); }
  if (district) { where.push("source_district=?"); params.push(district); }
  const sql = "SELECT * FROM import_master" + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY id DESC LIMIT ?";
  params.push(Math.max(1, Math.min(50000, Number(limit) || 10000)));
  const rows = getDb().prepare(sql).all(...params);
  return rows.map((r) => {
    let d = {}; try { d = JSON.parse(r.raw_data || "{}"); } catch {}
    return {
      id: r.id, record_type: r.record_type, source_file: r.source_file, source_district: r.source_district,
      source_league: r.source_league, identity_key: r.identity_key, status: r.status, player_id: r.player_id,
      imported_at: r.imported_at, imported_by: r.imported_by, data: d,
    };
  });
}

export function masterColumns(record_type = null) {
  // Union of every column name that's ever appeared in raw_data for the given record_type.
  const where = record_type ? "WHERE record_type=?" : "";
  const params = record_type ? [record_type] : [];
  const rows = getDb().prepare(`SELECT raw_data FROM import_master ${where}`).all(...params);
  const set = new Set();
  for (const r of rows) { try { const d = JSON.parse(r.raw_data || "{}"); for (const k of Object.keys(d)) set.add(k); } catch {} }
  return [...set].sort();
}

export function masterSummary(record_type = null) {
  const where = record_type ? "WHERE record_type=?" : "";
  const params = record_type ? [record_type] : [];
  const total = getDb().prepare(`SELECT COUNT(*) c FROM import_master ${where}`).get(...params).c;
  const districts = getDb().prepare(`SELECT source_district, COUNT(*) c FROM import_master ${where} GROUP BY source_district ORDER BY c DESC`).all(...params);
  const files = getDb().prepare(`SELECT source_file, COUNT(*) c FROM import_master ${where} GROUP BY source_file ORDER BY c DESC LIMIT 20`).all(...params);
  return { total, districts, files, columns: masterColumns(record_type) };
}
