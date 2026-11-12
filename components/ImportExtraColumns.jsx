"use client";
// Upload step: the columns in the file that aren't matched to any field yet.
// For each one you can leave it out, send it into an existing field, or make
// a brand-new field from it (named after the column) — so nothing in a
// registration export has to be lost just because there's no field for it.
//
// Used by both upload screens (Players & Coaches → Import, and Home's
// "Import players"). The new field is created right away; the import itself
// still happens when you press Import.
import { useState } from "react";
import { api } from "@/lib/api.js";
import { PREDICTED_FIELDS, HEADER_ALIASES, normHeader } from "@/lib/import-helpers.js";

// Name columns are read automatically (First / Last / Full Name), even when
// they aren't matched in the grid — so they never count as "not matched".
const NAME_HEADERS = new Set(["first_name", "last_name", "full_name"]
  .flatMap((f) => (HEADER_ALIASES[f] || []).concat(f.replace(/_/g, " ")))
  .map(normHeader));

const TYPES = [
  ["text", "Text"],
  ["number", "Number"],
  ["date", "Date"],
  ["bool", "Yes / No"],
];

// A few non-blank sample values from the column, to help decide what it is.
function samples(rows, col) {
  const out = [];
  for (const r of rows || []) {
    const v = r && r[col];
    if (v == null || String(v).trim() === "") continue;
    const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
    if (!out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out;
}

// A guess at the type from the sample values: all numbers → Number, all dates → Date.
function guessType(rows, col) {
  const vals = samples(rows, col);
  if (!vals.length) return "text";
  if (vals.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return "number";
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(v))) return "date";
  return "text";
}

export default function ImportExtraColumns({ type, fields, rows, columns, mapping, setMapping, onFieldAdded, setFlash }) {
  const [open, setOpen] = useState(true);
  const used = new Set(Object.values(mapping || {}).filter((v) => v && v !== "(skip)"));
  const unused = (columns || []).filter((c) => !used.has(c) && !NAME_HEADERS.has(normHeader(c)));
  if (!unused.length) return null;
  // League / township / key tag are set by the site (rules, township picker),
  // not from a file column — same as the main matching grid's defaults.
  const freeFields = (fields || []).filter((f) => !PREDICTED_FIELDS.has(f.name) && (!mapping[f.name] || mapping[f.name] === "(skip)"));

  return (
    <div className="card" style={{ marginTop: 14, background: "var(--line-soft)" }}>
      <div className="between" style={{ alignItems: "center" }}>
        <div>
          <b>Columns not matched yet ({unused.length})</b>
          <div className="muted small">These won't be imported unless you match them to a field or make a new field for them.</div>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => setOpen((o) => !o)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (
        <div className="stack" style={{ marginTop: 10, gap: 8 }}>
          {unused.map((c) => (
            <ColumnRow key={c} type={type} col={c} rows={rows} freeFields={freeFields}
              onMap={(fieldName) => setMapping({ ...mapping, [fieldName]: c })}
              onFieldAdded={onFieldAdded} setFlash={setFlash} />
          ))}
        </div>
      )}
    </div>
  );
}

function ColumnRow({ type, col, rows, freeFields, onMap, onFieldAdded, setFlash }) {
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState(col);
  const [dtype, setDtype] = useState(() => guessType(rows, col));
  const [busy, setBusy] = useState(false);
  const ex = samples(rows, col);

  async function create() {
    const lb = label.trim();
    if (!lb) return setFlash && setFlash({ ok: false, text: "Give the new field a name." });
    setBusy(true);
    try {
      const res = await api.addField({ record_type: type, name: lb, label: lb, data_type: dtype });
      if (!res || res.error) return setFlash && setFlash({ ok: false, text: (res && res.error) || "Couldn't add the field." });
      const f = { name: res.field, label: res.label || lb, data_type: res.data_type || dtype };
      onFieldAdded && onFieldAdded(f);
      onMap(res.field);
      setFlash && setFlash({ ok: true, text: res.status === "exists"
        ? `There's already a field for that ("${res.label || res.field}") — the "${col}" column now goes into it.`
        : `Added the field "${lb}". The "${col}" column will be imported into it.` });
      setMaking(false);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
      <div className="between" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ minWidth: 180, flex: 1 }}>
          <b>{col}</b>
          {ex.length > 0 && <div className="muted small">e.g. {ex.join(", ")}</div>}
        </div>
        {!making && (
          <div className="btn-row" style={{ alignItems: "center" }}>
            {freeFields.length > 0 && (
              <select value="" onChange={(e) => { if (e.target.value) onMap(e.target.value); }} style={{ width: "auto" }}>
                <option value="">Put into a field…</option>
                {freeFields.map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
              </select>
            )}
            <button type="button" className="btn sm" onClick={() => setMaking(true)}>+ New field</button>
          </div>
        )}
      </div>
      {making && (
        <div className="addbar" style={{ marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="text" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Field name"
            onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") setMaking(false); }} style={{ flex: 1, minWidth: 180 }} />
          <select value={dtype} onChange={(e) => setDtype(e.target.value)} style={{ width: "auto" }}>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button type="button" className="btn primary" disabled={busy} onClick={create}>{busy ? "Adding…" : "Add field"}</button>
          <button type="button" className="btn ghost" onClick={() => setMaking(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
