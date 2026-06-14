"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api.js";
import FieldInput from "./FieldInput.jsx";

const toISO = (d) => d.toISOString().slice(0, 10);
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
const addDays = (iso, n) => { const x = new Date(iso + "T00:00:00"); x.setDate(x.getDate() + n); return toISO(x); };
const fmtWeek = (iso) => { const d = new Date(iso + "T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString([], { month: "short", day: "numeric" }); };
const headFirst = (cs) => [...cs].sort((a, b) => (/head/i.test(b.role) ? 1 : 0) - (/head/i.test(a.role) ? 1 : 0));

export default function CheckIn({ go }) {
  const [week, setWeek] = useState(() => toISO(weekStart(new Date())));
  const [league, setLeague] = useState("");
  const [division, setDivision] = useState("");
  const [team, setTeam] = useState("");
  const [data, setData] = useState(undefined);
  const [flash, setFlash] = useState(null);
  const [scanQ, setScanQ] = useState("");
  const [edit, setEdit] = useState(null);   // player being edited
  const [vals, setVals] = useState({});

  async function load() {
    const r = await api.attendanceList({ week, league: league || null, division: division || null, team: team || null });
    const ok = r && Array.isArray(r.players);
    setData(ok
      ? { leagues: r.leagues || [], divisions: r.divisions || [], teams: r.teams || [], players: r.players || [], present: r.present || 0, total: r.total || 0, error: null }
      : { leagues: [], divisions: [], teams: [], players: [], present: 0, total: 0, error: (r && r.error) || "Could not load check-in." });
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [week, league, division, team]);

  // Live-sync with the parent kiosk (ScanIn) and the public Team Board:
  // poll the same /api/attendance store every 5s while the tab is focused, so a
  // check-in coming from any of those screens appears here without a manual refresh.
  const pollRef = useRef(null);
  useEffect(() => {
    function start() {
      if (pollRef.current || typeof document === "undefined") return;
      pollRef.current = setInterval(() => { if (!document.hidden) load(); }, 5000);
    }
    function stop() { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } }
    start();
    const onVis = () => { if (document.hidden) stop(); else { start(); load(); } };
    document.addEventListener && document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener && document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line
  }, [week, league, division, team]);

  async function toggle(p) {
    setData((d) => ({ ...d, players: d.players.map((x) => x.id === p.id ? { ...x, present: !x.present } : x), present: d.present + (p.present ? -1 : 1) }));
    await api.attendanceToggle({ player_id: p.id, player: p.name, week, present: !p.present });
  }
  async function toggleCoach(c, key) {
    setData((d) => ({ ...d, coachesByTeam: { ...d.coachesByTeam, [key]: d.coachesByTeam[key].map((x) => x.id === c.id ? { ...x, present: !x.present } : x) } }));
    await api.attendanceToggle({ player_id: c.id, player: c.name, week, present: !c.present });
  }
  async function scan() {
    const q = scanQ.trim(); if (!q) return;
    const res = await api.attendanceScan({ query: q, week }); setScanQ("");
    if (res.status === "checked_in") { setFlash({ ok: true, text: `✓ ${res.player.name} checked in.` }); await load(); }
    else if (res.status === "already") setFlash({ ok: true, text: `${res.player.name} was already checked in.` });
    else if (res.status === "ambiguous") setFlash({ ok: false, text: `More than one match for “${q}” — use the list.` });
    else setFlash({ ok: false, text: `No match for “${q}”.` });
  }
  function openEdit(p) { setEdit(p); setVals({ ...p.data }); }
  async function saveEdit() {
    const res = await api.updateRecord(edit.id, vals);
    if (res && res.error) return setFlash({ ok: false, text: res.error });
    setEdit(null); setFlash({ ok: true, text: "Player details updated." }); await load();
  }

  if (data === undefined) return <div className="muted">Loading…</div>;

  // group players by team
  const groups = {};
  for (const p of data.players) { const key = p.team || "__none"; (groups[key] = groups[key] || []).push(p); }
  const teamNames = Object.keys(groups).filter((k) => k !== "__none").sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (groups.__none) teamNames.push("__none");

  return (
    <div>
      <div className="page-head"><h1>Check-in</h1><div className="muted">By team — mark who showed up, see coaches, and edit a player. <span className="muted small">Live-syncs with the parent kiosk every 5s · ✓ size means the player was confirmed at the kiosk.</span></div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      {data.error && <div className="note warn">{data.error} <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={load}>Retry</button></div>}

      <div className="card">
        <div className="between" style={{ flexWrap: "wrap", gap: 12 }}>
          <div className="btn-row" style={{ alignItems: "center", gap: 8 }}>
            <button className="btn sm" onClick={() => setWeek(addDays(week, -7))}>‹ Prev</button>
            <b>Week of {fmtWeek(week)}</b>
            <button className="btn sm" onClick={() => setWeek(addDays(week, 7))}>Next ›</button>
            {week !== toISO(weekStart(new Date())) && <button className="btn ghost sm" onClick={() => setWeek(toISO(weekStart(new Date())))}>This week</button>}
          </div>
          <span className="chip brand">{data.present} of {data.total} in</span>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <div><label className="fld">League</label><select value={league} onChange={(e) => { setLeague(e.target.value); setDivision(""); setTeam(""); }}><option value="">All leagues</option>{data.leagues.map((l) => <option key={l} value={l}>{l}</option>)}</select></div>
          <div><label className="fld">Division</label><select value={division} onChange={(e) => setDivision(e.target.value)}><option value="">All divisions</option>{data.divisions.map((d) => <option key={d} value={d}>{d}</option>)}</select></div>
          <div><label className="fld">Team</label><select value={team} onChange={(e) => setTeam(e.target.value)}><option value="">All teams</option>{data.teams.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
        </div>
        <label className="fld">Quick check-in — scan or type a name / ID</label>
        <div className="addbar">
          <input placeholder="Scan or type a name / ID…" value={scanQ} onChange={(e) => setScanQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") scan(); }} />
          <button className="btn primary" onClick={scan}>Check in</button>
        </div>
      </div>

      {!data.players.length && (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No players match. {data.total === 0 ? <>Add players on the <a onClick={() => go({ page: "section", type: "player" })}>Players page</a>.</> : "Try a different filter."}</p></div>
      )}

      <div className="grid cols-3" style={{ marginTop: 14 }}>
        {teamNames.map((key) => {
          const list = groups[key];
          const label = key === "__none" ? "No team yet" : key;
          const co = data.coachesByTeam[key] || [];
          const inCount = list.filter((p) => p.present).length;
          return (
            <div className="card team-col" key={key}>
              <div className="between">
                <h3 style={{ margin: 0 }}>{label}</h3>
                <span className="chip">{inCount}/{list.length} in</span>
              </div>
              <div className="stack" style={{ marginTop: 8 }}>
                {headFirst(co).map((c) => (
                  <div key={"c" + c.id} className={"drag-item checkitem" + (c.present ? " in" : "")} onClick={() => toggleCoach(c, key)} title="Tap to check in / out">
                    <div className="ci-main">
                      <span className="ci-name">{c.name} <span className="coachpill">{/head/i.test(c.role) ? "Head Coach" : "Coach"}</span></span>
                    </div>
                    <div className="ci-right"><span className={c.present ? "in-check" : "muted"}>{c.present ? "✓" : "—"}</span></div>
                  </div>
                ))}
                {list.map((p) => {
                  const sizeOk = !!(p.data && p.data.size_confirmed_at);
                  const size = (p.data && p.data.jersey_size) || "";
                  return (
                    <div key={p.id} className={"drag-item checkitem" + (p.present ? " in" : "")} onClick={() => toggle(p)} title="Tap to check in / out">
                      <div className="ci-main">
                        <span className="ci-name">
                          {p.name}
                          {p.division ? <span className="muted small"> · {p.division}</span> : null}
                          {sizeOk
                            ? <span className="chip good" style={{ marginLeft: 6 }} title={`Size confirmed at kiosk · ${p.data.size_confirmed_at}`}>✓ size {size || "?"}</span>
                            : (size ? <span className="chip" style={{ marginLeft: 6 }} title="Jersey size on file but not confirmed on-site yet">size {size}</span> : <span className="chip" style={{ marginLeft: 6 }} title="No jersey size on file">no size</span>)}
                        </span>
                        {p.data && p.data.notes ? <span className="ci-note">Note: {p.data.notes}</span> : null}
                      </div>
                      <div className="ci-right">
                        <span className={p.present ? "in-check" : "muted"}>{p.present ? "✓" : "—"}</span>
                        <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); openEdit(p); }}>Edit</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 4 }}>Edit {edit.name}</h2>
            <div className="muted small" style={{ marginBottom: 8 }}>Update this player’s details.</div>
            {data.fields.map((f) => <FieldInput key={f.name} field={f} value={vals[f.name]} onChange={(v) => setVals({ ...vals, [f.name]: v })} />)}
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={saveEdit}>Save changes</button>
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
