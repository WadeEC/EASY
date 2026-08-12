"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import RefAiBox from "./RefAiBox.jsx";
import { findConflicts, refBusyAt } from "@/lib/conflicts.js";

const fmtDate = (iso) => { if (!iso) return ""; const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso); return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: "short", day: "numeric" }); };
const refsOf = (g) => String(g.referee || "").split(",").map((s) => s.trim()).filter(Boolean);

// Division name straight from the admin Saved schedule's logic: split on
// "Division / Team", fall back to the player-derived map. Keeps this view
// in lock-step with what the league admin sees on the same game.
function makeDivisionOf(teamDivs) {
  return (g) => {
    const splitName = (s) => { const i = String(s || "").indexOf(" / "); return i > 0 ? s.slice(0, i) : ""; };
    return splitName(g.home) || splitName(g.away) || teamDivs[g.home] || teamDivs[g.away] || "";
  };
}

// Assign one or more referees to each game. Mirrors the admin Saved schedule
// one-for-one: Week → Division → games, with League / Division / Field filters
// matching the admin view. Every game appears whether or not it has a ref yet.
export default function RefAssign({ onAsk }) {
  const [games, setGames] = useState([]);
  const [refs, setRefs] = useState([]);
  const [league, setLeague] = useState("");
  const [filterDivision, setFilterDivision] = useState("");
  const [filterField, setFilterField] = useState("");
  const [flash, setFlash] = useState(null);
  // Canonical league + division choices from the schema so dropdowns are
  // populated even before any games exist (mirroring how the admin Schedule
  // populates its filters).
  const [leagueOpts, setLeagueOpts] = useState([]);
  const [teamDivs, setTeamDivs] = useState({});   // team name → most-common division (player-derived fallback)

  async function load() {
    try { await api.ensureReferees(); } catch {}   // make sure the referee roster exists before the AI adds to it
    const g = await api.scheduleList(null); setGames(g.games || []);
    try { const r = await api.records("referee"); setRefs((r.records || []).map((x) => x.name).filter(Boolean)); } catch {}
    try {
      const s = await api.schema("player");
      const lf = (s.fields || []).find((f) => f.name === "league");
      let opts = [];
      try { opts = lf && lf.options ? JSON.parse(lf.options) : []; } catch {}
      setLeagueOpts(opts.filter(Boolean));
    } catch {}
    try {
      const pr = await api.records("player");
      const counts = {};
      for (const x of (pr.records || [])) {
        let d = {}; try { d = JSON.parse(x.data || "{}"); } catch {}
        const t = (d.team || "").trim(); const dv = (d.division || "").trim();
        if (!t || !dv) continue;
        counts[t] = counts[t] || {}; counts[t][dv] = (counts[t][dv] || 0) + 1;
      }
      const map = {};
      for (const t of Object.keys(counts)) {
        let best = "", n = -1;
        for (const dv of Object.keys(counts[t])) if (counts[t][dv] > n) { best = dv; n = counts[t][dv]; }
        map[t] = best;
      }
      setTeamDivs(map);
    } catch {}
  }
  useEffect(() => { load(); }, []);

  async function setRefsFor(g, list) { await api.scheduleAssignRef(g.id, list.join(", ")); await load(); }
  async function addRef(g, name) {
    if (!name) return;
    const cur = refsOf(g); if (cur.includes(name)) return;
    const clash = refBusyAt(games, name, g.date, g.time, g.id);
    if (clash) { setFlash({ ok: false, text: `${name} is already on ${clash.home} vs ${clash.away}${clash.location ? ` (${clash.location})` : ""} at ${g.time}. A referee can't be in two places at once.` }); return; }
    await setRefsFor(g, [...cur, name]); setFlash({ ok: true, text: `Added ${name} to ${g.home} vs ${g.away}.` });
  }
  async function removeRef(g, name) { await setRefsFor(g, refsOf(g).filter((r) => r !== name)); }

  const divisionOf = makeDivisionOf(teamDivs);

  // Build dropdown choices from the schema + the games on hand, so the
  // selects work even before any games exist.
  const leagues = [...new Set([...(leagueOpts || []), ...games.map((g) => g.league).filter(Boolean)])].sort();
  // Scope by League first (matches admin Schedule's per-league loadSaved).
  const leagueScoped = games.filter((g) => !league || g.league === league);
  const divisionChoices = [...new Set(leagueScoped.map(divisionOf).filter(Boolean))].sort();
  const fieldChoices = [...new Set(leagueScoped.map((g) => g.location || "").filter(Boolean))].sort();
  const scoped = leagueScoped.filter((g) => {
    if (filterDivision && divisionOf(g) !== filterDivision) return false;
    if (filterField && (g.location || "") !== filterField) return false;
    return true;
  });

  // Group by Week → Division → games (sorted by time, then field) — same
  // structure the admin Saved schedule renders.
  const weeks = [];
  for (const g of scoped) {
    let wk = weeks.find((w) => w.week === g.week);
    if (!wk) { wk = { week: g.week, date: g.date, games: [] }; weeks.push(wk); }
    wk.games.push(g);
  }
  weeks.sort((a, b) => (a.week - b.week));

  const assignedCount = scoped.filter((g) => refsOf(g).length).length;
  const conflicts = findConflicts(scoped);
  const conflictCount = conflicts.referee.length + conflicts.field.length + conflicts.team.length;

  return (
    <div>
      <div className="page-head"><h1>Assign referees</h1><div className="muted">Put one or more officials on each game. Games appear by week and division — the same view the league admin sees. Refs are visible to officials as soon as you save.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      <RefAiBox onAsk={onAsk} />

      {conflictCount > 0 && (
        <div className="card" style={{ borderColor: "var(--danger)", background: "var(--danger-soft)" }}>
          <h3 style={{ margin: "0 0 4px" }}>{conflictCount} scheduling conflict{conflictCount !== 1 ? "s" : ""}</h3>
          <div className="muted small" style={{ marginBottom: 8 }}>No team or referee can be in two places at once, and a field hosts one game at a time. Fix these:</div>
          <div className="stack" style={{ gap: 6 }}>
            {conflicts.referee.map((c, i) => <div className="issue-item" key={`r${i}`}><b>{c.referee}</b> is booked on {c.games.length} games at {c.time}{c.date ? ` · ${fmtDate(c.date)}` : ""}: {c.games.map((g) => `${g.home} vs ${g.away}${g.location ? ` (${g.location})` : ""}`).join("; ")}.</div>)}
            {conflicts.field.map((c, i) => <div className="issue-item" key={`f${i}`}><b>{c.location}</b> has {c.games.length} games at {c.time}{c.date ? ` · ${fmtDate(c.date)}` : ""}: {c.games.map((g) => `${g.home} vs ${g.away}`).join("; ")}.</div>)}
            {conflicts.team.map((c, i) => <div className="issue-item" key={`t${i}`}><b>{c.team}</b> plays {c.games.length} games at {c.time}{c.date ? ` · ${fmtDate(c.date)}` : ""}.</div>)}
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
          <div><label className="fld">League</label>
            <select value={league} onChange={(e) => { setLeague(e.target.value); setFilterDivision(""); setFilterField(""); }}>
              <option value="">All leagues</option>{leagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select></div>
          <div><label className="fld">Division</label>
            <select value={filterDivision} onChange={(e) => setFilterDivision(e.target.value)}>
              <option value="">All divisions</option>{divisionChoices.map((d) => <option key={d} value={d}>{d}</option>)}
            </select></div>
          <div><label className="fld">Field</label>
            <select value={filterField} onChange={(e) => setFilterField(e.target.value)}>
              <option value="">All fields</option>{fieldChoices.map((f) => <option key={f} value={f}>{f}</option>)}
            </select></div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          {assignedCount} of {scoped.length} games have a referee.
          {!refs.length ? " Add referees first on the Referees page." : " You can put more than one ref on a game."}
        </div>
        {(filterDivision || filterField) && (
          <div className="muted small" style={{ marginTop: 4 }}>
            Showing {scoped.length} of {leagueScoped.length} games
            {filterDivision ? ` · division ${filterDivision}` : ""}
            {filterField ? ` · field ${filterField}` : ""}.{" "}
            <a onClick={() => { setFilterDivision(""); setFilterField(""); }}>Clear filters</a>
          </div>
        )}
      </div>

      {!games.length && <div className="card"><p className="muted" style={{ margin: 0 }}>No games yet. Build a schedule first.</p></div>}
      {games.length > 0 && !scoped.length && (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No games match the current filters. <a onClick={() => { setLeague(""); setFilterDivision(""); setFilterField(""); }}>Clear filters</a>.</p></div>
      )}

      {weeks.map((w) => {
        const byDiv = {};
        for (const g of w.games) { const d = divisionOf(g) || "No division"; (byDiv[d] = byDiv[d] || []).push(g); }
        const divKeys = Object.keys(byDiv).sort((a, b) => (a === "No division" ? 1 : b === "No division" ? -1 : String(a).localeCompare(String(b), undefined, { numeric: true })));
        return (
          <div className="card" key={w.week}>
            <div className="between" style={{ marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Week {w.week}</h3>
              <span className="chip">{w.date ? fmtDate(w.date) : "no date"} · {w.games.length} game{w.games.length !== 1 ? "s" : ""}</span>
            </div>
            {divKeys.map((dv) => (
              <div key={dv} style={{ marginBottom: 12 }}>
                <div className="fld" style={{ marginBottom: 4 }}>{dv}<span className="muted small"> · {byDiv[dv].length} game{byDiv[dv].length !== 1 ? "s" : ""}</span></div>
                <div className="stack">
                  {byDiv[dv].slice().sort((a, b) =>
                    String(a.time || "").localeCompare(String(b.time || "")) ||
                    String(a.location || "").localeCompare(String(b.location || ""))
                  ).map((g) => (
                    <div className="drag-item" key={g.id} style={{ cursor: "default", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <span style={{ flex: "1 1 220px" }}>
                        <b>{g.home}</b> <span className="muted">vs</span> {g.away}
                        <span className="muted small"> · {g.location || "Field TBD"}</span>
                        {g.time ? <span className="chip" style={{ marginLeft: 6 }}>{g.time}</span> : null}
                      </span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                        {refsOf(g).map((r) => (
                          <span className="member" key={r}>{r}<button className="x" title="Remove" onClick={() => removeRef(g, r)}>×</button></span>
                        ))}
                        <select value="" onChange={(e) => { addRef(g, e.target.value); e.target.value = ""; }} style={{ flex: "0 0 auto", maxWidth: 160 }}>
                          <option value="">+ Add ref…</option>
                          {refs.filter((r) => !refsOf(g).includes(r)).map((r) => {
                            const busy = refBusyAt(games, r, g.date, g.time, g.id);
                            return <option key={r} value={r} disabled={!!busy}>{r}{busy ? ` — busy ${g.time}` : ""}</option>;
                          })}
                        </select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
