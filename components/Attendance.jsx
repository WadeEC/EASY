"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";

const toISO = (d) => d.toISOString().slice(0, 10);
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
const fmtWeek = (iso) => { const d = new Date(iso + "T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString([], { month: "short", day: "numeric" }); };

// Weekly attendance tracker: players × weeks grid, tap a cell to mark/clear; totals per player.
export default function Attendance({ go }) {
  const week = toISO(weekStart(new Date()));
  const [league, setLeague] = useState("");
  const [division, setDivision] = useState("");
  const [team, setTeam] = useState("");
  const [data, setData] = useState(undefined);

  async function load() {
    const r = await api.attendanceReport({ week, league: league || null, division: division || null, team: team || null });
    // Never trust the shape: a transient API hiccup returns { error } — normalize so the page can't crash.
    const ok = r && Array.isArray(r.players);
    setData(ok
      ? { leagues: r.leagues || [], divisions: r.divisions || [], teams: r.teams || [], players: r.players || [], weeks: r.weeks || [], totalWeeks: r.totalWeeks || 0, error: null }
      : { leagues: [], divisions: [], teams: [], players: [], weeks: [], totalWeeks: 0, error: (r && r.error) || "Could not load attendance." });
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [league, division, team]);
  if (data === undefined) return <div className="muted">Loading…</div>;

  async function toggle(p, wi) {
    const w = data.weeks[wi];
    await api.attendanceToggle({ player_id: p.id, player: p.name, week: w, present: !p.present[wi] });
    await load();
  }

  return (
    <div>
      <div className="page-head"><h1>Attendance</h1><div className="muted">Weekly check-in history. Tap a cell to mark a player present or clear it.</div></div>
      {data.error && <div className="note warn">{data.error} <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={load}>Retry</button></div>}

      <div className="card">
        <div className="row">
          <div>
            <label className="fld">League</label>
            <select value={league} onChange={(e) => { setLeague(e.target.value); setDivision(""); setTeam(""); }}>
              <option value="">All leagues</option>
              {data.leagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Division</label>
            <select value={division} onChange={(e) => setDivision(e.target.value)}>
              <option value="">All divisions</option>
              {data.divisions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Team</label>
            <select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All teams</option>
              {data.teams.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>{data.players.length} players · {data.totalWeeks} week{data.totalWeeks !== 1 ? "s" : ""} recorded</div>
      </div>

      {!data.players.length
        ? <div className="card"><p className="muted" style={{ margin: 0 }}>No players match this filter.</p></div>
        : !data.weeks.length
          ? <div className="card"><p className="muted" style={{ margin: 0 }}>No weeks to show yet. Build a <a onClick={() => go({ page: "schedule" })}>schedule</a> to lay out the season’s weeks, then check players off here.</p></div>
          : (
            <div className="card" style={{ padding: 0, overflow: "auto" }}>
              <table className="tbl att">
                <thead>
                  <tr><th>Player</th>{data.weeks.map((w, i) => <th key={w} title={w}>Wk {i + 1}<div className="att-wk-date">{fmtWeek(w)}</div></th>)}<th>Total</th></tr>
                </thead>
                <tbody>
                  {data.players.map((p) => (
                    <tr key={p.id}>
                      <td><b>{p.name}</b>{(p.team || p.division) ? <div className="muted small">{[p.team, p.division].filter(Boolean).join(" · ")}</div> : null}</td>
                      {p.present.map((on, wi) => (
                        <td key={wi} className="attcell" onClick={() => toggle(p, wi)} title="Tap to toggle">
                          <span className={"attdot" + (on ? " on" : "")}>{on ? "✓" : ""}</span>
                        </td>
                      ))}
                      <td><b>{p.count}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </div>
  );
}
