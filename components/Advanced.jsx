"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { friendlyAudit } from "@/lib/ui.js";

const TYPES = ["text", "number", "date", "bool", "select"];

export default function Advanced({ refresh }) {
  const [tab, setTab] = useState("schema");
  return (
    <div>
      <div className="page-head"><h1>Advanced</h1><div className="muted">Power-user tools — most days you won’t need these.</div></div>
      <div className="tabs">
        <button className={"tab" + (tab === "schema" ? " active" : "")} onClick={() => setTab("schema")}>Schema</button>
        <button className={"tab" + (tab === "rules" ? " active" : "")} onClick={() => setTab("rules")}>Rules</button>
        <button className={"tab" + (tab === "history" ? " active" : "")} onClick={() => setTab("history")}>History</button>
      </div>
      {tab === "schema" && <SchemaTab refresh={refresh} />}
      {tab === "rules" && <RulesTab />}
      {tab === "history" && <HistoryTab />}
    </div>
  );
}

function SchemaTab({ refresh }) {
  const [schema, setSchema] = useState({});
  const [rt, setRt] = useState("");
  const [name, setName] = useState("");
  const [dtype, setDtype] = useState("text");
  const [req, setReq] = useState(false);
  const [opts, setOpts] = useState("");
  const [flash, setFlash] = useState(null);

  async function load() { const s = await api.schema(); setSchema(s.schema || {}); }
  useEffect(() => { load(); }, []);
  const types = Object.keys(schema);
  useEffect(() => { if (!rt && types.length) setRt(types[0]); }, [schema]); // eslint-disable-line

  async function addField() {
    if (!rt || !name.trim()) { setFlash({ ok: false, text: "Pick a section and enter a field name." }); return; }
    const options = dtype === "select" ? opts.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const res = await api.addField({ record_type: rt, name: name.trim(), data_type: dtype, required: req, options });
    setFlash(res.error ? { ok: false, text: res.error } : { ok: true, text: "Field added." });
    setName(""); setOpts(""); await load(); refresh && refresh();
  }

  return (
    <div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      {!types.length && <div className="card"><p className="muted">No sections yet — build some in Build &amp; Ask.</p></div>}
      {types.map((t) => (
        <div className="card" key={t}>
          <h3>{schema[t].label} <span className="muted small">· {t}</span></h3>
          <table className="tbl">
            <thead><tr><th>field</th><th>type</th><th>choices</th></tr></thead>
            <tbody>
              {schema[t].fields.map((f) => (
                <tr key={f.name}><td>{f.name}</td><td>{f.type}</td><td className="muted">{(f.options || []).join(", ")}</td></tr>
              ))}
              {!schema[t].fields.length && <tr><td colSpan={3} className="muted">No fields yet.</td></tr>}
            </tbody>
          </table>
        </div>
      ))}
      {types.length > 0 && (
        <div className="card">
          <h3>Add a field by hand</h3>
          <div className="row">
            <div><label className="fld">Section</label>
              <select value={rt} onChange={(e) => setRt(e.target.value)}>{types.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
            <div><label className="fld">Field name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><label className="fld">Type</label>
              <select value={dtype} onChange={(e) => setDtype(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
          </div>
          {dtype === "select" && <><label className="fld">Choices (comma-separated)</label><input value={opts} onChange={(e) => setOpts(e.target.value)} /></>}
          <label className="small" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={req} onChange={(e) => setReq(e.target.checked)} /> Required
          </label>
          <div className="btn-row" style={{ marginTop: 12 }}><button className="btn primary" onClick={addField}>Add field</button></div>
        </div>
      )}
    </div>
  );
}

function RulesTab() {
  const [rules, setRules] = useState([]);
  async function load() { const r = await api.rules(); setRules(r.rules || []); }
  useEffect(() => { load(); }, []);
  return (
    <div>
      {!rules.length && <div className="card"><p className="muted">No rules yet.</p></div>}
      {rules.map((r) => (
        <div className="card" key={r.id}>
          <div className="between">
            <div><b>{r.name}</b> <span className="muted small">· {r.kind}</span></div>
            <div className="btn-row">
              <button className="btn sm" onClick={async () => { await api.ruleAction({ action: "toggle", id: r.id, active: !r.active }); await load(); }}>
                {r.active ? "On" : "Off"}
              </button>
              <button className="btn ghost sm" onClick={async () => { await api.ruleAction({ action: "delete", id: r.id }); await load(); }}>Delete</button>
            </div>
          </div>
          <pre className="diff" style={{ marginTop: 8 }}>{`WHEN ${r.condition}\nTHEN ${r.action}`}</pre>
        </div>
      ))}
    </div>
  );
}

function HistoryTab() {
  const [entries, setEntries] = useState([]);
  async function load() { const r = await api.history(); setEntries(r.entries || []); }
  useEffect(() => { load(); }, []);
  return (
    <div className="card">
      <p className="muted small">Every change is logged. Undo reverses a single change.</p>
      <div className="stack">
        {entries.map((e) => (
          <div className="between" key={e.id} style={{ borderBottom: "1px solid var(--line-soft)", paddingBottom: 6 }}>
            <div className="small"><span className="kv">#{e.id}</span> {friendlyAudit(e)} <span className="muted">· {e.created_at}</span></div>
            {!e.undone && ["create", "update", "delete"].includes(e.action) && (
              <button className="btn ghost sm" onClick={async () => { await api.undoOne(e.id); await load(); }}>Undo</button>
            )}
          </div>
        ))}
        {!entries.length && <div className="muted small">No changes yet.</div>}
      </div>
    </div>
  );
}
