"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { divisionChoices, resolveDivision, leagueChoices } from "@/lib/ui.js";

const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

// End-of-season player ranking (1-5). Recurring each season; feeds the team builder
// (FR-2.10) as the skill input the next season so teams stay balanced.
export default function RankingsPage({ go }) {
  const [players, setPlayers] = useState(undefined);   // array of {id,name,rank,team,division,league,season}
  const [divRecs, setDivRecs] = useState([]);          // the defined age brackets
  const [pFields, setPFields] = useState([]);          // the player schema (for the league list)
  const [status, setStatus] = useState({ ranked: 0, total: 0, balanceOn: false, season: "" });
  const [league, setLeague] = useState("");
  const [division, setDivision] = useState("");
  const [team, setTeam] = useState("");
  const [q, setQ] = useState("");
  const [seasonLabel, setSeasonLabel] = useState("");
  const [flash, setFlash] = useState(null);

  async function load() {
    try { await api.rankingEnsure(); } catch {}
    const r = await api.records("player");
    if (!r || !Array.isArray(r.records)) { setPlayers([]); setFlash({ ok: false, text: (r && r.error) || "Could not load players." }); return; }
    // Scope to the sidebar's season picker (untagged players show everywhere).
    let sn = "";
    try { sn = (typeof localStorage !== "undefined" && localStorage.getItem("ff_season")) || ""; } catch {}
    const inScope = (x) => {
      if (!sn) return true;
      const s = parse(x.data).season ? String(parse(x.data).season) : "";
      return sn === "(no season)" ? !s : s === sn;
    };
    setPlayers(r.records.filter(inScope).map((x) => {
      const d = parse(x.data);
      return { id: x.id, name: x.name || d.full_name || `#${x.id}`, rank: Number(d.end_season_rank) || 0, team: d.team || "", division: d.division || "", age: d.age, league: d.league || "", season: d.rank_season || "" };
    }));
    try { const sc = await api.schema("player"); setPFields(sc.fields || []); } catch { setPFields([]); }
    try {
      const dv = await api.records("division");
      setDivRecs((dv.records || []).map((x) => { const d = parse(x.data); return { id: x.id, name: x.name || d.name || `#${x.id}`, league: d.league || "", age_min: d.age_min, age_max: d.age_max }; }));
    } catch { setDivRecs([]); }
    try { const s = await api.rankingStatus(); if (s && !s.error) { setStatus(s); if (s.season && !seasonLabel) setSeasonLabel(s.season); } } catch {}
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);
  if (players === undefined) return <div className="muted">Loading…</div>;

  async function setRank(p, v) {
    const next = v === p.rank ? 0 : v;   // tapping the current value clears it
    setPlayers((ps) => ps.map((x) => x.id === p.id ? { ...x, rank: next } : x));
    await api.updateRecord(p.id, { end_season_rank: next || "" });
    try { setStatus(await api.rankingStatus()); } catch {}
  }
  async function toggleBalance() {
    const res = await api.rankingBalance(!status.balanceOn);
    if (res && !res.error) { setStatus(res); setFlash({ ok: true, text: res.balanceOn ? "Team builder will balance by these rankings next season." : "Ranking is no longer used to balance teams." }); }
  }
  async function finalize() {
    if (!status.ranked) { setFlash({ ok: false, text: "Rank some players first." }); return; }
    const res = await api.rankingFinalize(seasonLabel.trim());
    if (res && !res.error) { setFlash({ ok: true, text: `Locked in ${res.finalized} rankings${seasonLabel ? ` for ${seasonLabel.trim()}` : ""}. They will balance next season's teams.` }); await load(); }
  }

  const leagues = leagueChoices(pFields, players.map((p) => p.league));
  // Defined brackets, youngest first — not the distinct strings on players.
  const divisions = divisionChoices(divRecs, league).map((c) => c.value);
  const divOf = (p) => resolveDivision(divRecs, p);
  const teams = [...new Set(players.filter((p) => (!league || p.league === league) && (!division || divOf(p) === division)).map((p) => p.team).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const shown = players.filter((p) =>
    (!league || p.league === league) && (!division || divOf(p) === division) && (!team || p.team === team) &&
    (!q || p.name.toLowerCase().includes(q.toLowerCase()))
  ).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div className="page-head"><h1>Player Rankings</h1><div className="muted">Rank each player 1–5 at the end of the season. Next season these become the team builder’s skill input, so teams stay balanced.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      <div className="card">
        <div className="between" style={{ flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
          <div>
            <div><b>{status.ranked}</b> of <b>{status.total}</b> players ranked{status.season ? ` · last finalized: ${status.season}` : ""}.</div>
            <label className="small" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={!!status.balanceOn} onChange={toggleBalance} />
              Use these rankings to balance teams (FR-2.10) when building next season
            </label>
          </div>
          <div style={{ minWidth: 240 }}>
            <label className="fld">Season label</label>
            <div className="aibar">
              <input placeholder="e.g. 2025 Fall" value={seasonLabel} onChange={(e) => setSeasonLabel(e.target.value)} />
              <button className="btn" onClick={finalize}>Finalize season</button>
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>Finalizing saves this season’s ranks to each player’s history.</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div><label className="fld">League</label>
            <select value={league} onChange={(e) => { setLeague(e.target.value); setDivision(""); setTeam(""); }}>
              <option value="">All leagues</option>{leagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select></div>
          <div><label className="fld">Division</label>
            <select value={division} onChange={(e) => { setDivision(e.target.value); setTeam(""); }}>
              <option value="">All divisions</option>{divisions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select></div>
          <div><label className="fld">Team</label>
            <select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All teams</option>{teams.map((t) => <option key={t} value={t}>{t}</option>)}
            </select></div>
          <div style={{ flex: "1 1 200px" }}><label className="fld">Search</label><input placeholder="Find a player…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>{shown.length} player{shown.length !== 1 ? "s" : ""} · tap a number to set the rank, tap it again to clear. 1 = developing, 5 = top.</div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Player</th><th>Team</th><th style={{ width: 230 }}>End-of-Season Rank</th></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b>{p.season ? <div className="muted small">ranked {p.season}</div> : null}</td>
                <td>{[p.team, divOf(p)].filter(Boolean).join(" · ") || <span className="muted">—</span>}</td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    {[1, 2, 3, 4, 5].map((v) => (
                      <button key={v} className={"btn sm" + (p.rank === v ? " primary" : " ghost")} style={{ minWidth: 34 }} onClick={() => setRank(p, v)}>{v}</button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={3} className="muted" style={{ padding: 16 }}>No players match this filter.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
