"use client";
import { useEffect, useState } from "react";
import { api, currentSeason } from "@/lib/api.js";
import AiPromptBar from "./AiPromptBar.jsx";

// This season's Unassigned.
//
// "Unassigned" used to be a bucket at the bottom of other lists, and it meant a
// different thing on each screen. Here it means one thing — a player this
// season who isn't finished being placed — split into the three problems that
// need different fixes, because "42 unassigned" isn't an instruction and
// "9 have no division" is.
const BUCKETS = [
  { key: "no_league", label: "No league yet", fix: "Route them into a league — or let the assignment rules do it by township." },
  { key: "no_division", label: "No age division", fix: "Usually an age outside every bracket. Fix the age, or widen a division." },
  { key: "no_team", label: "No team", fix: "They're ready for the team build — or drop them onto a team by hand." },
];

export default function Unassigned({ go, refresh, onAsk }) {
  const [data, setData] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [bucket, setBucket] = useState("no_league");
  const [target, setTarget] = useState({ league: "", division: "", team: "" });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [ask, setAsk] = useState("");

  async function load() {
    const d = await api.unassigned();
    setData(d && !d.error ? d : { error: d?.error || "Could not load" });
    setSel(new Set());
  }
  useEffect(() => { load(); }, []);

  if (!data) return <div className="muted">Loading…</div>;
  if (data.error) return <div className="card"><p className="muted">{data.error}</p></div>;

  const season = data.season || currentSeason();
  const list = data[bucket] || [];
  const active = BUCKETS.find((b) => b.key === bucket);
  const leagues = [...new Set((data.divisions || []).map((d) => d.league).filter(Boolean))];
  const divisionsForLeague = (data.divisions || [])
    .filter((d) => !target.league || !d.league || d.league === target.league);

  const toggle = (id) => setSel((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  async function assign() {
    if (!sel.size) return;
    const changes = {};
    for (const k of ["league", "division", "team"]) if (target[k]) changes[k] = target[k];
    if (!Object.keys(changes).length) { setFlash({ bad: true, text: "Pick what to set first." }); return; }
    setBusy(true);
    const res = await api.unassignedAssign([...sel], changes);
    setBusy(false);
    if (res.error) { setFlash({ bad: true, text: res.error }); return; }
    // Report both halves. A "moved 12" that hides "3 blocked" is the kind of
    // half-truth that costs someone an afternoon later.
    const blocked = res.blocked || [];
    setFlash({
      bad: blocked.length > 0,
      text: `Moved ${res.moved}${blocked.length ? ` · ${blocked.length} blocked: ${blocked[0].reason}` : ""}`,
    });
    await load();
    refresh && refresh();
  }

  async function autoDivision() {
    setBusy(true);
    const res = await api.unassignedAutoDivision();
    setBusy(false);
    setFlash(res.error ? { bad: true, text: res.error } : { text: `Re-sorted by age. Still unassigned: ${JSON.stringify(res.remaining)}` });
    await load();
  }

  return (
    <div>
      <div className="page-head">
        <h1>Unassigned</h1>
        <span className="chip brand lg">{season}</span>
      </div>
      <p className="muted">
        Players in <strong>{season}</strong> who aren&apos;t finished being placed. Other seasons are
        untouched by anything on this page.
      </p>

      {flash && <div className={"card " + (flash.bad ? "bad" : "")}><p>{flash.text}</p></div>}

      <div className="btn-row" style={{ marginBottom: 16 }}>
        {BUCKETS.map((b) => (
          <button key={b.key}
            className={"pill" + (bucket === b.key ? " active" : "")}
            onClick={() => { setBucket(b.key); setSel(new Set()); }}>
            {b.label} · {data.counts?.[b.key] ?? 0}
          </button>
        ))}
      </div>

      {!list.length ? (
        <div className="card">
          <h2>Nothing here</h2>
          <p className="muted">
            No {season} player is missing {bucket === "no_league" ? "a league" : bucket === "no_division" ? "a division" : "a team"}.
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <p className="muted small">{active.fix}</p>
            <div className="between" style={{ marginBottom: 8 }}>
              <div className="btn-row">
                <button className="btn sm" onClick={() => setSel(new Set(list.map((p) => p.id)))}>Select all {list.length}</button>
                <button className="btn ghost sm" onClick={() => setSel(new Set())}>Clear</button>
                {bucket === "no_division" && (
                  <button className="btn sm" disabled={busy} onClick={autoDivision}>Re-sort by age</button>
                )}
              </div>
              <span className="muted small">{sel.size} selected</span>
            </div>

            <div className="grid cols-2">
              <div className="fld">
                <label>League</label>
                <select value={target.league} onChange={(e) => setTarget({ ...target, league: e.target.value, division: "", team: "" })}>
                  <option value="">— leave as is —</option>
                  {leagues.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div className="fld">
                <label>Division</label>
                <select value={target.division} onChange={(e) => setTarget({ ...target, division: e.target.value, team: "" })}>
                  <option value="">— leave as is —</option>
                  {divisionsForLeague.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                </select>
              </div>
              <div className="fld">
                <label>Team</label>
                <input value={target.team} placeholder='e.g. "Ages 9-10 / Team 3"'
                  onChange={(e) => setTarget({ ...target, team: e.target.value })} />
              </div>
              <div className="fld" style={{ alignSelf: "end" }}>
                <button className="btn primary" disabled={busy || !sel.size} onClick={assign}>
                  {busy ? "Saving…" : `Assign ${sel.size || ""}`.trim()}
                </button>
              </div>
            </div>
          </div>

          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 32 }}></th>
                <th>Name</th><th>Age</th><th>League</th><th>Division</th><th>Team</th><th>Township</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id} onClick={() => toggle(p.id)} style={{ cursor: "pointer" }}>
                  <td><input type="checkbox" readOnly checked={sel.has(p.id)} /></td>
                  <td>{p.name}</td>
                  <td>{p.age}</td>
                  <td>{p.league || <span className="muted">—</span>}</td>
                  <td>{p.division || <span className="muted">—</span>}</td>
                  <td>{p.team || <span className="muted">—</span>}</td>
                  <td className="muted">{p.township}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="aibox" style={{ marginTop: 20 }}>
        <div className="aibox-head"><span className="ai-badge">S-Dot</span> Or ask S-Dot</div>
        <p className="muted small">
          Try &ldquo;put everyone with no division into the right bracket&rdquo; or &ldquo;show me who has no team in
          Saturday Limerick&rdquo;. S-Dot only sees {season}.
        </p>
        <AiPromptBar value={ask} onChange={setAsk} pageId="unassigned"
          onSend={() => { onAsk && onAsk(ask); setAsk(""); }} />
      </div>
    </div>
  );
}
