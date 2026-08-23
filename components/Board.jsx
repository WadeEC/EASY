"use client";
import { useEffect, useRef, useState } from "react";
import { api, currentSeason } from "@/lib/api.js";
import { weekCountSummary } from "@/lib/ui.js";
import FieldInput from "./FieldInput.jsx";

const toISO = (d) => d.toISOString().slice(0, 10);
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
const fmtDate = (iso) => { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); };
const headFirst = (cs) => [...cs].sort((a, b) => (/head/i.test(b.role) ? 1 : 0) - (/head/i.test(a.role) ? 1 : 0));

export default function Board({ go }) {
  // The check-in week is shared with the kiosk: whatever the admin picks here
  // becomes the active week for /scanin and any other board surface. We start
  // with the current calendar week, then hydrate from the server-side setting
  // on mount. Changing the picker writes back so the kiosk picks it up.
  const defaultWeek = toISO(weekStart(new Date()));
  const [week, setWeek] = useState(defaultWeek);
  // The season's weeks, named and numbered by the server: numbering counts the
  // weeks that actually HAPPEN, so a cancelled Saturday gives up its number and
  // everything after it moves up. Any name can be overridden.
  const [weekList, setWeekList] = useState([{ week: defaultWeek, label: "Week 1", index: 1, current: true }]);
  const [weekCount, setWeekCount] = useState(10);   // what's showing in the box
  const [weekSaved, setWeekSaved] = useState(10);   // what's actually set
  const [weekConfirm, setWeekConfirm] = useState(null);   // the preview, awaiting a yes
  const [renaming, setRenaming] = useState(null);   // { week, label }
  const [league, setLeague] = useState("");
  const [division, setDivision] = useState("");
  const [data, setData] = useState(undefined);
  const [scanQ, setScanQ] = useState("");
  const [result, setResult] = useState(null);   // most-recent check-in shown in the side panel
  const [picks, setPicks] = useState(null);      // ambiguous matches
  const [flash, setFlash] = useState(null);
  const [edit, setEdit] = useState(null);   // player being edited
  const [vals, setVals] = useState({});
  const scanRef = useRef(null);

  // presentRef = set of player ids that were marked present in the LAST snapshot.
  // We use it to detect "new check-ins since I last polled" so the right side
  // panel can auto-pop the latest arrival without the admin clicking anything.
  const presentRef = useRef(new Set());
  const firstLoadRef = useRef(true);

  async function load() {
    const r = await api.boardData(week);
    const ok = r && Array.isArray(r.players);
    const next = ok ? { ...r, players: r.players, leagues: r.leagues || [] } : { players: [], leagues: [], error: (r && r.error) || "Could not load the board." };
    setData(next);
    // Detect new check-ins (player flipped from not-present → present since last
    // poll). The first load just seeds the baseline; from then on, any new
    // present player auto-opens in the side panel — but only if the admin
    // isn't already looking at someone else (don't yank the panel away).
    try {
      const nowPresent = new Set((next.players || []).filter((p) => p.present).map((p) => p.id));
      if (firstLoadRef.current) {
        firstLoadRef.current = false;
        presentRef.current = nowPresent;
      } else {
        const fresh = [...nowPresent].filter((id) => !presentRef.current.has(id));
        if (fresh.length && !result) {
          // Most recent fresh check-in (last id wins for stability).
          const lastId = fresh[fresh.length - 1];
          try {
            const det = await api.boardDetail({ player_id: lastId, week });
            if (det && det.player) setResult(det);
          } catch {}
        }
        presentRef.current = nowPresent;
      }
    } catch {}
  }
  // Hydrate the active week from the server on first mount, then build the
  // week-picker choices from the season schedule (with the current week
  // included so the picker always works even outside the season window).
  useEffect(() => {
    (async () => {
      try {
        const s = await api.activeWeekGet();
        if (s && s.week) setWeek(s.week);
        if (s && Array.isArray(s.weekList) && s.weekList.length) setWeekList(s.weekList);
        if (s && s.count) { setWeekCount(s.count); setWeekSaved(s.count); }
      } catch {}
    })();
    scanRef.current?.focus();
  }, []); // eslint-disable-line
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [week]);

  // Live sync with the kiosk. Two layers:
  //  1. Server-Sent Events: the kiosk emits "checkin" the instant a check-in
  //     lands. EventSource auto-reconnects on 5s if the link drops.
  //  2. A slow safety-net poll every 30s in case the SSE stream silently
  //     died behind a proxy. Pauses when the tab is hidden.
  useEffect(() => {
    let stopped = false;
    let es = null;
    function reload() { if (!document.hidden && !stopped) load(); }
    try {
      es = new EventSource("/api/events");
      es.addEventListener("checkin", reload);
    } catch {}
    const safety = setInterval(reload, 30_000);
    const onVis = () => { if (!document.hidden) reload(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      try { es?.close(); } catch {}
      clearInterval(safety);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line
  }, [week]);

  async function refreshWeeks(res) {
    if (res && Array.isArray(res.weeks) && res.weeks.length && typeof res.weeks[0] === "object") setWeekList(res.weeks);
    else { try { const s = await api.activeWeekGet(); if (s?.weekList?.length) setWeekList(s.weekList); } catch {} }
  }
  // Ask first — shortening a season takes weeks off the grid.
  async function askWeekCount(n) {
    const v = Math.max(1, Math.min(40, Math.floor(Number(n) || 0)));
    if (v === weekSaved) { setWeekCount(weekSaved); setWeekConfirm(null); return; }
    const pv = await api.weekCountPreview(v);
    if (pv && pv.error) { setFlash({ ok: false, text: pv.error }); setWeekCount(weekSaved); return; }
    setWeekConfirm(pv);
  }
  function cancelWeekCount() { setWeekConfirm(null); setWeekCount(weekSaved); }
  async function applyWeekCount() {
    const v = weekConfirm?.to;
    const res = await api.weekCountSet(v);
    setWeekConfirm(null);
    if (res && res.error) { setFlash({ ok: false, text: res.error }); setWeekCount(weekSaved); return; }
    setWeekSaved(v); setWeekCount(v);
    setFlash({ ok: true, text: `Season is now ${v} week${v === 1 ? "" : "s"}.` });
    await refreshWeeks(res);
  }
  async function saveWeekName() {
    if (!renaming) return;
    const res = await api.weekRename(renaming.week, renaming.label);
    setRenaming(null);
    if (res && res.error) return setFlash({ ok: false, text: res.error });
    await refreshWeeks(res);
  }
  async function toggleWeekCancelled(w) {
    const info = weekList.find((x) => x.week === w);
    const res = await api.weekCancel(w, !info?.cancelled);
    if (res && res.error) return setFlash({ ok: false, text: res.error });
    await refreshWeeks(res);
    setFlash({
      ok: true,
      text: info?.cancelled
        ? `${info.label} is back on — the weeks after it move down one.`
        : `${info?.label || "That week"} cancelled — it gives up its number and the weeks after it move up one.`,
    });
  }

  async function changeWeek(w) {
    setWeek(w);
    try { await api.activeWeekSet(w === defaultWeek ? "" : w); } catch {}
    setFlash({ ok: true, text: `Active check-in week set to ${fmtDate(w)} — kiosk uses this too.` });
  }

  async function doScan(query) {
    const res = await api.boardScan({ query, week });
    if (res.status === "ambiguous") { setPicks(res.matches); setResult(null); }
    else if (res.status === "not_found") { setFlash({ ok: false, text: `No match for “${query}”.` }); }
    else { setResult(res); setPicks(null); setFlash(null); await load(); }
  }
  async function pick(id) {
    const res = await api.boardScanId({ player_id: id, week });
    setPicks(null); setResult(res); await load();
  }
  // Clicking a player just opens their details — it does NOT check them in.
  async function openDetail(id) {
    const res = await api.boardDetail({ player_id: id, week });
    if (res && res.player) { setResult(res); setPicks(null); }
  }
  // The per-row Check in / Check out button.
  async function toggleRow(p) {
    await api.boardToggle({ player_id: p.id, player: p.name, week, present: !p.present });
    await load();
    if (result && result.player && result.player.id === p.id) { const r = await api.boardDetail({ player_id: p.id, week }); setResult(r); }
  }
  function onScanKey(e) {
    if (e.key !== "Enter" || !scanQ.trim()) return;
    if (suggestions.length) { pick(suggestions[0].id); setScanQ(""); }
    else { doScan(scanQ.trim()); setScanQ(""); }
  }
  function openEdit(p) { setEdit(p); setVals({ ...(p.data || {}) }); }
  async function saveEdit() {
    const res = await api.updateRecord(edit.id, vals);
    if (res && res.error) return setFlash({ ok: false, text: res.error });
    setEdit(null); setFlash({ ok: true, text: "Player details updated." }); await load();
  }

  if (data === undefined) return <div className="muted">Loading…</div>;

  // Build the columns. Teams are the usual case — but attendance is a record
  // about a PERSON, not about a roster, and the first weeks of a season happen
  // before the teams exist. This board used to drop everyone without a team,
  // so on week one it was empty and there was nothing to check in.
  //
  // Now players with no team get a column of their own, one per division, and
  // check in exactly the same way. When the teams are built they simply move
  // into their team's column.
  const NO_TEAM = "Not on a team yet";
  const units = {};
  for (const p of data.players) {
    const noTeam = !p.team;
    const key = (p.league || "") + "||" + (noTeam ? `${NO_TEAM}::${p.division || ""}` : p.team);
    (units[key] = units[key] || {
      league: p.league || "",
      team: noTeam ? NO_TEAM : p.team,
      noTeam,
      division: noTeam ? (p.division || "") : undefined,
      players: [],
    }).players.push(p);
  }
  const unitList = Object.values(units).map((u) => {
    if (u.noTeam) return u;                       // its division is already exact
    const counts = {};
    u.players.forEach((p) => { const d = p.division || "—"; counts[d] = (counts[d] || 0) + 1; });
    u.division = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    return u;
  });
  const teamCount = unitList.filter((u) => !u.noTeam).length;
  const noTeamCount = unitList.filter((u) => u.noTeam).reduce((n, u) => n + u.players.length, 0);
  // The server hands back the DEFINED brackets in age order (plus any stray
  // value still sitting on a record). Sorting the distinct values found on
  // teams is what filled this picker with "10, 11, 12, 4, 5, 7, 9" — those are
  // ages, sorted as text.
  const inPlay = new Set(unitList.filter((u) => !league || u.league === league).map((u) => u.division).filter(Boolean));
  const divOptions = (data.divisions || []).filter((d) => inPlay.has(d));
  for (const d of inPlay) if (!divOptions.includes(d)) divOptions.push(d);
  const filtered = unitList.filter((u) => (!league || u.league === league) && (!division || u.division === division));
  const groupKey = (u) => (league ? (u.division || "No division") : (u.league || "No league"));
  const groups = {};
  for (const u of filtered) (groups[groupKey(u)] = groups[groupKey(u)] || []).push(u);
  // Bracket order when grouping by division; alphabetical otherwise.
  const divRank = new Map((data.divisions || []).map((d, i) => [d, i]));
  const groupNames = Object.keys(groups).sort((a, b) => {
    if (!league) return a.localeCompare(b);
    const ra = divRank.has(a) ? divRank.get(a) : 9999;
    const rb = divRank.has(b) ? divRank.get(b) : 9999;
    return ra - rb || a.localeCompare(b, undefined, { numeric: true });
  });

  // Live type-ahead for the check-in box — matches as you type (name or key
  // tag), best matches first. Enter checks in the top match; clicking a row
  // checks in that player.
  const scanNeedle = scanQ.trim().toLowerCase();
  const suggestions = scanNeedle.length >= 2 && !picks
    ? data.players
        .filter((p) => {
          const nm = String(p.name || "").toLowerCase();
          const tag = String((p.data && (p.data.key_tag || p.data.scan_number)) || "");
          return nm.includes(scanNeedle) || (tag && tag.startsWith(scanNeedle));
        })
        .sort((a, b) => {
          const an = String(a.name || "").toLowerCase().startsWith(scanNeedle) ? 0 : 1;
          const bn = String(b.name || "").toLowerCase().startsWith(scanNeedle) ? 0 : 1;
          return an - bn || String(a.name || "").localeCompare(String(b.name || ""));
        })
        .slice(0, 8)
    : [];

  return (
    <div>
      <div className="between" style={{ alignItems: "flex-start" }}>
        <div className="page-head">
          <h1>Team Board <span className="chip brand lg">{currentSeason() === "*" ? "all seasons" : currentSeason()}</span></h1>
          <div className="muted">
            Check someone in on the right and their day shows there. Everything here — leagues,
            divisions, teams, attendance — belongs to <strong>{currentSeason() === "*" ? "every season at once" : currentSeason()}</strong>;
            switch seasons in the sidebar.
          </div>
        </div>
        {go && <button className="btn ghost sm" onClick={() => go({ page: "stations" })}>← Stations</button>}
      </div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      {data.error && <div className="note warn">{data.error} <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={load}>Retry</button></div>}

      <div className="board-split">
        {/* LEFT 2/3 — the board */}
        <div className="board-main">
          <div className="card">
            <div className="row" style={{ flexWrap: "wrap" }}>
              <div>
                <label className="fld">League</label>
                <select value={league} onChange={(e) => { setLeague(e.target.value); setDivision(""); }} style={{ minWidth: 180 }}>
                  <option value="">All leagues</option>
                  {data.leagues.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <div>
                {/* Divisions come from the brackets you defined, so this works
                    with or without a league picked, and with or without teams. */}
                <label className="fld">Division</label>
                <select value={division} onChange={(e) => setDivision(e.target.value)} style={{ minWidth: 170 }}>
                  <option value="">All divisions</option>
                  {divOptions.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label className="fld">Week</label>
                <select value={week} onChange={(e) => changeWeek(e.target.value)} style={{ minWidth: 260 }}
                  title="Active check-in week — the kiosk uses this too">
                  {weekList.map((w) => (
                    <option key={w.week} value={w.week}>
                      {w.label}{w.cancelled ? " (cancelled)" : ""}{w.recorded ? " ✓" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ alignSelf: "flex-end" }}>
                <div className="btn-row" style={{ gap: 6, whiteSpace: "nowrap" }}>
                  <button className="btn ghost sm"
                    onClick={() => { const w = weekList.find((x) => x.week === week); setRenaming({ week, label: w?.named ? w.label : "" }); }}
                    title="Name this week — Jamboree, Week 0, Picture Day">Rename</button>
                  <button className="btn ghost sm" onClick={() => toggleWeekCancelled(week)}
                    title="A cancelled week gives up its number; the weeks after it move up">
                    {weekList.find((x) => x.week === week)?.cancelled ? "Un-cancel" : "Cancel week"}
                  </button>
                </div>
              </div>
              <div>
                {/* How long the season runs. Attendance only — the schedule
                    builder's week count is a separate number for a separate job. */}
                <label className="fld">Weeks in season</label>
                <input type="number" min={1} max={40} value={weekCount} style={{ width: 84 }}
                  onChange={(e) => setWeekCount(e.target.value)}
                  onBlur={(e) => askWeekCount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") askWeekCount(e.target.value); if (e.key === "Escape") cancelWeekCount(); }}
                  title="How many weeks this season runs. Doesn't touch the schedule." />
              </div>
            </div>
            {weekConfirm && (() => {
              const { title, lines } = weekCountSummary(weekConfirm);
              return (
                <div className="card" style={{ marginTop: 10, padding: "10px 12px", borderLeft: "3px solid var(--brand)" }}>
                  <div className="between" style={{ alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <b>{title}</b>
                      {lines.map((l, i) => <div key={i} className="muted small">{l}</div>)}
                    </div>
                    <div className="btn-row">
                      <button className="btn ghost sm" onClick={cancelWeekCount}>Cancel</button>
                      <button className="btn primary sm" onClick={applyWeekCount}>Yes, {weekConfirm.to} weeks</button>
                    </div>
                  </div>
                </div>
              );
            })()}
            {renaming && (
              <div className="card" style={{ marginTop: 10, padding: "10px 12px" }}>
                <label className="fld">Name for {weekList.find((x) => x.week === renaming.week)?.label || "this week"}</label>
                <div className="addbar">
                  <input autoFocus value={renaming.label} placeholder="e.g. Jamboree, Picture Day — blank restores Week N"
                    onChange={(e) => setRenaming({ ...renaming, label: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") saveWeekName(); if (e.key === "Escape") setRenaming(null); }} />
                  <button className="btn primary" onClick={saveWeekName}>Save</button>
                  <button className="btn ghost" onClick={() => setRenaming(null)}>Cancel</button>
                </div>
                <div className="muted small" style={{ marginTop: 6 }}>
                  Leave it blank to go back to the automatic number. Numbering counts the weeks that
                  actually happen — cancel one and the next takes its number.
                </div>
              </div>
            )}
            <div className="muted small" style={{ marginTop: 8 }}>
              {(() => {
                const w = weekList.find((x) => x.week === week);
                if (!w) return "This week";
                return `${w.label} of ${weekCount}${w.cancelled ? " · cancelled" : ""}${w.recorded ? "" : " · nobody checked in yet"}`;
              })()} · {(() => {
                const t = filtered.filter((u) => !u.noTeam).length;
                const n = filtered.filter((u) => u.noTeam).reduce((a, u) => a + u.players.length, 0);
                const bits = [];
                if (t) bits.push(`${t} team${t === 1 ? "" : "s"}`);
                if (n) bits.push(`${n} not on a team`);
                return bits.length ? bits.join(" · ") : "nobody";
              })()} shown · <i>Kiosk uses this same week.</i>
            </div>
            <div className="addbar" style={{ marginTop: 12 }}>
              <input ref={scanRef} placeholder="Scan or type a name / ID to check in…" value={scanQ}
                onChange={(e) => setScanQ(e.target.value)} onKeyDown={onScanKey} />
              <button className="btn primary" onClick={() => { if (scanQ.trim()) { doScan(scanQ.trim()); setScanQ(""); } }}>Check in</button>
            </div>
            {suggestions.length > 0 && (
              <div className="find-results" style={{ marginTop: 10 }}>
                {suggestions.map((m) => (
                  <div className="between" key={m.id}
                    style={{ padding: "9px 12px", borderTop: "1px solid var(--line-soft)", cursor: "pointer" }}
                    onClick={() => { pick(m.id); setScanQ(""); }}>
                    <span className="small">
                      {m.name}
                      {m.team ? <span className="muted"> · {m.team}</span> : null}
                      {m.present ? <span className="muted"> · already checked in</span> : null}
                    </span>
                    <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); pick(m.id); setScanQ(""); }}>Check in</button>
                  </div>
                ))}
                <div className="muted small" style={{ padding: "6px 12px", borderTop: "1px solid var(--line-soft)" }}>
                  Press Enter to check in the top match.
                </div>
              </div>
            )}
            {picks && (
              <div className="find-results" style={{ marginTop: 10 }}>
                <div className="muted small" style={{ padding: "8px 12px" }}>More than one match — pick one:</div>
                {picks.map((m) => (
                  <div className="between" key={m.id} style={{ padding: "9px 12px", borderTop: "1px solid var(--line-soft)" }}>
                    <span className="small">{m.name}{m.team ? <span className="muted"> · {m.team}</span> : null}</span>
                    <button className="btn sm" onClick={() => pick(m.id)}>Check in</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="muted small" style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", alignItems: "center", margin: "10px 2px 0" }}>
            <span><span className="sdot ok" /> all clear</span>
            <span><span className="sdot bad" /> needs attention — jersey size, alerts, jersey not issued</span>
            <span>· click a player for details · use Check in to mark them present</span>
            <span>· teams are optional — pick a league (and a division) and check people in</span>
          </div>

          {!unitList.length && <div className="card"><p className="muted" style={{ margin: 0 }}>No players in this season yet.</p></div>}
          {unitList.length > 0 && filtered.length === 0 && <div className="card"><p className="muted" style={{ margin: 0 }}>Nothing matches this filter.</p></div>}
          {noTeamCount > 0 && (
            <div className="muted small" style={{ margin: "10px 2px 0" }}>
              {teamCount === 0
                ? `No teams built yet — check people in from the columns below, or scan them above. Attendance belongs to the player, so it carries over once the teams exist.`
                : `${noTeamCount} player${noTeamCount === 1 ? " has" : "s have"} no team yet — they're in their own column and check in the same way.`}
            </div>
          )}

          {groupNames.map((gname) => (
            <div key={gname} style={{ marginTop: 18 }}>
              <h2 style={{ margin: "0 2px 10px" }}>{gname}</h2>
              <div className="team-grid">
                {groups[gname].sort((a, b) => (a.noTeam ? 1 : 0) - (b.noTeam ? 1 : 0) || a.team.localeCompare(b.team, undefined, { numeric: true })).map((u) => (
                  <div className={"card team-col" + (u.noTeam ? " no-team" : "")} key={u.league + u.team + (u.division || "")}>
                    <div className="between">
                      <h3 style={{ margin: 0 }}>{u.team}</h3>
                      <span className="chip">{u.players.filter((p) => p.present).length}/{u.players.length} in</span>
                    </div>
                    <div className="muted small" style={{ marginBottom: 6 }}>{[u.league, u.division || (u.noTeam ? "no division" : "")].filter(Boolean).join(" · ")}</div>
                    <div className="stack">
                      {u.players.map((p) => (
                        <div className={"drag-item" + (p.present ? " in" : "")} key={p.id}
                          onClick={() => openDetail(p.id)} style={{ cursor: "pointer" }}
                          title={p.status === "clear" ? "All clear — click for details" : (p.issues || []).join(" · ")}>
                          <span>
                            <span className={"sdot " + (p.status === "clear" ? "ok" : "bad")} />
                            {p.name}{p.data && p.data.notes ? <span className="muted small" style={{ display: "block", fontStyle: "italic" }}>Note: {p.data.notes}</span> : null}
                          </span>
                          <div className="ci-right">
                            <button className={"btn sm" + (p.present ? "" : " primary")} onClick={(e) => { e.stopPropagation(); toggleRow(p); }}>{p.present ? "Check out" : "Check in"}</button>
                            <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); openEdit(p); }}>Edit</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* RIGHT — info panel down the whole side; fills in when someone checks in */}
        <aside className="board-side">
          <div className="card board-side-card" style={{ marginBottom: 0 }}>
            <h2 style={{ marginTop: 0, marginBottom: 4 }}>Check-in details</h2>
            <div className="muted small">Check someone in (left) or scan above — their status, team, coach, jersey and notes show here.</div>
            {/* The panel is taller than the window on a laptop, so the notes box
                and the Check out button used to be below the fold with no way
                to reach them. The header stays put; everything under it scrolls. */}
            <div className="board-side-scroll">
              {result
                ? <ScanPanel key={result.player.id} data={result} week={week} fields={data.fields || []} onSaved={load} onClear={() => setResult(null)} />
                : <div className="muted small board-empty">No one checked in yet. Use the check-in box on the left and their day shows here.</div>}
            </div>
          </div>
        </aside>
      </div>

      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 4 }}>Edit {edit.name}</h2>
            <div className="muted small" style={{ marginBottom: 8 }}>Update this player’s details.</div>
            {(data.fields || []).map((f) => <FieldInput key={f.name} field={f} value={vals[f.name]} onChange={(v) => setVals({ ...vals, [f.name]: v })} />)}
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

// Inline staff check-in detail shown in the right-hand panel.
function ScanPanel({ data, week, fields = [], onSaved, onClear }) {
  const [notes, setNotes] = useState(data.notes || "");
  const [saved, setSaved] = useState(false);
  const [issued, setIssued] = useState(!!data.jerseyIssued);
  const [size, setSize] = useState(data.jerseySize || "");
  const [confirmedAt, setConfirmedAt] = useState(data.sizeConfirmedAt || "");
  const [sizeErr, setSizeErr] = useState("");
  const [present, setPresent] = useState(data.status !== "checked_out");
  const p = data.player;
  // The sizes the league actually stocks, from the field itself.
  let sizeOpts = [];
  try {
    const f = fields.find((x) => x.name === "jersey_size");
    sizeOpts = f && f.options ? (typeof f.options === "string" ? JSON.parse(f.options) : f.options) : [];
  } catch { sizeOpts = []; }
  // keep the checklist live as the jersey checkbox toggles
  // Keep the checklist live as the jersey checkbox and the size change — the
  // whole point of editing here is that the red item goes away in front of you.
  const issues = (data.issues || [])
    .filter((i) => i !== "Jersey not issued" && i !== "No jersey size")
    .concat(size ? [] : ["No jersey size"])
    .concat(issued ? [] : ["Jersey not issued"]);
  async function saveNote() { await api.boardNote({ player_id: p.id, notes }); setSaved(true); onSaved && onSaved(); setTimeout(() => setSaved(false), 1500); }
  async function toggleJersey(v) { setIssued(v); await api.boardSetJersey(p.id, v); onSaved && onSaved(); }
  async function changeSize(v) {
    const prev = size;
    setSize(v); setSizeErr("");
    const res = await api.boardSetJerseySize(p.id, v);
    if (res && res.error) { setSize(prev); setSizeErr(res.error); return; }
    setConfirmedAt(res.size_confirmed_at || "");
    onSaved && onSaved();
  }
  async function togglePresent() { const np = !present; setPresent(np); await api.boardToggle({ player_id: p.id, player: p.name, week, present: np }); onSaved && onSaved(); }

  return (
    <div style={{ marginTop: 14 }}>
      <div className={"scan-result " + (present ? "good" : "warn")} style={{ marginBottom: 12 }}>
        <div className="r-name">{p.name}</div>
        <div className="r-sub">{present ? "Checked in ✓" : "Not checked in"}{p.division ? ` · ${p.division}` : ""}</div>
      </div>

      <div className="status-box" style={{ marginBottom: 12 }}>
        {issues.length === 0
          ? <div className="status-clear"><span className="sdot ok" /> All clear — good to go</div>
          : (
            <>
              <div className="kr-label" style={{ marginBottom: 6 }}><span className="sdot bad" /> Needs attention</div>
              <div className="stack" style={{ gap: 5 }}>
                {issues.map((it) => <div key={it} className="issue-item">{it}</div>)}
              </div>
            </>
          )}
      </div>

      <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
        <div className="kr-cell"><div className="kr-label">Team</div><div className="kr-val">{data.team || "Not assigned"}</div></div>
        <div className="kr-cell"><div className="kr-label">Field</div><div className="kr-val">{data.field || "TBD"}</div></div>
        <div className="kr-cell"><div className="kr-label">Coach</div><div className="kr-val">{data.coaches.length ? headFirst(data.coaches).map((c) => c.name + (/head/i.test(c.role) ? " (H)" : "")).join(", ") : "TBD"}</div></div>
      </div>

      <div className="kr-cell" style={{ marginBottom: 12 }}>
        <div className="kr-label">Jersey distribution</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          <span className="small">Size</span>
          {sizeOpts.length ? (
            <select value={size} onChange={(e) => changeSize(e.target.value)} style={{ width: "auto", minWidth: 92 }}>
              <option value="">— not set —</option>
              {sizeOpts.map((o) => <option key={o} value={o}>{o}</option>)}
              {size && !sizeOpts.includes(size) && <option value={size}>{size}</option>}
            </select>
          ) : (
            <input value={size} onChange={(e) => setSize(e.target.value)} onBlur={(e) => changeSize(e.target.value)}
              placeholder="e.g. YL" style={{ width: 100 }} />
          )}
          <span className="muted small">{confirmedAt ? `confirmed ✓ ${String(confirmedAt).slice(0, 10)}` : "picking a size confirms it"}</span>
        </div>
        {sizeErr && <div className="muted small" style={{ color: "var(--bad, #c0392b)", marginTop: 4 }}>{sizeErr}</div>}
        <label className="small" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={issued} onChange={(e) => toggleJersey(e.target.checked)} />
          {size ? `Size ${size} — ` : "No size set — "}{issued ? "issued ✓" : "not issued yet"}
        </label>
        <div className="muted small" style={{ marginTop: 6 }}>
          Press clearance needs both: the size confirmed here <i>and</i> the jersey issued —
          plus at least one of the first two weeks attended.
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div className="kr-label" style={{ marginBottom: 4 }}>Game times for the day</div>
        {data.games && data.games.length
          ? <div className="stack" style={{ gap: 6 }}>{data.games.slice(0, 4).map((g, i) => (
              <div className="drag-item" key={i} style={{ cursor: "default" }}>
                <span>vs <b>{g.vs || "TBD"}</b>{g.location ? ` · ${g.location}` : ""}</span>
                <span className="muted small">{[fmtDate(g.date), g.time].filter(Boolean).join(" ")}</span>
              </div>))}</div>
          : <div className="muted small">No games scheduled yet.</div>}
      </div>

      <label className="fld">Status notes</label>
      <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. picked up by grandparent, allergy, needs jersey…" />
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={saveNote}>{saved ? "Saved ✓" : "Save notes"}</button>
        <button className="btn" onClick={togglePresent}>{present ? "Check out" : "Check in"}</button>
        <button className="btn ghost" onClick={onClear}>Clear</button>
      </div>
    </div>
  );
}
