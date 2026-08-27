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
        <button className={"tab" + (tab === "cleanup" ? " active" : "")} onClick={() => setTab("cleanup")}>Cleanup</button>
      </div>
      {tab === "schema" && <SchemaTab refresh={refresh} />}
      {tab === "rules" && <RulesTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "cleanup" && <CleanupTab />}
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

// Repairs for data written before the app normalized it on the way in. Both preview
// first, both write through the audited path, and both leave locked seasons alone.
function CleanupTab() {
  return (
    <>
      <RepairCard
        title="Extra spaces in imported data"
        blurb={<>Spreadsheets often carry stray spacing — a double space in a name, a trailing space
          after a division. Check-in shows those players because it lists everyone, but the Team
          Editor filters by exact league and division, so they disappear from the board. This trims
          both ends of every text value and collapses double spaces. Notes keep their wording, and
          anything stored as JSON is left untouched.</>}
        preview={() => api.tidyPreview()}
        apply={() => api.tidyApply()}
        verb="Tidied"
        clean="Nothing to clean up — every value is already tidy."
      />
      <RepairCard
        title="Old names left behind after a rename"
        blurb={<>Renaming someone used to update their details but not the display name every screen
          reads first — so the old name kept showing on coach pills, check-in and the coach-to-player
          links. New renames stay in step on their own; this fixes people renamed before that.</>}
        preview={() => api.resyncNamesPreview()}
        apply={() => api.resyncNames()}
        verb="Updated"
        clean="Every record already shows its current name."
      />
    </>
  );
}

// Shared shell for the repair tools: preview first, then apply. Every write goes
// through the audited path, so History can undo them one by one and Time Machine
// can rewind the whole batch in one action.
function RepairCard({ title, blurb, preview, apply, verb, clean }) {
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);

  async function run(doApply) {
    setBusy(true); setFlash(null);
    const r = doApply ? await apply() : await preview();
    setBusy(false);
    if (r && r.error) { setFlash({ ok: false, text: r.error }); return; }
    setRes(r);
    if (doApply) setFlash({ ok: true, text: `${verb} ${r.changed} record${r.changed === 1 ? "" : "s"}. Undo any of them from History, or rewind the lot in Time Machine.` });
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <p className="muted">{blurb}</p>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      <div className="btn-row">
        <button className="btn" disabled={busy} onClick={() => run(false)}>{busy ? "Scanning…" : "Preview changes"}</button>
        <button className="btn primary" disabled={busy || !res || !res.changed} onClick={() => run(true)}>Apply</button>
      </div>
      {res && (
        <div style={{ marginTop: 12 }}>
          <div className="muted small">
            Scanned {res.scanned} records · {res.changed} to fix
            {res.skippedLocked ? ` · ${res.skippedLocked} skipped in locked seasons` : ""}.
          </div>
          {!res.changed && <p className="muted" style={{ marginTop: 8 }}>{clean}</p>}
          {res.changed > 0 && (
            <table className="tbl" style={{ marginTop: 8 }}>
              <thead><tr><th>Record</th><th>Before</th><th>After</th></tr></thead>
              <tbody>
                {res.changes.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name} <span className="muted small">#{c.id} · {c.type}</span></td>
                    <td className="muted small">{c.before}</td>
                    <td className="small">{c.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {res.truncated && <div className="muted small" style={{ marginTop: 6 }}>Showing the first 300 — Apply fixes all of them.</div>}
        </div>
      )}
    </div>
  );
}
