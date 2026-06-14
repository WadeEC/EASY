"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { refBusyAt } from "@/lib/conflicts.js";

const fmtDate = (iso) => { if (!iso) return ""; const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso); return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); };
const refsOf = (g) => String(g.referee || "").split(",").map((s) => s.trim()).filter(Boolean);

// Same divisionOf the admin Saved schedule uses — split "Division / Team",
// fall back to the player-derived map. Keeps Coverage in lock-step with what
// the admin sees on the same game so the day-of view shows the real divisions.
function makeDivisionOf(teamDivs) {
  return (g) => {
    const splitName = (s) => { const i = String(s || "").indexOf(" / "); return i > 0 ? s.slice(0, i) : ""; };
    return splitName(g.home) || splitName(g.away) || teamDivs[g.home] || teamDivs[g.away] || "";
  };
}

// Game-day coverage: re-assign referees to other fields in real time to cover
// absences. The selected week's games are grouped by Division → Field (same
// shape the admin Saved view shows for that week), with every game visible
// regardless of whether a ref is assigned yet.
export default function RefCoverage() {
  const [games, setGames] = useState([]);
  const [refs, setRefs] = useState([]);
  const [teamDivs, setTeamDivs] = useState({});
  const [week, setWeek] = useState(null);
  const [moving, setMoving] = useState(null);   // { ref, fromId } while relocating an official
  const [flash, setFlash] = useState(null);

  async function load() {
    try { await api.ensureReferees(); } catch {}
    const g = await api.scheduleList(null); setGames(g.games || []);
    try { const r = await api.records("referee"); setRefs((r.records || []).map((x) => x.name).filter(Boolean)); } catch {}
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

  const divisionOf = makeDivisionOf(teamDivs);

  const weekNums = [...new Set(games.map((g) => g.week))].sort((a, b) => a - b);
  const repDate = {};
  for (const g of games) { if (g.date && (!repDate[g.week] || g.date < repDate[g.week])) repDate[g.week] = g.date; }
  // Default to the week nearest today — that's "right now" on game day.
  useEffect(() => {
    if (week != null || !weekNums.length) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let best = weekNums[0], bestDiff = Infinity;
    for (const w of weekNums) {
      const d = repDate[w] ? new Date(repDate[w] + "T00:00:00") : null;
      const diff = d ? Math.abs(d - today) : Infinity;
      if (diff < bestDiff) { bestDiff = diff; best = w; }
    }
    setWeek(best);
  }, [games]); // eslint-disable-line

  const weekGames = games.filter((g) => g.week === week);
  const uncovered = weekGames.filter((g) => !refsOf(g).length);
  const working = {};
  for (const g of weekGames) for (const r of refsOf(g)) working[r] = (working[r] || 0) + 1;

  // Group week's games by Division → Field so the layout mirrors what the admin
  // Saved schedule shows for the same week. Every game appears, including
  // unassigned ones (highlighted as needing a referee).
  const byDiv = {};
  for (const g of weekGames) { const d = divisionOf(g) || "No division"; (byDiv[d] = byDiv[d] || []).push(g); }
  const divKeys = Object.keys(byDiv).sort((a, b) => (a === "No division" ? 1 : b === "No division" ? -1 : String(a).localeCompare(String(b), undefined, { numeric: true })));

  async function setRefsFor(g, list) { await api.scheduleAssignRef(g.id, list.join(", ")); }
  async function removeRef(g, name) { await setRefsFor(g, refsOf(g).filter((r) => r !== name)); await load(); setFlash({ ok: true, text: `Pulled ${name} off ${g.home} vs ${g.away}.` }); }
  async function addRef(g, name) {
    if (!name) return;
    const clash = refBusyAt(games, name, g.date, g.time, g.id);
    if (clash) { setFlash({ ok: false, text: `${name} is already on ${clash.home} vs ${clash.away}${clash.location ? ` (${clash.location})` : ""} at ${g.time}. A referee can't be in two places at once.` }); return; }
    await setRefsFor(g, [...refsOf(g), name]); await load(); setFlash({ ok: true, text: `Added ${name} to ${g.location || g.home}.` });
  }
  function canPlace(g) {
    if (!moving || g.id === moving.fromId) return false;
    if (refsOf(g).includes(moving.ref)) return false;
    return !refBusyAt(games, moving.ref, g.date, g.time, moving.fromId);
  }
  async function placeMove(toGame) {
    const { ref, fromId } = moving;
    const from = games.find((g) => g.id === fromId);
    if (from) await setRefsFor(from, refsOf(from).filter((r) => r !== ref));
    await setRefsFor(toGame, [...refsOf(toGame), ref]);
    setMoving(null); await load();
    setFlash({ ok: true, text: `Moved ${ref} to ${toGame.location || "field"} — ${toGame.home} vs ${toGame.away}.` });
  }
  async function markAbsent(name) {
    const theirs = weekGames.filter((g) => refsOf(g).includes(name));
    for (const g of theirs) await setRefsFor(g, refsOf(g).filter((r) => r !== name));
    await load();
    setFlash({ ok: true, text: `${name} marked absent — pulled from ${theirs.length} game${theirs.length !== 1 ? "s" : ""} this week. Those games need coverage now.` });
  }

  const gameRow = (g) => {
    const need = !refsOf(g).length;
    return (
      <div className="drag-item" key={g.id} style={{ cursor: "default", flexWrap: "wrap", gap: 8, alignItems: "center", borderLeft: need ? "4px solid var(--danger)" : undefined }}>
        <span style={{ flex: "1 1 220px" }}>
          {g.time ? <span className="chip" style={{ marginRight: 6 }}>{g.time}</span> : null}
          <b>{g.location || "Field TBD"}</b>
          <span className="muted small"> · {g.home} vs {g.away}</span>
          {need && <span className="chip" style={{ marginLeft: 6, background: "var(--danger-soft)", color: "var(--danger)" }}>Needs referee</span>}
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {refsOf(g).map((r) => (
            <span className="member" key={r}>{r}
              <button className="x" title={`Move ${r} to another field`} onClick={() => setMoving({ ref: r, fromId: g.id })}>→</button>
              <button className="x" title={`${r} absent — remove`} onClick={() => removeRef(g, r)}>×</button>
            </span>
          ))}
          {moving
            ? (canPlace(g)
              ? <button className="btn primary sm" onClick={() => placeMove(g)}>Place {moving.ref} here</button>
              : (g.id === moving.fromId ? <span className="muted small">moving from here</span> : <span className="muted small">unavailable</span>))
            : (
              <select value="" onChange={(e) => { addRef(g, e.target.value); e.target.value = ""; }} style={{ flex: "0 0 auto", maxWidth: 160 }}>
                <option value="">+ Add ref…</option>
                {refs.filter((r) => !refsOf(g).includes(r)).map((r) => {
                  const busy = refBusyAt(games, r, g.date, g.time, g.id);
                  return <option key={r} value={r} disabled={!!busy}>{r}{busy ? " — busy" : ""}</option>;
                })}
              </select>
            )}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div className="page-head"><h1>Coverage</h1><div className="muted">Re-assign referees to other fields in real time to cover last-minute absences. Same week-by-division layout the admin sees on the Saved schedule.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      {weekNums.length > 0 && (
        <div className="card">
          <label className="fld">Game day</label>
          <div className="btn-row" style={{ flexWrap: "wrap" }}>
            {weekNums.map((w) => (
              <button key={w} className={"btn" + (w === week ? " primary" : "")} onClick={() => { setWeek(w); setMoving(null); }}>
                Wk {w}{repDate[w] ? ` · ${fmtDate(repDate[w])}` : ""}
              </button>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {weekGames.length} game{weekGames.length !== 1 ? "s" : ""} this week · {uncovered.length} need{uncovered.length === 1 ? "s" : ""} a referee.
          </div>
        </div>
      )}

      {moving && (
        <div className="note" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
          Moving <b>{moving.ref}</b> — pick a game below to place them on a new field.
          <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={() => setMoving(null)}>Cancel</button>
        </div>
      )}

      {!weekNums.length && <div className="card"><p className="muted" style={{ margin: 0 }}>No games yet. Build a schedule first.</p></div>}

      {divKeys.map((dv) => {
        const list = byDiv[dv].slice().sort((a, b) =>
          String(a.time || "").localeCompare(String(b.time || "")) ||
          String(a.location || "").localeCompare(String(b.location || ""))
        );
        const need = list.filter((g) => !refsOf(g).length).length;
        return (
          <div className="card" key={dv}>
            <div className="between" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>{dv}</h3>
              <span className="chip">{list.length} game{list.length !== 1 ? "s" : ""}{need ? ` · ${need} need ref` : ""}</span>
            </div>
            <div className="stack">
              {list.map((g) => gameRow(g))}
            </div>
          </div>
        );
      })}

      {week != null && refs.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Referees this week</h3>
          <div className="stack">
            {refs.slice().sort((a, b) => (working[b] || 0) - (working[a] || 0) || a.localeCompare(b)).map((r) => (
              <div className="drag-item" key={r} style={{ cursor: "default" }}>
                <span><b>{r}</b> <span className="muted small">· {working[r] || 0} game{(working[r] || 0) !== 1 ? "s" : ""}</span></span>
                {working[r]
                  ? <button className="btn ghost sm" onClick={() => markAbsent(r)}>Mark absent</button>
                  : <span className="chip">available</span>}
              </div>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>“Mark absent” pulls a ref off every game this week so those fields show as needing coverage. Use “→” on a ref to move them to another field.</div>
        </div>
      )}
    </div>
  );
}
