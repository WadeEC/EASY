"use client";
import { useEffect, useMemo, useState } from "react";
import { api, currentSeason } from "@/lib/api.js";

const toISO = (d) => d.toISOString().slice(0, 10);
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }

// Attendance, two ways.
//
//   This week — one week as a sheet you fill in and save. Every player on the
//   roster is a row, and the answer is Present / Absent / Excused / not taken
//   yet. Those are four different facts; the old grid had a tick or a blank and
//   the blank meant both "wasn't here" and "nobody took attendance", which is
//   why an exported week couldn't be trusted.
//
//   Season grid — every week at a glance, still tap-to-toggle.
//
// Both read and write the same records the Team Board and the kiosk scanner
// use, so a kid scanned in at the door is already ticked here.
const STATUSES = [
  { key: "present", label: "Present", short: "P" },
  { key: "absent", label: "Absent", short: "A" },
  { key: "excused", label: "Excused", short: "E" },
];

export default function Attendance({ go }) {
  const thisWeek = toISO(weekStart(new Date()));
  // The grid is the view people live in — the whole season at a glance. "This
  // week" is the thing you open deliberately on a Saturday.
  const [tab, setTab] = useState("grid");
  const [week, setWeek] = useState(thisWeek);
  const [league, setLeague] = useState("");
  const [division, setDivision] = useState("");
  const [team, setTeam] = useState("");

  const [grid, setGrid] = useState(undefined);      // season grid
  const [sheet, setSheet] = useState(undefined);    // one week
  const [draft, setDraft] = useState({});           // id -> { status, note }
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);

  const season = currentSeason();
  const seasonLabel = season === "*" ? "all seasons" : season;
  // How many weeks this season runs. It's a decision, not something read off
  // the schedule — a league takes attendance on weeks it never scheduled a
  // game for, and the schedule builder's week count is a separate number.
  const [weekCount, setWeekCount] = useState(10);
  const [weekBusy, setWeekBusy] = useState(false);

  async function loadGrid() {
    const r = await api.attendanceReport({ week, league: league || null, division: division || null, team: team || null });
    const ok = r && Array.isArray(r.players);
    setGrid(ok
      ? { leagues: r.leagues || [], divisions: r.divisions || [], teams: r.teams || [], players: r.players || [], weeks: r.weeks || [], weekList: r.weekList || [], totalWeeks: r.totalWeeks || 0, error: null }
      : { leagues: [], divisions: [], teams: [], players: [], weeks: [], weekList: [], totalWeeks: 0, error: (r && r.error) || "Could not load attendance." });
  }

  async function loadSheet() {
    const r = await api.attendanceWeekSheet({ week, league: league || null, division: division || null, team: team || null });
    setSheet(r && !r.error ? r : { rows: [], weeks: [], totals: {}, error: (r && r.error) || "Could not load this week." });
    setDraft({});
  }

  async function loadWeekCount() {
    try { const s2 = await api.activeWeekGet(); if (s2 && s2.count) setWeekCount(s2.count); } catch {}
  }
  async function changeWeekCount(n) {
    const v = Math.max(1, Math.min(40, Math.floor(Number(n) || 0)));
    setWeekCount(v);
    setWeekBusy(true);
    const res = await api.weekCountSet(v);
    setWeekBusy(false);
    if (res && res.error) { setFlash({ bad: true, text: res.error }); return; }
    await loadGrid();
    if (tab === "week") await loadSheet();
  }
  useEffect(() => { loadWeekCount(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { loadGrid(); /* eslint-disable-next-line */ }, [league, division, team]);
  useEffect(() => { if (tab === "week") loadSheet(); /* eslint-disable-next-line */ }, [tab, week, league, division, team]);

  // ---------------------------------------------------------------- week sheet
  // Everything hook-shaped stays above the loading guard — React counts hooks
  // per render, so an early return in front of a useMemo blows the page up.
  const rows = sheet?.rows || [];
  const effective = (r) => (draft[r.id]?.status ?? r.status);
  const effectiveNote = (r) => (draft[r.id]?.note ?? r.note ?? "");
  const dirty = Object.keys(draft).length;

  const liveTotals = useMemo(() => {
    const t = { present: 0, absent: 0, excused: 0, not_taken: 0 };
    for (const r of rows) {
      const st = draft[r.id]?.status ?? r.status;
      if (st === "present") t.present++;
      else if (st === "absent") t.absent++;
      else if (st === "excused") t.excused++;
      else t.not_taken++;
    }
    return t;
  }, [rows, draft]);

  if (grid === undefined) return <div className="muted">Loading…</div>;

  const setStatus = (r, status) =>
    setDraft((d) => ({ ...d, [r.id]: { status: effective(r) === status ? "" : status, note: effectiveNote(r) } }));
  const setNote = (r, note) =>
    setDraft((d) => ({ ...d, [r.id]: { status: effective(r), note } }));

  const markAll = (status) =>
    setDraft(() => Object.fromEntries(rows.map((r) => [r.id, { status, note: effectiveNote(r) }])));

  // "Everyone who wasn't scanned in is absent" — the one bulk action that
  // actually saves time on a Saturday, and it never overwrites a real answer.
  const fillBlanksAbsent = () =>
    setDraft((d) => {
      const next = { ...d };
      for (const r of rows) if (!effective(r)) next[r.id] = { status: "absent", note: effectiveNote(r) };
      return next;
    });

  async function save() {
    const entries = Object.entries(draft).map(([id, v]) => {
      const r = rows.find((x) => String(x.id) === String(id));
      return { id: Number(id), name: r?.name || "", status: v.status || "clear", note: v.note || "" };
    });
    if (!entries.length) return;
    setBusy(true);
    const res = await api.attendanceSaveWeek(week, entries);
    setBusy(false);
    if (res.error) { setFlash({ bad: true, text: res.error }); return; }
    setFlash({
      bad: res.blocked > 0,
      text: `Saved ${res.saved} for ${weekName(week, weeks.indexOf(week))}` +
        (res.blocked ? ` · ${res.blocked} refused: ${res.blocked_details?.[0]?.reason || ""}` : "") +
        ` — ${res.totals.present} present, ${res.totals.absent} absent, ${res.totals.excused} excused.`,
    });
    await loadSheet();
    await loadGrid();
  }

  const weeks = sheet?.weeks?.length ? sheet.weeks : grid.weeks;
  const weekIdx = weeks.indexOf(week);
  // Week 1, Week 2, Week 3. Nobody checking a kid in thinks "Sunday the 16th".
  const wl = (grid.weekList && grid.weekList.length ? grid.weekList : (sheet?.weekList || []));
  const weekInfo = (w) => wl.find((x) => x.week === w) || null;
  const weekName = (w, i) => {
    const info = weekInfo(w);
    if (info) return info.label;
    return `Week ${i + 1}`;
  };
  const dl = (format) => api.exportUrl({ week, league: league || null, format, scope: "attendance" });
  const dlAll = (format) => api.exportUrl({ league: league || null, format, scope: "attendance" });

  async function toggleGrid(p, wi) {
    const w = grid.weeks[wi];
    const res = await api.attendanceToggle({ player_id: p.id, player: p.name, week: w, present: !p.present[wi], via: "grid" });
    if (res?.error) { setFlash({ bad: true, text: res.error }); return; }
    await loadGrid();
    if (w === week) await loadSheet();
  }

  return (
    <div>
      <div className="page-head">
        <h1>Attendance</h1>
        <span className="chip brand lg">{seasonLabel}</span>
      </div>
      <p className="muted">
        The same check-ins the Team Board and the kiosk write — scan a player in at the door and
        they&apos;re already ticked here.
      </p>

      {flash && <div className={"card " + (flash.bad ? "bad" : "")}><p style={{ margin: 0 }}>{flash.text}</p></div>}
      {grid.error && <div className="note warn">{grid.error} <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={loadGrid}>Retry</button></div>}

      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button className={"pill" + (tab === "week" ? " active" : "")} onClick={() => setTab("week")}>This week</button>
        <button className={"pill" + (tab === "grid" ? " active" : "")} onClick={() => setTab("grid")}>Season grid</button>
      </div>

      <div className="card">
        <div className="row">
          <div>
            <label className="fld">League</label>
            <select value={league} onChange={(e) => { setLeague(e.target.value); setDivision(""); setTeam(""); }}>
              <option value="">All leagues</option>
              {grid.leagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Division</label>
            <select value={division} onChange={(e) => setDivision(e.target.value)}>
              <option value="">All divisions</option>
              {grid.divisions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Team</label>
            <select value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">All teams</option>
              {grid.teams.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Weeks in season</label>
            <input type="number" min={1} max={40} value={weekCount} style={{ width: 88 }} disabled={weekBusy}
              onChange={(e) => setWeekCount(e.target.value)}
              onBlur={(e) => changeWeekCount(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") changeWeekCount(e.target.value); }}
              title="How many weeks this season runs. Nothing to do with the schedule builder." />
          </div>
          {tab === "week" && (
            <div>
              <label className="fld">Week</label>
              <select value={week} onChange={(e) => setWeek(e.target.value)} style={{ minWidth: 150 }}>
                {!weeks.includes(week) && <option value={week}>This week</option>}
                {weeks.map((w, i) => (
                  <option key={w} value={w}>
                    {weekName(w, i)}{weekInfo(w)?.cancelled ? " (cancelled)" : ""}{weekInfo(w)?.recorded ? " ✓" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------ one week */}
      {tab === "week" && (sheet === undefined ? <div className="muted">Loading…</div> : sheet.error ? (
        <div className="card"><p className="muted">{sheet.error}</p></div>
      ) : (
        <>
          <div className="card">
            <div className="between" style={{ flexWrap: "wrap", gap: 10 }}>
              <div>
                <strong>{weekName(week, weekIdx)}{weekInfo(week)?.cancelled ? " · cancelled" : ""}</strong>
                <div className="muted small">
                  {liveTotals.present} present · {liveTotals.absent} absent · {liveTotals.excused} excused ·{" "}
                  {liveTotals.not_taken} not taken · {rows.length} on the roster
                </div>
              </div>
              <div className="btn-row">
                <button className="btn sm" onClick={() => markAll("present")}>All present</button>
                <button className="btn sm" onClick={fillBlanksAbsent}>Rest absent</button>
                <button className="btn ghost sm" onClick={() => setDraft({})} disabled={!dirty}>Undo edits</button>
                <button className="btn primary" onClick={save} disabled={busy || !dirty}>
                  {busy ? "Saving…" : dirty ? `Save ${dirty}` : "Saved"}
                </button>
              </div>
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <a className="btn ghost sm" href={dl("csv")}>Download this week (CSV)</a>
              <a className="btn ghost sm" href={dl("xlsx")}>This week (Excel)</a>
              <a className="btn ghost sm" href={dlAll("xlsx")}>Whole season grid (Excel)</a>
              <a className="btn ghost sm" href={dlAll("csv")}>Whole season grid (CSV)</a>
            </div>
            {dirty > 0 && <p className="muted small" style={{ marginBottom: 0 }}>{dirty} unsaved change{dirty === 1 ? "" : "s"}. Nothing is written until you press Save.</p>}
          </div>

          {!rows.length ? (
            <div className="card"><p className="muted" style={{ margin: 0 }}>No players match this filter in {seasonLabel}.</p></div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: "auto" }}>
              <table className="tbl">
                <thead>
                  <tr><th>Player</th><th>Team</th><th style={{ width: 240 }}>Status</th><th>Note</th><th>Marked</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const st = effective(r);
                    const changed = draft[r.id] !== undefined;
                    return (
                      <tr key={r.id} style={changed ? { background: "var(--accent-soft, rgba(255,196,0,.10))" } : undefined}>
                        <td><b>{r.name}</b></td>
                        <td className="muted small">{r.team || r.division || "—"}</td>
                        <td>
                          <div className="btn-row">
                            {STATUSES.map((s) => (
                              <button key={s.key}
                                className={"pill" + (st === s.key ? " active" : "")}
                                title={`${s.label} — click again to clear`}
                                onClick={() => setStatus(r, s.key)}>{s.short}</button>
                            ))}
                            {!st && <span className="muted small" style={{ alignSelf: "center" }}>not taken</span>}
                          </div>
                        </td>
                        <td>
                          <input value={effectiveNote(r)} placeholder="—"
                            onChange={(e) => setNote(r, e.target.value)} style={{ width: "100%" }} />
                        </td>
                        <td className="muted small">
                          {r.marked_at ? `${r.marked_at.slice(0, 16).replace("T", " ")}${r.via ? ` · ${r.via}` : ""}${r.marked_by ? ` · ${r.marked_by}` : ""}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      ))}

      {/* --------------------------------------------------------- season grid */}
      {tab === "grid" && (
        <>
          <div className="card">
            <div className="between" style={{ flexWrap: "wrap", gap: 10 }}>
              <div className="muted small">
                {grid.players.length} players · {grid.totalWeeks} week{grid.totalWeeks !== 1 ? "s" : ""} recorded · tap a cell to toggle
              </div>
              <div className="btn-row">
                <a className="btn ghost sm" href={dlAll("xlsx")}>Download grid (Excel)</a>
                <a className="btn ghost sm" href={dlAll("csv")}>Download grid (CSV)</a>
              </div>
            </div>
          </div>

          {!grid.players.length
            ? <div className="card"><p className="muted" style={{ margin: 0 }}>No players match this filter.</p></div>
            : !grid.weeks.length
              ? <div className="card"><p className="muted" style={{ margin: 0 }}>No weeks yet — set how many weeks this season runs above.</p></div>
              : (
                <div className="card att-scroll" style={{ padding: 0 }}>
                  <table className="tbl att">
                    <thead>
                      <tr><th>Player</th>{grid.weeks.map((w, i) => {
                        const info = weekInfo(w);
                        return (
                          <th key={w} className={info?.cancelled || info?.beyond ? "muted" : undefined}>
                            {weekName(w, i)}
                            {info?.cancelled && <div className="att-wk-date">cancelled</div>}
                            {/* A week with attendance on it that falls outside the
                                season's week count. Kept so nothing is hidden, but
                                labelled so it isn't a mystery column. */}
                            {!info?.cancelled && info?.beyond && <div className="att-wk-date">extra — has check-ins</div>}
                          </th>
                        );
                      })}<th>Total</th></tr>
                    </thead>
                    <tbody>
                      {grid.players.map((p) => (
                        <tr key={p.id}>
                          <td><b>{p.name}</b>{(p.team || p.division) ? <div className="muted small">{[p.team, p.division].filter(Boolean).join(" · ")}</div> : null}</td>
                          {p.present.map((on, wi) => (
                            <td key={wi} className="attcell" onClick={() => toggleGrid(p, wi)} title="Tap to toggle">
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
        </>
      )}
    </div>
  );
}
