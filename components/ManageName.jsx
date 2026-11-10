"use client";
// Rename / Delete (with "move everything first") for a NAME that's copied all
// over the database — a league, a township or a season. One component so all
// three behave the same way. The server side is lib/manage.js.
//
// How Delete works (agreed rule): if anything still uses the name, the server
// refuses and says what uses it. This row then shows that list and offers
// "Move everything to [another name]" — which renames it INTO that name, so the
// old one disappears with nothing left pointing at it.
import { useState } from "react";
import { api } from "@/lib/api.js";

// Plural labels for the usage list ("216 players, 41 games").
const NOUN = { player: "player", game: "game", coach: "coach", referee: "referee", division: "division", attendance: "attendance record", team: "team", tournament: "tournament" };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : w.endsWith("h") ? "es" : "s"}`;

function usageText(u) {
  if (!u) return "";
  const parts = Object.entries(u.records || {}).map(([t, n]) => plural(n, NOUN[t] || t));
  if (u.rules && u.rules.length) parts.push(`${plural(u.rules.length, "rule")} (${u.rules.map((r) => r.name).join(", ")})`);
  if (u.blackouts) parts.push(plural(u.blackouts, "blackout date"));
  if (u.links) parts.push(plural(u.links, "player link"));
  return parts.join(", ") || "nothing";
}

// kind: "league" | "township" | "season"
// names: every existing name of that kind (for the "move to" list)
// extra(name): optional extra controls for a row (e.g. the league lock button)
// onChanged(result): reload the page data after a change
// all: every name of this kind, when `names` is only a filtered view — the
// "move to" list still offers all of them.
export default function ManageNameList({ kind, names, all, extra, onChanged, setFlash, render }) {
  return (
    <div className="stack" style={{ marginTop: 14 }}>
      {names.map((n) => (
        <ManageNameRow key={n} kind={kind} name={n} others={(all || names).filter((x) => x !== n)}
          extra={extra} onChanged={onChanged} setFlash={setFlash} render={render} />
      ))}
    </div>
  );
}

function ManageNameRow({ kind, name, others, extra, onChanged, setFlash, render }) {
  const [mode, setMode] = useState(null);       // null | "rename" | "delete"
  const [draft, setDraft] = useState(name);
  const [usage, setUsage] = useState(null);     // what uses this name
  const [moveTo, setMoveTo] = useState(others[0] || "");
  const [busy, setBusy] = useState(false);
  const isSeason = kind === "season";

  const getUsage = () => (isSeason ? api.seasonUsage(name) : api.manageUsage(kind, name));

  async function openRename() {
    setMode("rename"); setDraft(name); setUsage(null);
    setUsage(await getUsage()); // shown as "this will update …"
  }

  async function saveRename() {
    const to = draft.trim();
    if (!to || to === name) return setMode(null);
    setBusy(true);
    try {
      const res = isSeason ? await api.seasonRename(name, to) : await api.manageRename(kind, name, to);
      if (res.error) return setFlash({ ok: false, text: res.error });
      // The sidebar remembers the picked season by name — follow the rename.
      if (isSeason) { try { if (localStorage.getItem("ff_season") === name) localStorage.setItem("ff_season", to); } catch {} }
      setFlash({ ok: true, text: `Renamed "${name}" to "${to}" everywhere${res.records != null ? ` (${res.records} record${res.records === 1 ? "" : "s"} updated)` : ""}. A backup was saved first.` });
      setMode(null); onChanged && onChanged(res);
    } finally { setBusy(false); }
  }

  async function tryDelete() {
    if (!window.confirm(`Delete ${kind} "${name}"?`)) return;
    setBusy(true);
    try {
      const res = isSeason ? await api.seasonDelete(name) : await api.manageDelete(kind, name);
      if (res.error === "in_use") { setUsage(res.usage); setMode("delete"); return; }
      if (res.error) return setFlash({ ok: false, text: res.error });
      setFlash({ ok: true, text: `Deleted ${kind} "${name}".` });
      onChanged && onChanged(res);
    } finally { setBusy(false); }
  }

  async function moveAndDelete() {
    if (!moveTo) return;
    if (!window.confirm(`Move everything from "${name}" into "${moveTo}"?\n\n${usageText(usage)} will now be "${moveTo}", and "${name}" will be gone.\n\nA backup is saved first.`)) return;
    setBusy(true);
    try {
      const res = isSeason ? await api.seasonMove(name, moveTo) : await api.manageMove(kind, name, moveTo);
      if (res.error) return setFlash({ ok: false, text: res.error });
      if (isSeason) { try { if (localStorage.getItem("ff_season") === name) localStorage.setItem("ff_season", moveTo); } catch {} }
      setFlash({ ok: true, text: `Moved everything from "${name}" into "${moveTo}" and removed "${name}".` });
      setMode(null); onChanged && onChanged(res);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ borderBottom: "1px solid var(--line-soft)", paddingBottom: 8 }}>
      <div className="between" style={{ gap: 8, flexWrap: "wrap" }}>
        {mode === "rename" ? (
          <div className="addbar" style={{ flex: 1, minWidth: 240 }}>
            <input type="text" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") setMode(null); }} />
            <button className="btn primary" disabled={busy} onClick={saveRename}>{busy ? "Saving…" : "Save"}</button>
            <button className="btn ghost" onClick={() => setMode(null)}>Cancel</button>
          </div>
        ) : (
          <div style={{ flex: 1 }}>{render ? render(name) : <b>{name}</b>}</div>
        )}
        {mode !== "rename" && (
          <div className="btn-row">
            {extra && extra(name)}
            <button className="btn ghost sm" onClick={openRename}>Rename</button>
            <button className="btn ghost sm" disabled={busy} onClick={tryDelete}>Delete</button>
          </div>
        )}
      </div>

      {mode === "rename" && usage && (
        <div className="muted small" style={{ marginTop: 4 }}>
          Changes the name everywhere it's used: {usageText(usage)}.
        </div>
      )}

      {mode === "delete" && usage && (
        <div className="note warn" style={{ marginTop: 8 }}>
          <div><b>"{name}" can't be deleted yet</b>: it's still used by {usageText(usage)}.</div>
          {others.length ? (
            <div className="addbar" style={{ marginTop: 8, alignItems: "center" }}>
              <span className="small">Move everything to</span>
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} style={{ width: "auto" }}>
                {others.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <button className="btn primary" disabled={busy} onClick={moveAndDelete}>{busy ? "Moving…" : "Move & delete"}</button>
              <button className="btn ghost" onClick={() => setMode(null)}>Cancel</button>
            </div>
          ) : (
            <div className="small" style={{ marginTop: 6 }}>There's no other {kind} to move it into. Add one first, or use Rename instead.</div>
          )}
        </div>
      )}
    </div>
  );
}
