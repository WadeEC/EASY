"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api.js";

// Standings + scores in one place. Two tabs:
//   • Standings — computed wins/losses/ties/PF/PA/diff per team, grouped by league.
//   • Scores    — per-game entry; click a row to type in the home/away score (or
//                 mark a forfeit). Winner is derived automatically, fed into the
//                 standings tab, and exposed at /api/results for the league site.
//
// Both reads come from the same endpoints already used by the schedule page, so
// nothing here is "extra state" — these are the canonical records.

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: "short", day: "numeric" });
};
const isBlank = (v) => v == null || v === "";

function winnerLabel(g) {
  if (!g.winner) return "";
  if (g.winner === "home") return g.home;
  if (g.winner === "away") return g.away;
  if (g.winner === "tie") return "Tie";
  if (g.winner === "forfeit_home") return `${g.away} (forfeit win)`;
  if (g.winner === "forfeit_away") return `${g.home} (forfeit win)`;
  return g.winner;
}

// Inline score editor — opens when the user clicks a game row.
function ScoreEditor({ game, onSave, onClear, onCancel }) {
  const [home, setHome] = useState(isBlank(game.home_score) ? "" : String(game.home_score));
  const [away, setAway] = useState(isBlank(game.away_score) ? "" : String(game.away_score));
  // "" | "home" | "away" — forfeit means the OTHER team wins, no score required.
  const [forfeit, setForfeit] = useState(
    game.winner === "forfeit_home" ? "home" : game.winner === "forfeit_away" ? "away" : ""
  );
  const [note, setNote] = useState(game.score_note || "");
  const [err, setErr] = useState("");

  async function save() {
    setErr("");
    const body = { home_score: home, away_score: away, forfeit, note };
    const res = await onSave(body);
    if (res && res.error) setErr(res.error);
  }

  return (
    <div className="card" style={{ background: "var(--accent-soft)", borderColor: "var(--accent)", marginTop: 6 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
        <div><label className="fld">{game.home} (home)</label>
          <input inputMode="numeric" pattern="[0-9]*" style={{ width: 80 }} value={home} onChange={(e) => setHome(e.target.value)} disabled={!!forfeit} />
        </div>
        <div><label className="fld">{game.away} (away)</label>
          <input inputMode="numeric" pattern="[0-9]*" style={{ width: 80 }} value={away} onChange={(e) => setAway(e.target.value)} disabled={!!forfeit} />
        </div>
        <div><label className="fld">Forfeit</label>
          <select value={forfeit} onChange={(e) => setForfeit(e.target.value)}>
            <option value="">No forfeit</option>
            <option value="home">{game.home} forfeits</option>
            <option value="away">{game.away} forfeits</option>
          </select>
        </div>
        <div style={{ flex: "1 1 240px", minWidth: 200 }}>
          <label className="fld">Note (optional)</label>
          <input placeholder="e.g. weather-shortened, OT, makeup game" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      {err && <div className="note warn" style={{ marginTop: 8 }}>{err}</div>}
      <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
        <button className="btn primary" onClick={save}>Save result</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
        {game.winner ? <button className="btn danger" onClick={onClear}>Clear score</button> : null}
        <span className="muted small" style={{ marginLeft: "auto" }}>{game.score_by ? `Last edit: ${game.score_by}` : ""}</span>
      </div>
    </div>
  );
}

export default function Standings({ onAsk }) {
  const [games, setGames] = useState([]);
  const [leagueOpts, setLeagueOpts] = useState([]);
  const [league, setLeague] = useState("");
  const [tab, setTab] = useState("standings"); // "standings" | "scores"
  const [editing, setEditing] = useState(null); // game.id being edited
  const [flash, setFlash] = useState(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const g = await api.scheduleList(null);
      setGames(g.games || []);
    } catch {}
    try {
      const s = await api.schema("player");
      const lf = (s.fields || []).find((f) => f.name === "league");
      let opts = []; try { opts = lf && lf.options ? JSON.parse(lf.options) : []; } catch {}
      setLeagueOpts(opts.filter(Boolean));
    } catch {}
  }
  useEffect(() => { load(); }, []);

  // Pull league options from both the canonical league list AND any leagues
  // already represented on games — same pattern as the Referee page.
  const leagues = useMemo(
    () => [...new Set([...(leagueOpts || []), ...games.map((g) => g.league).filter(Boolean)])].sort(),
    [games, leagueOpts]
  );

  const scoped = useMemo(
    () => games.filter((g) => !league || g.league === league),
    [games, league]
  );
  const scored = scoped.filter((g) => g.winner);
  const unscored = scoped.filter((g) => !g.winner);

  // ---------- Standings (computed) ----------
  // Roll up W/L/T/PF/PA from scored games. Mirrors lib/tools.js getStandings, but
  // computed client-side so the table updates instantly after a save.
  const standings = useMemo(() => {
    const teams = {};
    const ensure = (team, lg) => (teams[team] = teams[team] || { team, league: lg || "", w: 0, l: 0, t: 0, pf: 0, pa: 0, gp: 0 });
    for (const g of scored) {
      if (!g.home || !g.away) continue;
      const h = ensure(g.home, g.league);
      const a = ensure(g.away, g.league);
      const hs = Number(g.home_score) || 0;
      const as = Number(g.away_score) || 0;
      h.gp++; a.gp++;
      h.pf += hs; h.pa += as; a.pf += as; a.pa += hs;
      if (g.winner === "tie") { h.t++; a.t++; }
      else if (g.winner === "home" || g.winner === "forfeit_away") { h.w++; a.l++; }
      else if (g.winner === "away" || g.winner === "forfeit_home") { a.w++; h.l++; }
    }
    return Object.values(teams).sort((a, b) =>
      (b.w - a.w) || (a.l - b.l) || ((b.pf - b.pa) - (a.pf - a.pa)) || a.team.localeCompare(b.team)
    );
  }, [scored]);

  // Group standings by league when no league is filtered, so the user sees one
  // tidy table per league instead of a single mixed list.
  const standingsGrouped = useMemo(() => {
    if (league) return [{ league, rows: standings }];
    const m = {};
    for (const r of standings) (m[r.league || "—"] = m[r.league || "—"] || []).push(r);
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0])).map(([lg, rows]) => ({ league: lg, rows }));
  }, [standings, league]);

  // ---------- Save / clear a score ----------
  async function saveScore(g, body) {
    setBusy(true); setFlash(null);
    const res = await api.gameSetScore(g.id, body);
    setBusy(false);
    if (res.error) return res;
    setEditing(null);
    setFlash({ ok: true, text: `Saved ${g.home} ${res.home_score ?? ""} – ${res.away_score ?? ""} ${g.away}.` });
    await load();
    return res;
  }
  async function clearScore(g) {
    setBusy(true); setFlash(null);
    const res = await api.gameClearScore(g.id);
    setBusy(false);
    if (res.error) { setFlash({ ok: false, text: res.error }); return; }
    setEditing(null);
    setFlash({ ok: true, text: `Cleared the score for ${g.home} vs ${g.away}.` });
    await load();
  }

  // Group scores list by week, then by date — easier for the admin to enter
  // results one Sunday at a time.
  const byWeek = useMemo(() => {
    const m = {};
    for (const g of scoped) (m[g.week || 0] = m[g.week || 0] || []).push(g);
    return Object.entries(m)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([w, list]) => ({ week: Number(w), games: list.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time))) }));
  }, [scoped]);

  // ---------- Export ----------
  // Direct link to the existing /api/results CSV — same record the public site reads.
  const csvHref = "/api/results?format=csv" + (league ? `&league=${encodeURIComponent(league)}` : "");

  return (
    <div>
      <div className="page-head">
        <h1>Standings &amp; Scores</h1>
        <div className="muted">Type in scores per game. Standings update automatically — head-to-head records also feed the public results feed.</div>
      </div>

      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
          <div><label className="fld">League</label>
            <select value={league} onChange={(e) => setLeague(e.target.value)}>
              <option value="">All leagues</option>
              {leagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div className="tabs" role="tablist" aria-label="Standings or scores" style={{ marginBottom: 0 }}>
            <button className={"tab" + (tab === "standings" ? " active" : "")} onClick={() => setTab("standings")}>Standings</button>
            <button className={"tab" + (tab === "scores" ? " active" : "")} onClick={() => setTab("scores")}>Scores</button>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <a className="btn" href={csvHref}>Download results CSV</a>
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          {scoped.length} game{scoped.length === 1 ? "" : "s"} in scope · {scored.length} scored · {unscored.length} still to score.
        </div>
      </div>

      {!scoped.length && (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No games yet. Build a schedule first.</p></div>
      )}

      {!!scoped.length && tab === "standings" && (
        standingsGrouped.map(({ league: lg, rows }) => (
          <div className="card" key={lg}>
            <div className="between" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>{lg}</h3>
              <span className="chip">{rows.length} team{rows.length === 1 ? "" : "s"}</span>
            </div>
            {!rows.length ? (
              <p className="muted" style={{ margin: 0 }}>No scored games yet — add a few scores on the Scores tab.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left" }}>
                      <th style={{ width: 36, padding: "6px 8px" }}>#</th>
                      <th style={{ padding: "6px 8px" }}>Team</th>
                      <th style={{ textAlign: "right", padding: "6px 8px" }}>W</th>
                      <th style={{ textAlign: "right", padding: "6px 8px" }}>L</th>
                      <th style={{ textAlign: "right", padding: "6px 8px" }}>T</th>
                      <th style={{ textAlign: "right", padding: "6px 8px" }}>GP</th>
                      <th style={{ textAlign: "right", padding: "6px 8px" }}>PF</th>
                      <th style={{ textAlign: "right", padding: "6px 8px" }}>PA</th>
                      <th style={{ textAlign: "right", padding: "6px 8px" }}>Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const cellStyle = { padding: "6px 8px", borderTop: "1px solid var(--line)" };
                      const numStyle = { ...cellStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" };
                      return (
                        <tr key={r.team}>
                          <td className="muted" style={cellStyle}>{i + 1}</td>
                          <td style={cellStyle}><b>{r.team}</b></td>
                          <td style={numStyle}>{r.w}</td>
                          <td style={numStyle}>{r.l}</td>
                          <td style={numStyle}>{r.t}</td>
                          <td style={numStyle}>{r.gp}</td>
                          <td style={numStyle}>{r.pf}</td>
                          <td style={numStyle}>{r.pa}</td>
                          <td style={numStyle}>{r.pf - r.pa > 0 ? "+" : ""}{r.pf - r.pa}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))
      )}

      {!!scoped.length && tab === "scores" && (
        byWeek.map(({ week, games: weekGames }) => (
          <div className="card" key={week}>
            <div className="between" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Week {week || "?"}</h3>
              <span className="chip">{weekGames.length} game{weekGames.length === 1 ? "" : "s"}</span>
            </div>
            <div className="stack">
              {weekGames.map((g) => {
                const isEditing = editing === g.id;
                const hasScore = !!g.winner;
                return (
                  <div key={g.id}>
                    <div
                      className="drag-item"
                      style={{ cursor: "pointer", alignItems: "center", gap: 8, flexWrap: "wrap" }}
                      onClick={() => setEditing(isEditing ? null : g.id)}
                    >
                      <span style={{ flex: "1 1 260px" }}>
                        <span className="muted">{fmtDate(g.date)}</span>
                        {g.time ? <span className="chip" style={{ margin: "0 6px" }}>{g.time}</span> : " · "}
                        <b>{g.home}</b> <span className="muted">vs</span> <b>{g.away}</b>
                        {g.location ? <span className="muted small"> · {g.location}</span> : null}
                      </span>
                      <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {hasScore ? (
                          <>
                            <span className="chip" style={{ background: "#dcfce7", color: "#166534", borderColor: "#86efac" }}>
                              {isBlank(g.home_score) ? "—" : g.home_score} – {isBlank(g.away_score) ? "—" : g.away_score}
                            </span>
                            <span className="muted small">Winner: {winnerLabel(g)}</span>
                          </>
                        ) : (
                          <span className="chip">No score yet</span>
                        )}
                        <button className="btn" disabled={busy} onClick={(e) => { e.stopPropagation(); setEditing(isEditing ? null : g.id); }}>
                          {isEditing ? "Close" : (hasScore ? "Edit" : "Enter score")}
                        </button>
                      </span>
                    </div>
                    {isEditing && (
                      <ScoreEditor
                        game={g}
                        onSave={(body) => saveScore(g, body)}
                        onClear={() => clearScore(g)}
                        onCancel={() => setEditing(null)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
