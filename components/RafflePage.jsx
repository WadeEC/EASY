"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api.js";

const toISO = (d) => d.toISOString().slice(0, 10);
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
const pct = (n) => `${Math.round(n * 100)}%`;

// Weighted draw: each player appears in proportion to their tickets.
function drawOne(pool) {
  const total = pool.reduce((s, p) => s + p.tickets, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const p of pool) { r -= p.tickets; if (r < 0) return p; }
  return pool[pool.length - 1];
}

// Attendance raffle: the more weeks a player checks in, the more tickets they get —
// and players at/above the bonus threshold (e.g. 90%) get a ticket multiplier. Higher
// attendance => higher statistical chance, to motivate check-ins.
export default function RafflePage() {
  const week = toISO(weekStart(new Date()));
  const [data, setData] = useState(undefined);
  const [league, setLeague] = useState("");
  const [division, setDivision] = useState("");
  const [team, setTeam] = useState("");
  const [perCheckin, setPerCheckin] = useState(1);
  const [threshold, setThreshold] = useState(90);
  const [multiplier, setMultiplier] = useState(2);
  const [winners, setWinners] = useState([]);
  const [rolling, setRolling] = useState(false);
  const [rollName, setRollName] = useState("");
  const [flash, setFlash] = useState(null);
  const rollTimer = useRef(null);

  useEffect(() => {
    try { const s = JSON.parse(localStorage.getItem("ff_raffle") || "{}"); if (s.perCheckin) setPerCheckin(s.perCheckin); if (s.threshold) setThreshold(s.threshold); if (s.multiplier) setMultiplier(s.multiplier); } catch {}
  }, []);
  useEffect(() => { try { localStorage.setItem("ff_raffle", JSON.stringify({ perCheckin, threshold, multiplier })); } catch {} }, [perCheckin, threshold, multiplier]);

  async function load() {
    const r = await api.attendanceReport({ week, league: league || null, division: division || null, team: team || null });
    const ok = r && Array.isArray(r.players);
    setData(ok
      ? { leagues: r.leagues || [], divisions: r.divisions || [], teams: r.teams || [], players: r.players || [], weeks: r.weeks || [], totalWeeks: r.totalWeeks || (r.weeks ? r.weeks.length : 0), error: null }
      : { leagues: [], divisions: [], teams: [], players: [], weeks: [], totalWeeks: 0, error: (r && r.error) || "Could not load attendance." });
    setWinners([]);
  }
  useEffect(() => { load(); return () => clearInterval(rollTimer.current); /* eslint-disable-next-line */ }, [league, division, team]);
  if (data === undefined) return <div className="muted">Loading…</div>;

  // Only count weeks that actually happened (have a check-in). The attendance report adds an
  // empty "current week" column for marking today — don't let it deflate everyone's rate.
  const playedWeeks = (data.weeks || []).reduce((n, _w, wi) => { const c = data.players.reduce((k, p) => k + (Array.isArray(p.present) && p.present[wi] ? 1 : 0), 0); return n + (c >= 3 ? 1 : 0); }, 0);
  const totalWeeks = playedWeeks || data.totalWeeks || 0;
  // tickets + odds per player
  const ticketed = data.players.map((p) => {
    const rate = totalWeeks ? (p.count || 0) / totalWeeks : 0;
    const bonus = rate >= threshold / 100 && (p.count || 0) > 0;
    let tickets = Math.round((p.count || 0) * perCheckin * (bonus ? multiplier : 1));
    return { id: p.id, name: p.name, team: p.team, division: p.division, count: p.count || 0, rate, bonus, tickets };
  });
  const totalTickets = ticketed.reduce((s, p) => s + p.tickets, 0);
  const rows = ticketed.map((p) => ({ ...p, chance: totalTickets ? p.tickets / totalTickets : 0 }))
    .sort((a, b) => b.tickets - a.tickets || a.name.localeCompare(b.name));
  const eligible = rows.filter((r) => r.tickets > 0);
  const remaining = eligible.filter((r) => !winners.some((w) => w.id === r.id));

  function draw() {
    if (rolling) return;
    if (!remaining.length) { setFlash({ ok: false, text: "No eligible players left to draw." }); return; }
    const winner = drawOne(remaining);
    if (!winner) return;
    setFlash(null); setRolling(true);
    const names = remaining.map((p) => p.name);
    let n = 0;
    clearInterval(rollTimer.current);
    rollTimer.current = setInterval(() => {
      setRollName(names[Math.floor(Math.random() * names.length)]);
      if (++n > 14) { clearInterval(rollTimer.current); setRolling(false); setRollName(""); setWinners((w) => [...w, winner]); }
    }, 60);
  }

  return (
    <div>
      <div className="page-head"><h1>Attendance Raffle</h1><div className="muted">More check-ins means more tickets. Show up consistently to boost your odds.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      {data.error && <div className="note warn">{data.error} <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={load}>Retry</button></div>}

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div><label className="fld">League</label>
            <select value={league} onChange={(e) => { setLeague(e.target.value); setDivision(""); setTeam(""); }}>
              <option value="">All leagues</option>{data.leagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select></div>
          <div><label className="fld">Division</label>
            <select value={division} onChange={(e) => setDivision(e.target.value)}>
              <option value="">All divisions</option>{data.divisions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select></div>
          <div><label className="fld">Team</label>
            <select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All teams</option>{data.teams.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></div>
        </div>
        <div className="row" style={{ flexWrap: "wrap", marginTop: 10 }}>
          <div><label className="fld">Tickets per check-in</label><input type="number" min={1} value={perCheckin} onChange={(e) => setPerCheckin(Math.max(1, Number(e.target.value) || 1))} /></div>
          <div><label className="fld">Bonus at / above</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="number" min={1} max={100} value={threshold} onChange={(e) => setThreshold(Math.min(100, Math.max(1, Number(e.target.value) || 0)))} style={{ maxWidth: 90 }} /><span className="muted">% attendance</span></div>
          </div>
          <div><label className="fld">Bonus multiplier</label>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}><input type="number" min={1} step={0.5} value={multiplier} onChange={(e) => setMultiplier(Math.max(1, Number(e.target.value) || 1))} style={{ maxWidth: 90 }} /><span className="muted">×</span></div>
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          {eligible.length} eligible player{eligible.length !== 1 ? "s" : ""} · {totalTickets} tickets in the pot · {totalWeeks} week{totalWeeks !== 1 ? "s" : ""} recorded. Players at {threshold}%+ attendance earn {multiplier}× tickets.
        </div>
      </div>

      <div className="card">
        <div className="between" style={{ flexWrap: "wrap", gap: 10 }}>
          <button className="btn primary" disabled={rolling || !remaining.length} onClick={draw}>{rolling ? "Drawing…" : winners.length ? "Draw another winner" : "Draw a winner"}</button>
          {winners.length > 0 && <button className="btn ghost" onClick={() => setWinners([])}>Reset draw</button>}
        </div>

        {rolling && <div className="raffle-spot rolling"><div className="muted small">Drawing…</div><div className="raffle-name">{rollName || "…"}</div></div>}

        {!rolling && winners.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div className="raffle-spot win">
              <div className="muted small">{winners.length === 1 ? "Winner" : `Winner #${winners.length}`}</div>
              <div className="raffle-name">{winners[winners.length - 1].name}</div>
              <div className="muted small">{[winners[winners.length - 1].team, `${pct(winners[winners.length - 1].chance)} chance`].filter(Boolean).join(" · ")}</div>
            </div>
            {winners.length > 1 && (
              <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                {winners.map((w, i) => <div className="drag-item" key={w.id} style={{ cursor: "default" }}><span><b>#{i + 1}</b> &nbsp;{w.name}{w.team ? <span className="muted small"> · {w.team}</span> : null}</span><span className="chip">{pct(w.chance)}</span></div>)}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Player</th><th>Attendance</th><th>Tickets</th><th>Chance</th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const won = winners.some((w) => w.id === p.id);
              return (
                <tr key={p.id} style={{ opacity: won ? 0.55 : 1 }}>
                  <td><b>{p.name}</b>{p.team ? <div className="muted small">{p.team}</div> : null}</td>
                  <td>{p.count}/{totalWeeks} <span className="muted">({pct(p.rate)})</span>{p.bonus ? <span className="chip" style={{ marginLeft: 6, background: "var(--good-soft)", color: "var(--good)" }}>{multiplier}× bonus</span> : null}</td>
                  <td>{p.tickets}</td>
                  <td style={{ minWidth: 150 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, height: 8, background: "var(--line)", borderRadius: 999, overflow: "hidden" }}>
                        <div style={{ width: pct(p.chance), height: "100%", background: "var(--brand)" }} />
                      </div>
                      <span className="small" style={{ width: 44, textAlign: "right" }}>{(p.chance * 100).toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No players match this filter.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
