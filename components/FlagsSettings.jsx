"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";

const OP_LABEL = { empty: "is empty", not_empty: "is not empty", "==": "equals", "!=": "is not", ">=": "is at least", "<=": "is at most", ">": "is more than", "<": "is less than" };
const needsValue = (op) => !(op === "empty" || op === "not_empty");

const FLAG_ICO = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
  </svg>
);

// Dashboard flags (watch-for counts shown on Home). Lives on Leagues & Assignment.
export default function FlagsSettings({ onAsk }) {
  const [cfg, setCfg] = useState(null);
  const [flash, setFlash] = useState(null);
  const [aiText, setAiText] = useState("");
  const [rt, setRt] = useState("");
  const [field, setField] = useState("");
  const [op, setOp] = useState("empty");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");

  async function load() {
    const c = await api.flags();
    setCfg(c);
    if (!rt && c.types?.length) { setRt(c.types[0].name); setField(c.types[0].fields[0]?.name || ""); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  if (!cfg || cfg.error) return null;

  const sections = cfg.types || [];
  const ops = cfg.ops || ["empty", "not_empty", "==", "!=", ">=", "<=", ">", "<"];
  const fieldsOf = (name) => (sections.find((s) => s.name === name)?.fields) || [];
  const fieldLabel = (name, fname) => fieldsOf(name).find((f) => f.name === fname)?.label || fname;
  const condText = (f) => {
    if (f.kind === "attendance") return `attended none of the first ${f.weeks || 2} weeks`;
    const base = `${fieldLabel(f.record_type, f.field)} ${OP_LABEL[f.op] || f.op}`;
    return needsValue(f.op) ? `${base} ${f.value}` : base;
  };
  async function addJerseyHold() {
    const res = await api.flagJerseyHold();
    setFlash({ ok: true, text: res.status === "exists" ? "That flag is already set up." : "Added — players who miss the first 2 weeks now show on Home (hold their jersey)." });
    await load();
  }

  function onSection(name) { setRt(name); setField(fieldsOf(name)[0]?.name || ""); }
  async function addFlag() {
    if (!rt || !field) return setFlash({ ok: false, text: "Pick a section and a detail." });
    const res = await api.flagAdd({ label: label.trim(), record_type: rt, field, op, value: needsValue(op) ? value.trim() : "" });
    if (res.error) return setFlash({ ok: false, text: res.error });
    setFlash({ ok: true, text: "Flag added — it shows on Home." });
    setLabel(""); setValue(""); await load();
  }
  function submitAi() {
    const t = aiText.trim();
    if (!t) return;
    if (onAsk) onAsk(`Create a dashboard flag: ${t}`);
    setAiText("");
  }

  return (
    <>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      <div className="card">
        <h2>Home flags</h2>
        <p className="muted small">Each flag shows a live count on the Home “At a glance” row — a quick way to watch for things like players with no league.</p>
        <div className="rule-list">
          {cfg.flags.map((f) => (
            <div className={"rule-row" + (f.active ? "" : " off")} key={f.id}>
              <div className="rule-ico kt">{FLAG_ICO}</div>
              <div className="rule-main">
                <div className="nm">{f.label} <span className="chip" style={{ marginLeft: 4 }}>{f.count}</span></div>
                <div className="ty">{f.record_type} · {condText(f)}</div>
              </div>
              <button className={"switch" + (f.active ? " on" : "")} aria-label={f.active ? "On" : "Off"}
                title={f.active ? "On — click to turn off" : "Off — click to turn on"}
                onClick={async () => { await api.flagToggle(f.id, !f.active); load(); }} />
              <button className="btn ghost sm" onClick={async () => { await api.flagDel(f.id); load(); }}>Delete</button>
            </div>
          ))}
          {!cfg.flags.length && <div className="muted small" style={{ marginTop: 4 }}>No flags yet — add one below.</div>}
        </div>
      </div>

      <div className="card">
        <h3>Add a flag</h3>
        <div className="note info" style={{ marginBottom: 12 }}>
          <div className="between" style={{ flexWrap: "wrap", gap: 8 }}>
            <span>Attendance: flag players who missed the first 2 weeks — they may have dropped out, so hold their custom jersey.</span>
            <button className="btn sm" onClick={addJerseyHold}>Add jersey-hold flag</button>
          </div>
        </div>
        <div className="row">
          <div>
            <label className="fld">Section</label>
            <select value={rt} onChange={(e) => onSection(e.target.value)}>
              {sections.map((s) => <option key={s.name} value={s.name}>{s.label || s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Detail</label>
            <select value={field} onChange={(e) => setField(e.target.value)}>
              {fieldsOf(rt).map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Condition</label>
            <select value={op} onChange={(e) => setOp(e.target.value)}>
              {ops.map((o) => <option key={o} value={o}>{OP_LABEL[o] || o}</option>)}
            </select>
          </div>
          {needsValue(op) && (
            <div>
              <label className="fld">Value</label>
              <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 13" />
            </div>
          )}
        </div>
        <label className="fld">Label (shown on Home)</label>
        <div className="addbar">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Missing jersey size" />
          <button className="btn primary" onClick={addFlag}>Add flag</button>
        </div>

        <div className="aibox" style={{ marginTop: 18 }}>
          <div className="aibox-head"><span className="ai-badge">S-Dot</span> Add a flag with S-Dot</div>
          <p className="muted small">Describe it — e.g. “flag players with no jersey size” or “players age 13 or older”. S-Dot drafts it and you confirm.</p>
          <div className="aibar">
            <input placeholder="Describe a flag…" value={aiText} onChange={(e) => setAiText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAi(); }} />
            <button className="btn primary" onClick={submitAi}>Create with S-Dot</button>
          </div>
        </div>
      </div>

      <PressQueueCard />
    </>
  );
}

function PressQueueCard() {
  const [data, setData] = useState({ cleared: [], waiting: [], hold: [], firstWeeks: [] });
  const [tab, setTab] = useState("waiting");
  const [busy, setBusy] = useState({});
  const [reasonDraft, setReasonDraft] = useState({}); // pid -> string

  async function load() {
    const r = await api.pressList(null);
    setData({ cleared: r.cleared || [], waiting: r.waiting || [], hold: r.hold || [], firstWeeks: r.firstWeeks || [] });
  }
  useEffect(() => { load(); }, []);

  async function setOverride(p, override) {
    setBusy((b) => ({ ...b, [p.id]: true }));
    const reason = reasonDraft[p.id] || "";
    const res = await api.pressSetOverride(p.id, override, reason);
    setBusy((b) => ({ ...b, [p.id]: false }));
    if (res && res.error) { alert(res.error); return; }
    await load();
  }

  // Human-readable label for each missing-criterion key the backend returns.
  const MISSING_LABEL = {
    size_confirmed: "size not confirmed",
    first_weeks_attendance: "missed first two weeks",
    season_started: "season hasn't started",
  };

  const rows = data[tab] || [];
  const renderRow = (p) => (
    <tr key={p.id}>
      <td><b>{p.name}</b>{p.jersey_size ? <span className="muted small"> · size {p.jersey_size}</span> : null}</td>
      <td className="muted small">{p.team || p.league || "—"}</td>
      <td className="small">
        {p.reason}
        {p.source === "override" && <span className="chip" style={{ marginLeft: 6 }}>override</span>}
        {p.missing?.length > 0 && (
          <div className="muted small" style={{ marginTop: 2 }}>
            Missing: {p.missing.map((m) => MISSING_LABEL[m] || m).join(", ")}
          </div>
        )}
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <input
          placeholder="Reason (optional)"
          value={reasonDraft[p.id] ?? p.override_reason ?? ""}
          onChange={(e) => setReasonDraft((d) => ({ ...d, [p.id]: e.target.value }))}
          style={{ width: 180, marginRight: 6 }}
        />
        <button className="btn ghost sm" disabled={busy[p.id]} onClick={() => setOverride(p, "clear")}>Force clear</button>
        <button className="btn ghost sm" disabled={busy[p.id]} style={{ marginLeft: 4 }} onClick={() => setOverride(p, "hold")}>Hold</button>
        {p.override && <button className="btn ghost sm" disabled={busy[p.id]} style={{ marginLeft: 4 }} onClick={() => setOverride(p, "")}>Clear override</button>}
      </td>
    </tr>
  );

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="between" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Jersey press queue</h2>
        <div className="muted small">First two weeks: {data.firstWeeks?.length ? data.firstWeeks.join(", ") : "(season not set)"}</div>
      </div>
      <p className="muted small">A player is auto-cleared once their <b>size is confirmed</b> at check-in AND they've <b>attended at least one of the first two weeks</b>. Force-clear or hold individuals as needed.</p>
      <div className="btn-row" style={{ marginBottom: 10 }}>
        <button className={"pill" + (tab === "waiting" ? " active" : "")} onClick={() => setTab("waiting")}>Waiting ({data.waiting.length})</button>
        <button className={"pill" + (tab === "cleared" ? " active" : "")} onClick={() => setTab("cleared")}>Cleared ({data.cleared.length})</button>
        <button className={"pill" + (tab === "hold" ? " active" : "")} onClick={() => setTab("hold")}>On hold ({data.hold.length})</button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Player</th><th>Team / League</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.length ? rows.map(renderRow) : <tr><td colSpan={4} className="muted" style={{ padding: 12 }}>None in this group.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
