"use client";
import { useState } from "react";

// Renders one input from a field definition — the self-rendering core, in React.
export default function FieldInput({ field, value, onChange, suggest }) {
  const label = (field.label || field.name) + (field.required ? " *" : "");
  const dt = field.data_type;

  if (dt === "number") {
    return (
      <div>
        <label className="fld">{label}</label>
        <input type="number" value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />
      </div>
    );
  }
  if (dt === "bool") {
    return (
      <div>
        <label className="fld" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={!!value} style={{ width: "auto" }}
            onChange={(e) => onChange(e.target.checked)} />
          {field.label || field.name}
        </label>
      </div>
    );
  }
  if (dt === "date") {
    return (
      <div>
        <label className="fld">{label}</label>
        <input type="date" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} />
      </div>
    );
  }
  if (dt === "select") {
    let opts = [];
    try { opts = field.options ? JSON.parse(field.options) : []; } catch {}
    return (
      <div>
        <label className="fld">{label}</label>
        <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }
  // text — with optional name suggestions (first or last name) as you type
  if (Array.isArray(suggest) && suggest.length) {
    return (
      <div>
        <label className="fld">{label}</label>
        <Typeahead value={value} onChange={onChange} options={suggest} />
      </div>
    );
  }
  return (
    <div>
      <label className="fld">{label}</label>
      <input type="text" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// Suggests matching names as the user types. Matches a substring anywhere, or the start
// of any word (so typing a last name suggests too). Supports multiple names separated by commas.
function Typeahead({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const raw = String(value ?? "");
  // suggest against the part after the last comma, so "Ava Cole, Be" suggests on "Be"
  const ci = raw.lastIndexOf(",");
  const prefix = ci >= 0 ? raw.slice(0, ci + 1) + " " : "";
  const term = (ci >= 0 ? raw.slice(ci + 1) : raw).trim().toLowerCase();

  const matches = term
    ? options.filter((o) => {
        const ol = o.toLowerCase();
        return ol.includes(term) || o.split(/\s+/).some((w) => w.toLowerCase().startsWith(term));
      }).slice(0, 8)
    : [];

  return (
    <div className="typeahead">
      <input type="text" value={raw} autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && matches.length > 0 && (
        <div className="typeahead-pop">
          {matches.map((m) => (
            <div key={m} className="typeahead-item" onMouseDown={(e) => { e.preventDefault(); onChange(prefix + m); setOpen(false); }}>{m}</div>
          ))}
        </div>
      )}
    </div>
  );
}
