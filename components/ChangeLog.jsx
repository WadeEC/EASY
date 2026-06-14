"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { describe, ACTOR_LABEL, CATS } from "@/lib/auditlog.js";

export default function ChangeLog() {
  const [entries, setEntries] = useState([]);
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  const [who, setWho] = useState("");
  const [admin, setAdmin] = useState("Admin");
  const [adminDraft, setAdminDraft] = useState("Admin");
  const [flash, setFlash] = useState(null);

  async function load() { const r = await api.history(); setEntries(r.entries || []); }
  useEffect(() => {
    load();
    try { const a = localStorage.getItem("ff_admin") || "Admin"; setAdmin(a); setAdminDraft(a); } catch {}
  }, []);

  function saveAdmin() {
    const v = (adminDraft || "").trim() || "Admin";
    try { localStorage.setItem("ff_admin", v); } catch {}
    setAdmin(v); setFlash({ ok: true, text: `Changes will now be recorded as “${v}”.` });
  }

  const rows = entries.map((e) => ({ ...e, ...describe(e), actor: ACTOR_LABEL(e.actor) }));
  const actors = [...new Set(rows.map((r) => r.actor))].sort();
  const counts = {}; for (const r of rows) counts[r.cat] = (counts[r.cat] || 0) + 1;
  const shown = rows.filter((r) =>
    (cat === "All" || r.cat === cat) &&
    (!who || r.actor === who) &&
    (!q || (`${r.text} ${r.detail} ${r.actor}`).toLowerCase().includes(q.toLowerCase()))
  );

  const fmtTime = (iso) => { const d = new Date((iso || "").length <= 19 ? iso + "Z" : iso); return isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
  const dot = (a) => a === "create" ? "var(--good)" : a === "delete" ? "var(--danger)" : "var(--accent)";

  return (
    <div>
      <div className="page-head"><h1>Change log</h1><div className="muted">Every player move, schedule change, and roster adjustment — tagged to the admin who made it.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      <div className="card">
        <label className="fld">Acting as (admin account)</label>
        <div className="aibar">
          <input value={adminDraft} onChange={(e) => setAdminDraft(e.target.value)} placeholder="Your name…" onKeyDown={(e) => { if (e.key === "Enter") saveAdmin(); }} />
          <button className="btn primary" onClick={saveAdmin}>Save</button>
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>Currently recording changes as <b>{admin}</b>. New edits anywhere in the app are stamped with this name.</div>
      </div>

      <div className="card">
        <div className="btn-row" style={{ flexWrap: "wrap", marginBottom: 10 }}>
          {CATS.map((c) => <button key={c} className={"btn" + (c === cat ? " primary" : "")} onClick={() => setCat(c)}>{c}{c !== "All" && counts[c] ? ` (${counts[c]})` : ""}</button>)}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <input placeholder="Search changes…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: "1 1 220px" }} />
          <select value={who} onChange={(e) => setWho(e.target.value)} style={{ flex: "0 0 auto" }}>
            <option value="">All admins</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>{shown.length} of {rows.length} changes</div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {!shown.length ? (
          <p className="muted" style={{ margin: 0, padding: 16 }}>No changes recorded yet. Player moves, schedule edits, and roster changes will appear here.</p>
        ) : shown.map((r) => (
          <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "11px 14px", borderTop: "1px solid var(--line)" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: dot(r.action), marginTop: 7, flex: "0 0 auto" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>{r.text}{r.detail ? <span className="muted"> — {r.detail}</span> : null}</div>
              <div className="muted small" style={{ marginTop: 2 }}>{r.cat}{r.undone ? " · undone" : ""}</div>
            </div>
            <div style={{ textAlign: "right", flex: "0 0 auto" }}>
              <span className="chip">{r.actor}</span>
              <div className="muted small" style={{ marginTop: 4 }}>{fmtTime(r.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
