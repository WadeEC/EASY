"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { describe, ACTOR_LABEL, isRevertible } from "@/lib/auditlog.js";

const fmtTime = (iso) => { const d = new Date((iso || "").length <= 19 ? iso + "Z" : iso); return isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
const dotColor = (a) => a === "create" ? "var(--good)" : a === "delete" ? "var(--danger)" : "var(--accent)";

// Time Machine: browse the change history and roll changes back — one at a time, or
// rewind everything that happened after a chosen point.
export default function TimeMachine({ refresh }) {
  const [entries, setEntries] = useState([]);
  const [q, setQ] = useState("");
  const [hideReverted, setHideReverted] = useState(false);
  const [confirm, setConfirm] = useState(null);   // { entry, count } for restore-to-here
  const [flash, setFlash] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() { const r = await api.history(); setEntries(r.entries || []); }
  useEffect(() => { load(); }, []);

  const rows = entries.map((e) => ({ ...e, ...describe(e), who: ACTOR_LABEL(e.actor), can: isRevertible(e) }));
  const revertibleCount = rows.filter((r) => r.can).length;
  const newestRevertible = rows.find((r) => r.can);   // rows are newest-first
  const newerCount = (e) => entries.filter((x) => x.id > e.id && isRevertible(x)).length;

  const shown = rows.filter((r) => (!hideReverted || !r.undone) && (!q || (`${r.text} ${r.detail} ${r.who}`).toLowerCase().includes(q.toLowerCase())));

  async function after() { await load(); if (refresh) { try { await refresh(); } catch {} } }
  async function revertOne(e) {
    setBusy(true); const res = await api.undoOne(e.id); setBusy(false);
    if (res && res.error) { setFlash({ ok: false, text: `Could not revert: ${res.error}` }); return; }
    await after(); setFlash({ ok: true, text: `Reverted — ${e.text}.` });
  }
  async function restoreTo(e) {
    setBusy(true); const res = await api.restorePoint(e.id); setConfirm(null); setBusy(false);
    if (res && res.error) { setFlash({ ok: false, text: `Could not restore: ${res.error}` }); return; }
    await after(); setFlash({ ok: true, text: `Rewound ${res.undone || 0} change${res.undone === 1 ? "" : "s"} — back to just after “${e.text}”.` });
  }

  return (
    <div>
      <div className="page-head"><h1>Time Machine</h1><div className="muted">Roll back changes — undo a single edit, or rewind the league to an earlier point.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      <div className="card">
        <div className="between" style={{ flexWrap: "wrap", gap: 10 }}>
          <div>
            <button className="btn primary" disabled={!newestRevertible || busy} onClick={() => newestRevertible && revertOne(newestRevertible)}>Undo last change</button>
            <span className="muted small" style={{ marginLeft: 10 }}>{revertibleCount} change{revertibleCount === 1 ? "" : "s"} can be rolled back.</span>
          </div>
          <label className="small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={hideReverted} onChange={(e) => setHideReverted(e.target.checked)} /> hide reverted
          </label>
        </div>
        <input style={{ marginTop: 10 }} placeholder="Search changes…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="muted small" style={{ marginTop: 8 }}>Reverting only affects league data (players, teams, schedule, referees, tournaments). Setup changes are never touched.</div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {!shown.length ? (
          <p className="muted" style={{ margin: 0, padding: 16 }}>No changes to show.</p>
        ) : shown.map((r) => (
          <div key={r.id} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "12px 14px", borderTop: "1px solid var(--line)", opacity: r.undone ? 0.6 : 1 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor(r.action), marginTop: 7, flex: "0 0 auto" }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ textDecoration: r.undone ? "line-through" : "none" }}>{r.text}{r.detail ? <span className="muted"> — {r.detail}</span> : null}</div>
              <div className="muted small" style={{ marginTop: 2 }}>{r.cat} · <b>{r.who}</b> · {fmtTime(r.created_at)}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", flex: "0 0 auto" }}>
              {r.undone ? <span className="chip">Reverted</span>
                : r.can ? (
                  <>
                    <button className="btn ghost sm" disabled={busy} onClick={() => revertOne(r)}>Revert</button>
                    <button className="btn ghost sm" disabled={busy} onClick={() => setConfirm({ entry: r, count: newerCount(r) })}>Restore to here</button>
                  </>
                ) : <span className="muted small">—</span>}
            </div>
          </div>
        ))}
      </div>

      {confirm && (
        <div className="overlay" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 6 }}>Rewind to this point?</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              This reverts the <b>{confirm.count}</b> change{confirm.count === 1 ? "" : "s"} made after <b>“{confirm.entry.text}”</b> ({fmtTime(confirm.entry.created_at)}), newest first. That change itself stays. This cannot be redone automatically.
            </p>
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn primary" disabled={busy} onClick={() => restoreTo(confirm.entry)}>{busy ? "Rewinding…" : `Rewind ${confirm.count} change${confirm.count === 1 ? "" : "s"}`}</button>
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
            {confirm.count === 0 && <div className="muted small" style={{ marginTop: 8 }}>Nothing newer to revert — this is already the latest change.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
