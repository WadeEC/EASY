"use client";
import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api.js";
import { findConflicts, refBusyAt } from "@/lib/conflicts.js";
import ConfirmDeleteModal from "./ConfirmDeleteModal.jsx";
import AiPromptBar from "./AiPromptBar.jsx";

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

// --- Schedule export for the league website (OQ-9: a static export the site can pull) ---
const pad2 = (n) => String(n).padStart(2, "0");
const fileSlug = (s) => (String(s || "all").trim().replace(/\s+/g, "-").toLowerCase() || "all");
function to24(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(t || ""));
  if (!m) return null;
  let h = +m[1]; const min = +m[2]; const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0;
  return { h, m: min };
}
function csvOfGames(games) {
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const head = ["Week", "Date", "Time", "League", "Home", "Away"].join(",");
  const rows = games.map((g) => [g.week, g.date, g.time, g.league, g.home, g.away].map(esc).join(","));
  return [head, ...rows].join("\r\n");
}
function htmlOfGames(games) {
  const e = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = games.map((g) => "    <tr><td>" + e(g.week) + "</td><td>" + e(g.date) + "</td><td>" + e(g.time || "") + "</td><td>" + e(g.home) + "</td><td>" + e(g.away) + "</td></tr>").join("\n");
  return '<table class="ff-schedule">\n  <thead><tr><th>Week</th><th>Date</th><th>Time</th><th>Home</th><th>Away</th></tr></thead>\n  <tbody>\n' + rows + "\n  </tbody>\n</table>";
}
function icsOfGames(games) {
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//E.A.S.Y//Schedule//EN", "CALSCALE:GREGORIAN"];
  for (const g of games) {
    const d = String(g.date || "").replace(/-/g, "");
    if (!d) continue;
    out.push("BEGIN:VEVENT");
    out.push("UID:game-" + (g.id || (g.week + "-" + g.home + "-" + g.away)) + "@flagfootball");
    const t = to24(g.time);
    out.push(t ? ("DTSTART:" + d + "T" + pad2(t.h) + pad2(t.m) + "00") : ("DTSTART;VALUE=DATE:" + d));
    out.push("SUMMARY:" + g.home + " vs " + g.away);
    if (g.league) out.push("LOCATION:" + g.league);
    out.push("END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return out.join("\r\n");
}
function downloadFile(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// --- Results record (who beat whom) — for the league website, NOT computed standings.
function _winnerLabel(g) {
  if (!g.winner) return "";
  if (g.winner === "home") return g.home;
  if (g.winner === "away") return g.away;
  if (g.winner === "tie") return "Tie";
  if (g.winner === "forfeit_home") return `${g.away} (forfeit)`;
  if (g.winner === "forfeit_away") return `${g.home} (forfeit)`;
  return g.winner;
}
function _forfeitLabel(g) {
  if (g.winner === "forfeit_home") return g.home;
  if (g.winner === "forfeit_away") return g.away;
  return "";
}
function _scoredOnly(games) { return (games || []).filter((g) => g.winner); }
function csvOfResults(games) {
  const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
  const head = ["Date", "Time", "League", "Home", "Home Score", "Away", "Away Score", "Winner", "Forfeit", "Note"].join(",");
  const rows = _scoredOnly(games).map((g) => [
    g.date, g.time || "", g.league || "", g.home, g.home_score ?? "", g.away, g.away_score ?? "",
    _winnerLabel(g), _forfeitLabel(g), g.score_note || "",
  ].map(esc).join(","));
  return [head, ...rows].join("\r\n");
}
function htmlOfResults(games) {
  const e = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = _scoredOnly(games).map((g) => "    <tr><td>" + e(g.date) + "</td><td>" + e(g.time || "") + "</td><td>" + e(g.league || "") + "</td><td>" + e(g.home) + "</td><td>" + e(g.home_score ?? "") + "</td><td>" + e(g.away) + "</td><td>" + e(g.away_score ?? "") + "</td><td>" + e(_winnerLabel(g)) + "</td></tr>").join("\n");
  return '<table class="ff-results">\n  <thead><tr><th>Date</th><th>Time</th><th>League</th><th>Home</th><th>Score</th><th>Away</th><th>Score</th><th>Winner</th></tr></thead>\n  <tbody>\n' + rows + "\n  </tbody>\n</table>";
}
function jsonOfResults(games) {
  return JSON.stringify(_scoredOnly(games).map((g) => ({
    id: g.id, date: g.date, time: g.time || "", league: g.league || "",
    home: g.home, home_score: g.home_score, away: g.away, away_score: g.away_score,
    winner: g.winner, forfeit: _forfeitLabel(g) || null, note: g.score_note || "",
    score_at: g.score_at || "",
  })), null, 2);
}

const refsOf = (g) => String(g.referee || "").split(",").map((s) => s.trim()).filter(Boolean);

export default function Schedule({ go, onAsk, startRef }) {
  const [cfg, setCfg] = useState(undefined);
  const [tab, setTab] = useState("saved");
  const [step, setStep] = useState(0);   // Build-schedule wizard position
  const [blackoutCount, setBlackoutCount] = useState(null);  // shown on the Review step
  const [league, setLeague] = useState("");
  const [startDate, setStartDate] = useState("");
  const [weeksInput, setWeeksInput] = useState("");   // "" = auto (one full round-robin)
  const [gamesPerDay, setGamesPerDay] = useState(1);
  const [startTime, setStartTime] = useState("");   // first game kickoff (HH:MM); blank = no times
  // Per-division first-game times. Same league day, different times per division.
  // Keyed by division name (e.g. "Ages 4-6"). Required when teams carry the
  // "Division / Team" name prefix; falls back to startTime when not.
  const [divisionStartTimes, setDivisionStartTimes] = useState({});
  const [slotMins, setSlotMins] = useState(60);      // minutes between consecutive games that day
  const [fieldList, setFieldList] = useState([]);    // playing fields/locations for this schedule
  const [fieldText, setFieldText] = useState("");
  const fieldsPrefilled = useRef(false);
  const [excludedTeams, setExcludedTeams] = useState(new Set()); // team names to drop from this build
  const [guestTeams, setGuestTeams] = useState([]);              // ad-hoc additions
  const [guestText, setGuestText] = useState("");
  const [weeks, setWeeks] = useState(null);   // preview (unsaved)
  const [saved, setSaved] = useState([]);      // current saved games
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [ai, setAi] = useState("");
  const [mode, setMode] = useState(startRef ? "referee" : "league");   // "league" (admin) or "referee"
  const [refIn, setRefIn] = useState("");
  const [refName, setRefName] = useState("");
  const [refField, setRefField] = useState("");
  const [refLeague, setRefLeague] = useState("");
  const [refGames, setRefGames] = useState([]);
  const [refScope, setRefScope] = useState("mine");   // "mine" or "all"
  const [referees, setReferees] = useState([]);        // names for assignment dropdowns
  const [refList, setRefList] = useState([]);           // referee records (name, phone, league, field)
  const [rainoutDate, setRainoutDate] = useState("");   // saved-tab rainout picker
  const [teamDivs, setTeamDivs] = useState({});         // team name -> most-common division (for grouping)
  // Saved-schedule filters. League is already scoped via loadSaved(league).
  const [filterDivision, setFilterDivision] = useState("");
  const [filterField, setFilterField] = useState("");
  const [confirmClear, setConfirmClear] = useState(null); // { league, count } | null
  const [clearingBusy, setClearingBusy] = useState(false);
  // Track whether the division has been defaulted once after a (re)load. We
  // want the picker to land on a specific division (the first one) instead of
  // "All divisions", but if the user explicitly picks "All", we shouldn't keep
  // re-defaulting on every re-render.
  const dividedDefaultedRef = useRef(false);

  async function loadCfg() {
    const c = await api.scheduleConfig();
    setCfg(c);
    if (!league && c.leagues?.length) setLeague(c.leagues[0]);
  }
  async function loadSaved(lg) {
    const r = await api.scheduleList(lg || null);
    setSaved(r.games || []);
  }
  async function loadRefGames() {
    const r = await api.scheduleList(null); setRefGames(r.games || []);
    try {
      const pr = await api.records("player");
      const counts = {}; // teamName -> { divisionName: hits }
      for (const x of (pr.records || [])) {
        let d = {}; try { d = JSON.parse(x.data || "{}"); } catch {}
        const t = String(d.team || "").trim(); const dv = String(d.division || "").trim();
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
  async function loadReferees() {
    try {
      const r = await api.records("referee");
      const list = (r.records || []).map((x) => { let d = {}; try { d = JSON.parse(x.data || "{}"); } catch {} return { name: x.name || d.full_name || "", phone: d.phone || "", league: d.league || "", field: d.field || "", key: d.key_tag || "" }; }).filter((x) => x.name);
      setRefList(list); setReferees(list.map((x) => x.name));
    } catch {}
  }
  async function assignRef(gameId, ref) { await api.scheduleAssignRef(gameId, ref); await loadSaved(league); await loadRefGames(); }
  // Add one official to a game, refusing to double-book a ref already working that date+time.
  function addRefInline(g, name) {
    if (!name) return;
    const clash = refBusyAt(saved, name, g.date, g.time, g.id);
    if (clash) { setFlash({ ok: false, text: `${name} is already on ${clash.home} vs ${clash.away}${clash.location ? ` (${clash.location})` : ""} at ${g.time}. A referee can't be in two places at once.` }); return; }
    assignRef(g.id, [...refsOf(g), name].join(", "));
  }
  // Resolve a scanned key tag (or a typed name) to the referee on the roster, then check them in.
  async function checkInRef(value) {
    const v = String(value || "").trim();
    if (!v) return;
    const vl = v.toLowerCase();
    const who = refList.find((x) => x.key && x.key.toLowerCase() === vl) || refList.find((x) => x.name.toLowerCase() === vl);
    const name = who ? who.name : v;
    setRefName(name);
    setRefScope("mine"); setRefIn("");
    try { await api.refShift(name, "in"); } catch {}
  }
  useEffect(() => { loadCfg(); loadReferees(); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    if (!cfg) return;
    // Switching league resets per-league filters and lets the next saved-load
    // default the division picker again.
    setFilterDivision(""); setFilterField("");
    dividedDefaultedRef.current = false;
    loadSaved(league);
    /* eslint-disable-next-line */
  }, [league, cfg]);
  // Auto-default the division filter to the first one available the first time
  // a saved schedule appears for the chosen league. The user can still pick
  // "All divisions" — once they do, we don't reapply.
  useEffect(() => {
    if (dividedDefaultedRef.current) return;
    if (!saved.length) return;
    const choices = [...new Set(saved.map((g) => {
      const i = String(g.home || "").indexOf(" / "); if (i > 0) return g.home.slice(0, i);
      const j = String(g.away || "").indexOf(" / "); if (j > 0) return g.away.slice(0, j);
      return "";
    }).filter(Boolean))].sort();
    if (choices.length) { setFilterDivision(choices[0]); dividedDefaultedRef.current = true; }
  }, [saved]);
  useEffect(() => { if (mode === "referee") loadRefGames(); /* eslint-disable-next-line */ }, [mode]);
  // Reuse the fields already on a saved schedule the first time they load.
  useEffect(() => {
    if (fieldsPrefilled.current) return;
    const locs = [...new Set(saved.map((g) => g.location).filter(Boolean))];
    if (locs.length) { setFieldList(locs); fieldsPrefilled.current = true; }
  }, [saved]);

  // The Review step states how many blackouts are in play, so it has to know
  // about additions made two steps earlier.
  useEffect(() => {
    let dead = false;
    (async () => {
      try { const r = await api.blackoutsList(league || null); if (!dead) setBlackoutCount((r?.blackouts || []).length); }
      catch { if (!dead) setBlackoutCount(null); }
    })();
    return () => { dead = true; };
  }, [league, step]);

  if (cfg === undefined || cfg?.error) return <div className="muted">Loading…</div>;

  const noLeagues = !cfg.leagues?.length;
  const teamsHere = league ? (cfg.teamsByLeague?.[league] || []) : (cfg.allTeams || []);
  const teamStats = league
    ? (cfg.teamStats?.[league] || cfg.teamsByLeague?.[league]?.map((t) => ({ team: t, players: 0, divisions: [] })) || [])
    : (cfg.allTeamStats || cfg.allTeams?.map((t) => ({ team: t, players: 0, divisions: [] })) || []);
  const includedRoster = teamStats.filter((s) => !excludedTeams.has(s.team)).map((s) => s.team);
  const allEffectiveTeams = [...includedRoster, ...guestTeams.filter((g) => !includedRoster.includes(g))];
  // Divisions present in the build set — parsed from the "Division / Team" name
  // prefix. Drives the per-division start-time inputs.
  const divisionsInBuild = [...new Set(allEffectiveTeams.map((t) => { const i = String(t).indexOf(" / "); return i > 0 ? t.slice(0, i) : ""; }).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const baseRounds = allEffectiveTeams.length < 2 ? 0 : (allEffectiveTeams.length % 2 === 0 ? allEffectiveTeams.length - 1 : allEffectiveTeams.length);
  const autoWeeks = baseRounds ? Math.ceil(baseRounds / Math.max(1, gamesPerDay)) : 0;

  function addFieldName() {
    const parts = fieldText.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setFieldList((prev) => [...prev, ...parts.filter((p) => !prev.some((x) => x.toLowerCase() === p.toLowerCase()))]);
    setFieldText(""); setWeeks(null);
  }
  function removeFieldName(f) { setFieldList((prev) => prev.filter((x) => x !== f)); setWeeks(null); }

  async function doPreview() {
    // Require at least one field/location — without it the conflict checker
    // can't tell whether two games share a field, and the website export's
    // "where" column comes out blank.
    if (!fieldList.length) {
      setFlash({ ok: false, text: "Add at least one field (e.g. Field 1, North Park) before building the schedule." });
      return;
    }
    if (!gamesPerDay || gamesPerDay < 1) {
      setFlash({ ok: false, text: "Set games per team each day (usually 1)." });
      return;
    }
    if (!slotMins || slotMins < 5) {
      setFlash({ ok: false, text: "Set how many minutes per game (e.g. 60). Each division needs slot × games-per-day of runway." });
      return;
    }
    // Each division needs its own first-game time (same day, staggered kickoffs).
    if (divisionsInBuild.length) {
      const missing = divisionsInBuild.filter((d) => !String(divisionStartTimes[d] || "").trim());
      if (missing.length) {
        setFlash({ ok: false, text: `First game time is required for each division. Missing: ${missing.join(", ")}.` });
        return;
      }
    } else if (!startTime) {
      setFlash({ ok: false, text: "First game time is required (HH:MM)." });
      return;
    }
    setBusy(true); setFlash(null);
    const res = await api.schedulePreview({
      league: league || null,
      teams: allEffectiveTeams,
      startDate: startDate || null,
      weeks: weeksInput ? Number(weeksInput) : null,
      gamesPerDay,
      startTime: startTime || null,
      slotMins,
      fields: fieldList,
      division_start_times: divisionStartTimes,
    });
    setBusy(false);
    if (!res.teams || res.teams.length < 2) { setWeeks(null); return setFlash({ ok: false, text: "Need at least two saved teams in this league. Build teams first." }); }
    setWeeks(res.weeks);
  }
  async function doSave() {
    const games = [];
    for (const w of weeks) for (const g of w.games) games.push({ week: w.week, date: w.date, time: g.time || "", home: g.home, away: g.away, location: g.location || "" });
    const res = await api.scheduleSave({ league: league || null, games });
    setWeeks(null); await loadSaved(league); setTab("saved");
    setFlash({ ok: true, text: `Saved — ${res.saved} games scheduled.` });
  }
  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); setFlash({ ok: true, text: `${label} copied — paste it onto your website.` }); }
    catch { setFlash({ ok: false, text: "Couldn't copy automatically — select the text and copy it manually." }); }
  }
  function submitAi() {
    const extra = ai.trim();
    const text = `Make a season schedule${league ? ` for ${league}` : ""}${startDate ? ` starting ${startDate}` : ""}${extra ? `. ${extra}` : ""}`;
    if (onAsk) onAsk(text);
    setAi("");
  }

  // Division derived from team naming convention "<Division> / <Team>". Falls
  // back to teamDivs (player-derived) when the name doesn't carry the prefix.
  function divisionOf(g) {
    const splitName = (s) => {
      const i = String(s || "").indexOf(" / ");
      return i > 0 ? s.slice(0, i) : "";
    };
    return splitName(g.home) || splitName(g.away) || teamDivs[g.home] || teamDivs[g.away] || "";
  }

  // Distinct dropdown choices, computed from the raw saved games so they're
  // stable as the user adjusts other filters.
  const divisionChoices = [...new Set(saved.map(divisionOf).filter(Boolean))].sort();
  const fieldChoices = [...new Set(saved.map((g) => g.location || "").filter(Boolean))].sort();

  // Apply division + field filters. League is already in place via loadSaved.
  const filteredSaved = saved.filter((g) => {
    if (filterDivision && divisionOf(g) !== filterDivision) return false;
    if (filterField && (g.location || "") !== filterField) return false;
    return true;
  });

  // group saved games into weeks
  const savedWeeks = [];
  for (const g of filteredSaved) {
    let wk = savedWeeks.find((w) => w.week === g.week);
    if (!wk) { wk = { week: g.week, date: g.date, games: [] }; savedWeeks.push(wk); }
    wk.games.push(g);
  }
  const savedConflicts = findConflicts(filteredSaved);
  const savedConflictCount = savedConflicts.referee.length + savedConflicts.field.length + savedConflicts.team.length;
  function LeaguePicker({ onChange }) {
    return (
      <div>
        <label className="fld">League</label>
        <select value={league} onChange={(e) => { setLeague(e.target.value); onChange && onChange(); }}>
          {noLeagues ? <option value="">(all teams)</option> : cfg.leagues.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
    );
  }
  function Weeks({ list, isPreview }) {
    return (
      <>
        <div className="between" style={{ margin: "16px 2px 10px" }}>
          <h2 style={{ margin: 0 }}>{isPreview ? "Preview (not saved yet)" : "Saved schedule"}</h2>
          <span className="muted small">{list.length} week{list.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          {list.map((w) => (
            <div className="card" key={w.week}>
              <div className="between" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>Week {w.week}</h3>
                {w.date && <span className="chip">{fmtDate(w.date)}</span>}
              </div>
              <div className="stack">
                {w.games.map((g, i) => (
                  <div className="drag-item" key={i} style={{ cursor: "default", flexWrap: "wrap", gap: 8 }}>
                    <span style={{ flex: "1 1 160px" }}><b>{g.home}</b> <span className="muted">vs</span> {g.away}{g.location ? <span className="muted small"> · {g.location}</span> : null}</span>
                    {g.time && <span className="chip">{g.time}</span>}
                    {!isPreview && g.id != null && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                        {refsOf(g).map((r) => (
                          <span className="member" key={r}>{r}<button className="x" title="Remove" onClick={() => assignRef(g.id, refsOf(g).filter((x) => x !== r).join(", "))}>×</button></span>
                        ))}
                        <select value="" onChange={(e) => { if (e.target.value) { addRefInline(g, e.target.value); e.target.value = ""; } }} style={{ flex: "0 0 auto", maxWidth: 150 }}>
                          <option value="">+ Ref…</option>
                          {referees.filter((r) => !refsOf(g).includes(r)).map((r) => {
                            const busy = refBusyAt(saved, r, g.date, g.time, g.id);
                            return <option key={r} value={r} disabled={!!busy}>{r}{busy ? " — busy" : ""}</option>;
                          })}
                        </select>
                      </div>
                    )}
                  </div>
                ))}
                {!w.games.length && <div className="muted small">No games this week.</div>}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <div>
      <div className="page-head"><h1>Schedule</h1>
        <div className="muted">Build a round-robin season — every team plays every other team once.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      {mode === "league" && (
        <>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button className={"pill" + (tab === "build" ? " active" : "")} onClick={() => setTab("build")}>Build schedule</button>
        <button className={"pill" + (tab === "saved" ? " active" : "")} onClick={() => setTab("saved")}>Saved schedule</button>
        <button className={"pill" + (tab === "packets" ? " active" : "")} onClick={() => setTab("packets")}>Packets</button>
        <button className={"pill" + (tab === "pay" ? " active" : "")} onClick={() => setTab("pay")}>Pay</button>
        <button className={"pill" + (tab === "scores" ? " active" : "")} onClick={() => setTab("scores")}>Scores</button>
      </div>

      {tab === "build" && (() => {
        // ---------------------------------------------------------------- steps
        // Building a schedule is a sequence, not a form. The old layout put nine
        // controls on screen at once with no hint which mattered first, so the
        // usual outcome was filling everything in, pressing Generate, and being
        // told a field was missing. Now it asks one thing at a time, in the
        // order the answers actually depend on each other, and won't let you
        // move on from a step that isn't answered.
        const missingDivTimes = divisionsInBuild.filter((d) => !String(divisionStartTimes[d] || "").trim());
        const needsDivTimes = divisionsInBuild.length > 0;

        // The league is picked FIRST and gates everything after it. Fields,
        // teams, divisions, blackouts and the schedule itself all belong to one
        // league — deciding which one last meant every earlier answer was given
        // against nothing in particular.
        const haveLeague = !!league || noLeagues;

        const STEPS = [
          {
            key: "league",
            title: "League",
            blurb: "Pick the league first — the fields, teams, divisions and blackouts that follow all belong to it.",
            done: haveLeague,
            blocker: "Pick a league.",
          },
          {
            key: "fields",
            title: "Fields",
            blurb: `Where ${league || "this league"} plays. Games spread across these, and the conflict checker needs them to spot two teams booked on the same field at the same time.`,
            done: haveLeague && fieldList.length > 0,
            blocker: haveLeague ? "Add at least one field." : "Pick a league first.",
          },
          {
            key: "teams",
            title: "Teams",
            blurb: `Who's playing in ${league || "this league"} this season.`,
            done: haveLeague && allEffectiveTeams.length >= 2,
            blocker: !haveLeague
              ? "Pick a league first."
              : "You need at least two teams — build teams first, or add a guest team.",
          },
          {
            key: "dates",
            title: "Dates",
            blurb: "When the season starts and how long it runs.",
            done: true,   // both are optional — blank start date and auto weeks are valid
            blocker: "",
          },
          {
            key: "gameday",
            title: "Game day",
            blurb: "How a single Saturday is laid out.",
            done: needsDivTimes ? missingDivTimes.length === 0 : !!startTime,
            blocker: needsDivTimes
              ? `Set a first-game time for: ${missingDivTimes.join(", ")}.`
              : "Set the first game time.",
          },
          {
            key: "blackouts",
            title: "Blackout dates",
            blurb: "Weekends to skip — holidays, fields closed. The season jumps past them instead of counting them.",
            done: true,   // having none is a perfectly good answer
            blocker: "",
          },
          {
            key: "review",
            title: "Review & generate",
            blurb: "",
            done: false,
            blocker: "",
          },
        ];

        const idx = Math.min(step, STEPS.length - 1);
        const cur = STEPS[idx];
        const canAdvance = cur.done || cur.key === "review";
        // Everything except the review step itself has to be answered before a
        // schedule can be built — that's the same check the button used to do
        // at the very end, just surfaced where you can act on it.
        const firstUnfinished = STEPS.findIndex((st) => st.key !== "review" && !st.done);
        const readyToBuild = firstUnfinished === -1;

        const go2 = (n) => { setStep(Math.max(0, Math.min(STEPS.length - 1, n))); };

        return (
        <>
          {/* -------------------------------------------------------- stepper */}
          <div className="card" style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {STEPS.map((st, i) => {
                const active = i === idx;
                const complete = st.done && i < idx;
                return (
                  <div key={st.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button
                      onClick={() => go2(i)}
                      title={st.done || i <= idx ? st.title : st.blocker}
                      style={{
                        display: "flex", alignItems: "center", gap: 8,
                        border: "1px solid " + (active ? "var(--brand, #c8102e)" : "var(--line, #e3e3e8)"),
                        background: active ? "var(--brand, #c8102e)" : "transparent",
                        color: active ? "#fff" : "var(--ink)",
                        borderRadius: 999, padding: "6px 12px", cursor: "pointer",
                        fontWeight: active ? 700 : 500, fontSize: 13, whiteSpace: "nowrap",
                      }}
                    >
                      <span style={{
                        width: 20, height: 20, borderRadius: 999, flex: "0 0 20px",
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        fontSize: 11, fontWeight: 700,
                        background: active ? "rgba(255,255,255,.25)" : complete ? "var(--good, #1a7f47)" : "var(--line-soft, #eee)",
                        color: active ? "#fff" : complete ? "#fff" : "var(--muted, #777)",
                      }}>{complete ? "✓" : i + 1}</span>
                      {st.title}
                    </button>
                    {i < STEPS.length - 1 && <span aria-hidden style={{ color: "var(--line, #ccc)", fontSize: 16 }}>›</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ----------------------------------------------------- step body */}
          <div className="card">
            <div className="between" style={{ alignItems: "flex-start", marginBottom: 4 }}>
              <h2 style={{ margin: 0 }}>Step {idx + 1} of {STEPS.length} · {cur.title}</h2>
              <span className="muted small">{league || (noLeagues ? "all teams" : "no league picked")}</span>
            </div>
            {cur.blurb && <p className="muted" style={{ marginTop: 0 }}>{cur.blurb}</p>}

            {/* Nothing past step 1 means anything without a league. Rather than
                showing empty controls that quietly do nothing, say so and offer
                the way back. */}
            {!haveLeague && cur.key !== "league" ? (
              <div className="note warn">
                Pick a league on step 1 first — fields, teams, divisions and blackouts all belong to one.
                <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => go2(0)}>Go to step 1</button>
              </div>
            ) : (
            <>

            {/* 1 — League */}
            {cur.key === "league" && (
              <>
                <div style={{ maxWidth: 340 }}>
                  <LeaguePicker onChange={() => {
                    // A different league means different fields, teams and
                    // divisions — carrying the old answers forward would build
                    // a schedule out of another league's parts.
                    setWeeks(null);
                    setExcludedTeams(new Set());
                    setGuestTeams([]);
                    setFieldList([]);
                    setDivisionStartTimes({});
                  }} />
                </div>
                <div className="muted small" style={{ marginTop: 10 }}>
                  {noLeagues
                    ? "No leagues are set up, so this schedule covers every team."
                    : league
                      ? `${teamStats.length} team${teamStats.length === 1 ? "" : "s"} on the ${league} roster${divisionsInBuild.length ? ` across ${divisionsInBuild.length} division${divisionsInBuild.length === 1 ? "" : "s"}` : ""}.`
                      : "Nothing else can be set until a league is chosen."}
                </div>
                {league && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    Changing this later clears the fields and team choices below — they belong to the league.
                  </div>
                )}
              </>
            )}

            {/* 2 — Fields */}
            {cur.key === "fields" && (
              <>
                <div className="aibar">
                  <input placeholder="Add a field — e.g. Field 1, North Park…" value={fieldText}
                    autoFocus
                    onChange={(e) => setFieldText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addFieldName(); }} />
                  <button className="btn" onClick={addFieldName}>Add field</button>
                </div>
                {fieldList.length > 0 ? (
                  <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap" }}>
                    {fieldList.map((f) => (
                      <span className="member" key={f}>{f}<button className="x" title="Remove" onClick={() => removeFieldName(f)}>×</button></span>
                    ))}
                  </div>
                ) : (
                  <div className="muted small" style={{ marginTop: 8 }}>Type a name and press Enter. Add one per field you actually play on.</div>
                )}
              </>
            )}

            {/* 3 — Teams */}
            {cur.key === "teams" && (
              <>
                <div className="between" style={{ margin: "0 0 6px" }}>
                  <span className="muted small">Pulled from the{league ? ` ${league}` : ""} roster — uncheck anyone you don&apos;t want this season, or add guest teams for tournament / cross-league play.</span>
                  <span className="muted small">{allEffectiveTeams.length} included{guestTeams.length ? ` · ${guestTeams.length} guest` : ""}</span>
                </div>

                {teamStats.length ? (
                  <div className="grid cols-2" style={{ marginTop: 6 }}>
                    {teamStats.map((s) => {
                      const checked = !excludedTeams.has(s.team);
                      return (
                        <label className="between" key={s.team} style={{ padding: "4px 6px", borderBottom: "1px solid var(--line-soft)" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <input type="checkbox" checked={checked} onChange={(e) => {
                              setWeeks(null);
                              setExcludedTeams((prev) => { const n = new Set(prev); if (e.target.checked) n.delete(s.team); else n.add(s.team); return n; });
                            }} />
                            <b>{s.team}</b>
                            <span className="muted small">· {s.players} player{s.players !== 1 ? "s" : ""}</span>
                            {s.divisions.length ? <span className="muted small">· {s.divisions.join(", ")}</span> : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <div className="muted small">No teams yet for{league ? ` ${league}` : " any league"}. <a onClick={() => go({ page: "teambuilder", tab: "build" })}>Build teams</a> first, or add a guest team below.</div>
                )}

                {guestTeams.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div className="muted small" style={{ marginBottom: 4 }}>Guest teams</div>
                    <div style={{ display: "flex", flexWrap: "wrap" }}>
                      {guestTeams.map((g) => (
                        <span className="member" key={g}>{g}<button className="x" title="Remove" onClick={() => { setGuestTeams((p) => p.filter((x) => x !== g)); setWeeks(null); }}>×</button></span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="addbar" style={{ marginTop: 10 }}>
                  <input placeholder="Add a guest team — e.g. PHX U10 Eagles" value={guestText}
                    onChange={(e) => setGuestText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const v = guestText.trim();
                        if (!v) return;
                        setGuestTeams((prev) => prev.some((x) => x.toLowerCase() === v.toLowerCase()) ? prev : [...prev, v]);
                        setGuestText(""); setWeeks(null);
                      }
                    }} />
                  <button className="btn" onClick={() => {
                    const v = guestText.trim(); if (!v) return;
                    setGuestTeams((prev) => prev.some((x) => x.toLowerCase() === v.toLowerCase()) ? prev : [...prev, v]);
                    setGuestText(""); setWeeks(null);
                  }}>Add guest team</button>
                </div>
              </>
            )}

            {/* 3 — Dates */}
            {cur.key === "dates" && (
              <div className="field-grid">
                <div>
                  <label className="fld">First game date</label>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  <div className="muted small" style={{ marginTop: 4, fontSize: 11 }}>
                    Optional — leave blank and weeks are numbered without dates.
                  </div>
                </div>
                <div>
                  <label className="fld">Weeks of games</label>
                  <input type="number" min={1} value={weeksInput}
                    onChange={(e) => { setWeeksInput(e.target.value); setWeeks(null); }}
                    placeholder={autoWeeks ? `auto — ${autoWeeks}` : "auto"} />
                  <div className="muted small" style={{ marginTop: 4, fontSize: 11 }}>
                    Leave blank for one full round-robin{autoWeeks ? ` (${autoWeeks} week${autoWeeks !== 1 ? "s" : ""})` : ""}; set more to repeat the season.
                    Counts game weekends, not calendar weeks — blackouts are skipped, not counted.
                  </div>
                </div>
              </div>
            )}

            {/* 4 — Game day */}
            {cur.key === "gameday" && (
              <>
                <div className="field-grid">
                  <div>
                    <label className="fld">Games per team each day <span className="req">*</span></label>
                    <input type="number" min={1} required value={gamesPerDay}
                      onChange={(e) => { setGamesPerDay(Math.max(1, Number(e.target.value) || 1)); setWeeks(null); }} />
                    <div className="muted small" style={{ marginTop: 4, fontSize: 11 }}>Usually 1. Set 2+ for tournaments / pool play.</div>
                  </div>
                  <div>
                    <label className="fld">Minutes per game (slot length) <span className="req">*</span></label>
                    <input type="number" min={5} step={5} required value={slotMins}
                      onChange={(e) => { setSlotMins(Math.max(0, Number(e.target.value) || 0)); setWeeks(null); }} />
                    <div className="muted small" style={{ marginTop: 4, fontSize: 11 }}>
                      Each division needs <b>slot × games-per-day</b> of runway before the next division can kick off ({gamesPerDay > 1 ? `${gamesPerDay} × ${slotMins || 60} = ${(gamesPerDay) * (slotMins || 60)} min` : "1 × 60 = 60 min"}).
                    </div>
                  </div>
                  {!needsDivTimes && (
                    <div>
                      <label className="fld">First game time <span className="req">*</span></label>
                      <input type="time" required value={startTime} onChange={(e) => { setStartTime(e.target.value); setWeeks(null); }} />
                    </div>
                  )}
                </div>

                {needsDivTimes && (
                  <div style={{ marginTop: 14 }}>
                    <label className="fld">First game time per division <span className="req">*</span></label>
                    <div className="muted small" style={{ marginBottom: 6 }}>
                      All divisions in this league play the same day, but each kicks off at its own time. One HH:MM per division.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8 }}>
                      {divisionsInBuild.map((dv) => {
                        const v = divisionStartTimes[dv] || "";
                        const missing = !v.trim();
                        return (
                          <div key={dv}>
                            <label className="fld" style={{ marginTop: 0 }}>{dv}{missing && <span className="req"> *</span>}</label>
                            <input type="time" required value={v}
                              onChange={(e) => { setDivisionStartTimes((s2) => ({ ...s2, [dv]: e.target.value })); setWeeks(null); }}
                              style={{ borderColor: missing ? "var(--warn, #b40)" : undefined }} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* 6 — Blackouts */}
            {cur.key === "blackouts" && <BlackoutsCard league={league} bare />}

            {/* 7 — Review */}
            {cur.key === "review" && (
              <>
                <div className="stack" style={{ marginTop: 4, gap: 0 }}>
                  {[
                    ["League", league || (noLeagues ? "all teams" : "—"), 0],
                    ["Fields", fieldList.join(", "), 1],
                    ["Teams", `${allEffectiveTeams.length}${guestTeams.length ? ` (${guestTeams.length} guest)` : ""}`, 2],
                    ["First game date", startDate || "not set", 3],
                    ["Weeks", weeksInput || (autoWeeks ? `auto — ${autoWeeks}` : "auto"), 3],
                    ["Games per team / day", String(gamesPerDay), 4],
                    ["Slot length", `${slotMins} min`, 4],
                    ["First game time", needsDivTimes
                      ? divisionsInBuild.map((d) => `${d} ${divisionStartTimes[d] || "—"}`).join(" · ")
                      : (startTime || "not set"), 4],
                    ["Blackout dates", blackoutCount === null ? "—"
                      : blackoutCount === 0 ? "none — the season runs straight through"
                      : `${blackoutCount} date${blackoutCount === 1 ? "" : "s"} skipped`, 5],
                  ].map(([label, value, jump]) => (
                    <div key={label} className="between" style={{ padding: "8px 2px", borderBottom: "1px solid var(--line-soft)", gap: 12, alignItems: "flex-start" }}>
                      <span style={{ minWidth: 0 }}>
                        <span className="muted small">{label}</span><br />
                        <b style={{ overflowWrap: "anywhere" }}>{value || "—"}</b>
                      </span>
                      <button className="btn ghost sm" style={{ flex: "0 0 auto" }} onClick={() => go2(jump)}>Change</button>
                    </div>
                  ))}
                </div>

                {!readyToBuild && (
                  <div className="note warn" style={{ marginTop: 12 }}>
                    {STEPS[firstUnfinished].blocker}{" "}
                    <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => go2(firstUnfinished)}>
                      Go to step {firstUnfinished + 1}
                    </button>
                  </div>
                )}

                <div className="btn-row" style={{ marginTop: 14 }}>
                  <button className="btn primary" onClick={doPreview} disabled={busy || !readyToBuild}>
                    {busy ? "Building…" : "Generate schedule (preview)"}
                  </button>
                  {weeks && <button className="btn" onClick={doSave}>Save schedule</button>}
                </div>
                <div className="muted small" style={{ marginTop: 8 }}>
                  Preview first — nothing is saved until you press Save schedule.
                </div>
              </>
            )}

            </>
            )}

            {/* ------------------------------------------------ back / next */}
            <div className="between" style={{ marginTop: 20, paddingTop: 14, borderTop: "1px solid var(--line-soft)", flexWrap: "wrap", gap: 10 }}>
              <button className="btn ghost" onClick={() => go2(idx - 1)} disabled={idx === 0}>← Back</button>
              <span className="muted small" style={{ textAlign: "center", flex: "1 1 auto" }}>
                {!canAdvance ? cur.blocker : idx < STEPS.length - 1 ? `Next: ${STEPS[idx + 1].title}` : ""}
              </span>
              {idx < STEPS.length - 1 ? (
                <button className="btn primary" onClick={() => go2(idx + 1)} disabled={!canAdvance} title={canAdvance ? "" : cur.blocker}>
                  Next →
                </button>
              ) : (
                <span />
              )}
            </div>
          </div>

          <div className="card">
            <div className="aibox">
              <div className="aibox-head"><span className="ai-badge">S-Dot</span> Or ask S-Dot</div>
              <AiPromptBar
                pageId="schedule"
                value={ai}
                onChange={setAi}
                onSend={(t) => { setAi(t); setTimeout(submitAi, 0); }}
                placeholder={`Describe the schedule for ${league || "this league"}…`}
                hint={`Skip the steps entirely — e.g. “make a season schedule for ${league || "this league"} starting in September”.`}
              />
            </div>
          </div>

          {weeks && <Weeks list={weeks} isPreview />}
        </>
        );
      })()}

      {tab === "saved" && (
        <>
          <div className="card">
            <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
              <LeaguePicker onChange={() => { setFilterDivision(""); setFilterField(""); }} />
              <div>
                <label className="fld">Division</label>
                <select
                  value={filterDivision}
                  onChange={(e) => { dividedDefaultedRef.current = true; setFilterDivision(e.target.value); }}
                >
                  <option value="">All divisions</option>
                  {divisionChoices.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div>
                <label className="fld">Field</label>
                <select value={filterField} onChange={(e) => setFilterField(e.target.value)}>
                  <option value="">All fields</option>
                  {fieldChoices.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            </div>
            {(filterDivision || filterField) && (
              <div className="muted small" style={{ marginTop: 8 }}>
                Showing {filteredSaved.length} of {saved.length} games
                {filterDivision ? ` · division ${filterDivision}` : ""}
                {filterField ? ` · field ${filterField}` : ""}.{" "}
                <a onClick={() => { setFilterDivision(""); setFilterField(""); }}>Clear filters</a>
              </div>
            )}
          </div>

          {/* Calendar + Reschedule at the top — most common day-of-game admin
              actions, and they used to live at the bottom of the page. */}
          {saved.length > 0 && (
            <RescheduleCard
              saved={filteredSaved}
              league={league}
              onApplied={() => loadSaved(league)}
              setFlash={setFlash}
            />
          )}
          {saved.length > 0 && (
            <ScheduleCalendar
              saved={filteredSaved}
              league={league}
              onApplied={() => loadSaved(league)}
              setFlash={setFlash}
            />
          )}
          {savedConflictCount > 0 && (
            <div className="card" style={{ borderColor: "var(--danger)", background: "var(--danger-soft)" }}>
              <h3 style={{ margin: "0 0 4px" }}>{savedConflictCount} scheduling conflict{savedConflictCount !== 1 ? "s" : ""}</h3>
              <div className="muted small" style={{ marginBottom: 8 }}>No two teams and no two referees can share a field at the same time, and a referee can only work one game per time slot. Fix these:</div>
              <div className="stack" style={{ gap: 6 }}>
                {savedConflicts.field.map((c, i) => <div className="issue-item" key={`f${i}`}><b>{c.location}</b> has {c.games.length} games at {c.time}{c.date ? ` · ${fmtDate(c.date)}` : ""}: {c.games.map((g) => `${g.home} vs ${g.away}`).join("; ")}.</div>)}
                {savedConflicts.team.map((c, i) => <div className="issue-item" key={`t${i}`}><b>{c.team}</b> plays {c.games.length} games at {c.time}{c.date ? ` · ${fmtDate(c.date)}` : ""}.</div>)}
                {savedConflicts.referee.map((c, i) => <div className="issue-item" key={`r${i}`}><b>{c.referee}</b> is booked on {c.games.length} games at {c.time}{c.date ? ` · ${fmtDate(c.date)}` : ""}.</div>)}
              </div>
            </div>
          )}
          {filteredSaved.length > 0 && (
            <div className="card">
              <h3>Export for your website</h3>
              <p className="muted small">
                A static export your league site can pull (OQ-9): copy the HTML table to paste into a page, or download a file your site links to.
                {" "}{filteredSaved.length} game{filteredSaved.length !== 1 ? "s" : ""}
                {league ? ` · ${league}` : ""}
                {filterDivision ? ` · ${filterDivision}` : ""}
                {filterField ? ` · ${filterField}` : ""}.
              </p>
              <div className="btn-row" style={{ flexWrap: "wrap" }}>
                <button className="btn primary" onClick={() => copyText(htmlOfGames(filteredSaved), "HTML table")}>Copy as HTML</button>
                <button className="btn" onClick={() => copyText(csvOfGames(filteredSaved), "CSV")}>Copy as CSV</button>
                <button className="btn" onClick={() => downloadFile(`schedule-${fileSlug([league, filterDivision, filterField].filter(Boolean).join("-"))}.csv`, csvOfGames(filteredSaved), "text/csv")}>Download CSV</button>
                <button className="btn" onClick={() => downloadFile(`schedule-${fileSlug([league, filterDivision, filterField].filter(Boolean).join("-"))}.ics`, icsOfGames(filteredSaved), "text/calendar")}>Download calendar (.ics)</button>
                <button
                  className="btn"
                  title="Open the master schedule grouped by division → field → time. Print or Save as PDF from there."
                  onClick={() => {
                    if (typeof window === "undefined") return;
                    const q = new URLSearchParams();
                    if (league) q.set("league", league);
                    if (filterDivision) q.set("division", filterDivision);
                    if (filterField) q.set("field", filterField);
                    window.open(`/print/master${q.toString() ? `?${q.toString()}` : ""}`, "_blank", "noopener");
                  }}
                >Print master schedule (PDF)</button>
              </div>
            </div>
          )}
          {filteredSaved.some((g) => g.winner) && (() => {
            const results = filteredSaved.filter((g) => g.winner);
            const apiUrl = `/api/results${league ? `?league=${encodeURIComponent(league)}` : ""}`;
            const fullUrl = (typeof window !== "undefined" ? window.location.origin : "") + apiUrl;
            return (
              <div className="card">
                <h3>Results — who beat whom</h3>
                <p className="muted small">Record of game results for your website. {results.length} scored game{results.length !== 1 ? "s" : ""}{league ? ` · ${league}` : ""}. <b>Record only — no computed standings.</b></p>
                <div className="btn-row" style={{ flexWrap: "wrap" }}>
                  <button className="btn primary" onClick={() => copyText(htmlOfResults(results), "Results HTML")}>Copy as HTML</button>
                  <button className="btn" onClick={() => copyText(csvOfResults(results), "Results CSV")}>Copy as CSV</button>
                  <button className="btn" onClick={() => downloadFile(`results-${fileSlug(league)}.csv`, csvOfResults(results), "text/csv")}>Download CSV</button>
                  <button className="btn" onClick={() => downloadFile(`results-${fileSlug(league)}.json`, jsonOfResults(results), "application/json")}>Download JSON</button>
                </div>
                <div style={{ marginTop: 10 }}>
                  <label className="fld">Stable URL for your website</label>
                  <div className="row" style={{ gap: 6 }}>
                    <input readOnly value={fullUrl} style={{ flex: 1, fontFamily: "monospace", fontSize: 12 }} onClick={(e) => e.target.select()} />
                    <button className="btn" onClick={() => copyText(fullUrl, "URL")}>Copy URL</button>
                  </div>
                  <div className="muted small" style={{ marginTop: 4 }}>Returns JSON by default; add <code>?format=csv</code> or <code>?format=html</code>.</div>
                </div>
              </div>
            );
          })()}
          {/* Per-week game list removed — the season calendar above + the per-day
              modal handle viewing/editing. Empty state still surfaces here so the
              user can find the Build link. */}
          {!savedWeeks.length && (
            <div className="card"><p className="muted" style={{ margin: 0 }}>No saved schedule for this league yet. Build one on the <a onClick={() => setTab("build")}>Build schedule</a> tab.</p></div>
          )}
          {/* The rainout/rescheduler now sits up top — see RescheduleCard. This bottom card is gone. */}

          {saved.length > 0 && (
            <div className="card" style={{ borderColor: "var(--danger, #b71d3a)", background: "var(--danger-soft, #fdecef)" }}>
              <h3 style={{ marginTop: 0, color: "var(--danger)" }}>Danger zone</h3>
              <p className="muted small">Clear every saved game for this league. Round-robin scheduling, ref assignments, and recorded scores tied to those games are removed. Build a fresh schedule afterward.</p>
              <button
                className="btn danger"
                onClick={() => setConfirmClear({ league: league || "(all leagues)", count: saved.length })}
              >Clear saved schedule</button>
            </div>
          )}

          <ConfirmDeleteModal
            open={!!confirmClear}
            title={`Clear saved schedule — ${confirmClear?.league || ""}`}
            targetName={confirmClear?.league || "CLEAR SCHEDULE"}
            itemSummary={confirmClear ? `${confirmClear.count} game${confirmClear.count === 1 ? "" : "s"} in ${confirmClear.league}.` : ""}
            consequences={[
              "Remove every game record in this league (week, date, time, location, ref assignments).",
              "Discard recorded scores tied to those games.",
              "Player team assignments (the `team` field on each player) are NOT touched — you can re-generate the schedule from them.",
            ]}
            undoNote="Undo: not available — the deletion isn't auditable past this point. Re-run Build schedule to rebuild."
            confirmLabel="Clear schedule"
            busy={clearingBusy}
            onCancel={() => setConfirmClear(null)}
            onConfirm={async () => {
              setClearingBusy(true);
              try {
                const res = await api.scheduleClear(league || null);
                if (res && res.error) { setFlash({ ok: false, text: res.error }); return; }
                setConfirmClear(null);
                await loadSaved(league);
                setFlash({ ok: true, text: `Cleared. ${res?.saved === 0 ? "Schedule is empty." : ""}` });
              } finally { setClearingBusy(false); }
            }}
          />
        </>
      )}

      {tab === "packets" && <PacketsTab league={league} />}
      {tab === "pay" && <PayTab league={league} />}
      {tab === "scores" && <ScoresTab />}
        </>
      )}

      {mode === "referee" && (() => {
        // Referee view mirrors the admin Saved schedule one-for-one: same games,
        // same week grouping, same divisionOf (splits "Division / Team", falls
        // back to player-derived teamDivs), same Division/Field filters. Every
        // game is shown whether or not a ref is assigned yet — assignment is
        // metadata on top of the schedule, never a gate.
        const isMine = (g) => { const yn = refName ? refName.trim().toLowerCase() : ""; return !!yn && refsOf(g).some((r) => r.toLowerCase() === yn); };
        const mine = refName ? refGames.filter(isMine) : [];
        const fields = [...new Set(refGames.map((g) => g.location).filter(Boolean))].sort();
        const leaguesR = [...new Set(refGames.map((g) => g.league).filter(Boolean))].sort();
        const divsR = [...new Set(refGames.map(divisionOf).filter(Boolean))].sort();
        // Default base is the WHOLE schedule so refs see every game (including
        // unassigned ones). "My games" is an opt-in narrowing when a ref is
        // checked in — we never fall back silently to "all" since that hides
        // the fact that nothing's assigned yet.
        const base = (refName && refScope === "mine") ? mine : refGames;
        const scoped = base.filter((g) => {
          if (refLeague && g.league !== refLeague) return false;
          if (refField && (g.location || "") !== refField) return false;
          if (filterDivision && divisionOf(g) !== filterDivision) return false;
          return true;
        });
        // Group by Week, same as the admin Saved view — that's the structure
        // refs need to mirror so toggling modes shows the same shape.
        const refWeeks = [];
        for (const g of scoped) {
          let wk = refWeeks.find((w) => w.week === g.week);
          if (!wk) { wk = { week: g.week, date: g.date, games: [] }; refWeeks.push(wk); }
          wk.games.push(g);
        }
        refWeeks.sort((a, b) => (a.week - b.week));
        const youName = refName ? refName.trim().toLowerCase() : "";
        const myInfo = refName ? (refList.find((x) => x.name.toLowerCase() === youName) || {}) : {};
        const myGames = mine.slice().sort((a, b) => (a.week - b.week) || String(a.time).localeCompare(String(b.time)));
        return (
          <div className="board-split">
            {/* LEFT 2/3 — check-in + the field schedule */}
            <div className="board-main">
              <div className="card">
                <h2 style={{ marginTop: 0, marginBottom: 4 }}>Referee check-in</h2>
                <p className="muted small">Scan your key tag (or type your name) to pull up your weekly field schedule.</p>
                <div className="addbar">
                  <input value={refIn} onChange={(e) => setRefIn(e.target.value)} placeholder="Scan key tag or type your name…" autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") checkInRef(refIn); }} />
                  <button className="btn primary" onClick={() => checkInRef(refIn)}>Check in</button>
                </div>
                {refName && (() => {
                  const known = refList.some((x) => x.name.toLowerCase() === refName.toLowerCase());
                  return (
                    <div className={"note " + (known ? "good" : "warn")} style={{ marginTop: 10, marginBottom: 0 }}>
                      On duty: <b>{refName}</b> · {mine.length} game{mine.length !== 1 ? "s" : ""}{mine.length ? "" : " (none assigned yet)"}
                      {!known && <span className="muted small" style={{ display: "block" }}>Not found on the referee list — check your key tag, or add yourself on the Referees page.</span>}
                      <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={async () => { if (refName) await api.refShift(refName, "out"); setRefName(""); setRefIn(""); setRefScope("mine"); }}>Check out</button>
                    </div>
                  );
                })()}
              </div>

              <div className="card">
                <div className="row" style={{ flexWrap: "wrap" }}>
                  {refName && (
                    <div><label className="fld">Show</label>
                      <select value={refScope} onChange={(e) => setRefScope(e.target.value)}>
                        <option value="mine">My games</option>
                        <option value="all">Whole league</option>
                      </select></div>
                  )}
                  <div><label className="fld">League</label>
                    <select value={refLeague} onChange={(e) => setRefLeague(e.target.value)}>
                      <option value="">All leagues</option>{leaguesR.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select></div>
                  <div><label className="fld">Division</label>
                    <select value={filterDivision} onChange={(e) => { dividedDefaultedRef.current = true; setFilterDivision(e.target.value); }}>
                      <option value="">All divisions</option>{divsR.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select></div>
                  <div><label className="fld">Field</label>
                    <select value={refField} onChange={(e) => setRefField(e.target.value)}>
                      <option value="">All fields</option>{fields.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select></div>
                </div>
                <div className="muted small" style={{ marginTop: 8 }}>
                  {scoped.length} game{scoped.length !== 1 ? "s" : ""} shown{refName ? ` · ${mine.length} assigned to ${refName}` : ""}
                  {refName && refScope === "mine" && !mine.length ? " · nothing assigned to you yet — switch Show to Whole league to see every game." : ""}
                </div>
              </div>

              {!refGames.length && <div className="card"><p className="muted" style={{ margin: 0 }}>No games yet. Build a schedule first.</p></div>}
              {refGames.length > 0 && !scoped.length && !(refName && refScope === "mine" && !mine.length) && (
                <div className="card"><p className="muted" style={{ margin: 0 }}>No games match — try a different league, division, or field.</p></div>
              )}

              {/* Same Week → Division → Field/Time layout the admin Saved view uses.
                  Divisions appear with their real names (e.g. "Ages 4-6") because we
                  reuse the admin's divisionOf instead of the player-only fallback. */}
              {refWeeks.map((w) => {
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
                            <div className={"drag-item" + (isMine(g) ? " linked" : "")} key={g.id} style={{ cursor: "default", flexWrap: "wrap", gap: 8 }}>
                              <span style={{ flex: "1 1 220px" }}>
                                <b>{g.home}</b> <span className="muted">vs</span> {g.away}
                                <span className="muted small"> · {g.location || "Field TBD"}</span>
                              </span>
                              {g.time && <span className="chip">{g.time}</span>}
                              <span className="muted small" style={{ flex: "0 0 auto" }}>
                                {g.referee ? <>ref {g.referee}{isMine(g) ? " (you)" : ""}</> : <em>ref TBD</em>}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

            {/* RIGHT 1/3 — the checked-in referee's details, like the Team Board */}
            <aside className="board-side">
              <div className="card" style={{ marginBottom: 0 }}>
                <h2 style={{ marginTop: 0, marginBottom: 4 }}>Check-in details</h2>
                <div className="muted small">Check in on the left and your day shows here — your fields, games and times.</div>
                {refName ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="scan-result good" style={{ marginBottom: 12 }}>
                      <div className="r-name">{refName}</div>
                      <div className="r-sub">On duty ✓ · {myGames.length} game{myGames.length !== 1 ? "s" : ""}</div>
                    </div>
                    <div className="stack" style={{ gap: 8, marginBottom: 12 }}>
                      <div className="kr-cell"><div className="kr-label">Phone</div><div className="kr-val">{myInfo.phone || "—"}</div></div>
                      <div className="kr-cell"><div className="kr-label">League</div><div className="kr-val">{myInfo.league || "—"}</div></div>
                      <div className="kr-cell"><div className="kr-label">Home field</div><div className="kr-val">{myInfo.field || "—"}</div></div>
                    </div>
                    <div className="kr-label" style={{ marginBottom: 4 }}>Your games</div>
                    {myGames.length ? (
                      <div className="stack" style={{ gap: 6 }}>
                        {myGames.map((g) => {
                          const worked = !!g.worked_by && g.worked_by.toLowerCase().includes(refName.toLowerCase());
                          return (
                            <div className="drag-item" key={g.id} style={{ cursor: "default", flexDirection: "column", alignItems: "stretch", gap: 6 }}>
                              <div className="between">
                                <span><b>Wk {g.week}</b> <span className="muted">{fmtDate(g.date)}</span> · {g.location || "Field TBD"} · {g.home} <span className="muted">vs</span> {g.away}</span>
                                {g.time && <span className="chip">{g.time}</span>}
                              </div>
                              <div className="row" style={{ gap: 6 }}>
                                {worked ? (
                                  <button className="btn ghost sm" onClick={async () => { await api.gameUnmarkWorked(g.id, refName); await loadRefGames(); }}>✓ Done — Undo</button>
                                ) : (
                                  <button className="btn primary sm" onClick={async () => { await api.gameMarkWorked(g.id, refName); await loadRefGames(); }}>Mark done</button>
                                )}
                                <select defaultValue="" onChange={async (e) => {
                                  const target = e.target.value;
                                  if (!target) return;
                                  if (!confirm(`Reassign this game to ${target}?`)) { e.target.value = ""; return; }
                                  await api.scheduleAssignRef(g.id, target);
                                  await loadRefGames();
                                  e.target.value = "";
                                }} style={{ maxWidth: 200 }}>
                                  <option value="">Reassign…</option>
                                  {referees.filter((r) => r.toLowerCase() !== refName.toLowerCase()).map((r) => <option key={r} value={r}>{r}</option>)}
                                </select>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : <div className="muted small">No games assigned to you yet. The full schedule is on the left.</div>}
                  </div>
                ) : <div className="muted small board-empty">No one checked in yet. Check in on the left and your fields, games and times show here.</div>}
              </div>
            </aside>
          </div>
        );
      })()}
    </div>
  );
}

function PacketsTab({ league }) {
  const [allGames, setAllGames] = useState([]);
  const [date, setDate] = useState("");
  useEffect(() => { (async () => { const r = await api.scheduleList(null); setAllGames(r.games || []); })(); }, []);
  const dates = [...new Set(allGames.map((g) => g.date).filter(Boolean))].sort();
  useEffect(() => { if (!date && dates.length) setDate(dates[0]); /* eslint-disable-next-line */ }, [dates.join("|")]);
  const onDate = allGames.filter((g) => g.date === date);
  const fieldGroups = {};
  for (const g of onDate) { const k = g.location || "Field TBD"; (fieldGroups[k] = fieldGroups[k] || []).push(g); }
  const fields = Object.keys(fieldGroups).sort();

  function openPacket(f) {
    const url = `/print/packet?date=${encodeURIComponent(date)}&field=${encodeURIComponent(f)}${league ? `&league=${encodeURIComponent(league)}` : ""}`;
    window.open(url, "_blank", "noopener");
  }
  function openAll() { for (const f of fields) openPacket(f); }

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Game day packets</h2>
        <p className="muted small">Pick a date — get a printable packet for each field with that day's schedule (sorted by time) and a scorecard for every game (coin toss, score, timeouts, possessions). Cmd-P → Save as PDF.</p>
        <div className="row">
          <div>
            <label className="fld">Game day</label>
            <select value={date} onChange={(e) => setDate(e.target.value)}>
              {dates.length ? dates.map((d) => <option key={d} value={d}>{fmtDate(d)} ({d})</option>) : <option value="">(no dates yet)</option>}
            </select>
          </div>
        </div>
      </div>

      {date && fields.length === 0 && (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No games scheduled on {fmtDate(date)} yet.</p></div>
      )}

      {date && fields.length > 0 && (
        <div className="card">
          <div className="between" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{fields.length} field{fields.length !== 1 ? "s" : ""} on {fmtDate(date)}</h3>
            <button className="btn" onClick={openAll}>Open all packets</button>
          </div>
          <div className="stack">
            {fields.map((f) => (
              <div className="between" key={f} style={{ borderBottom: "1px solid var(--line-soft)", paddingBottom: 8 }}>
                <div>
                  <b>{f}</b>
                  <span className="muted small"> · {fieldGroups[f].length} game{fieldGroups[f].length !== 1 ? "s" : ""}</span>
                </div>
                <button className="btn primary" onClick={() => openPacket(f)}>Open packet</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function PayTab({ league }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [filterLeague, setFilterLeague] = useState(league || "");
  const [filterField, setFilterField] = useState("");
  const [rows, setRows] = useState([]);
  const [allGames, setAllGames] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { (async () => { const r = await api.scheduleList(null); setAllGames(r.games || []); })(); }, []);
  const allLeagues = [...new Set(allGames.map((g) => g.league).filter(Boolean))].sort();
  const allFields = [...new Set(allGames.map((g) => g.location).filter(Boolean))].sort();

  async function run() {
    setBusy(true);
    const r = await api.payReport({ from: from || undefined, to: to || undefined, league: filterLeague || undefined, field: filterField || undefined });
    setRows(r.rows || []);
    setBusy(false);
  }
  useEffect(() => { run(); /* eslint-disable-next-line */ }, []);

  const grandGames = rows.reduce((a, r) => a + r.games, 0);
  const grandTotal = rows.reduce((a, r) => a + r.total, 0);

  function exportCsv() {
    const esc = (s) => '"' + String(s == null ? "" : s).replace(/"/g, '""') + '"';
    const head = ["Referee", "Rate per game", "Games worked", "Total"].join(",");
    const lines = rows.map((r) => [r.name, r.rate, r.games, r.total].map(esc).join(","));
    const csv = [head, ...lines, "", `"Range",${esc(from || "all")},${esc(to || "all")}`, `"League",${esc(filterLeague || "all")}`, `"Field",${esc(filterField || "all")}`].join("\r\n");
    downloadFile(`ref-pay-${from || "all"}-to-${to || "all"}.csv`, csv, "text/csv");
  }

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Referee pay</h2>
        <p className="muted small">Counts each "Mark done" tap × the referee's pay rate. Set rates on the Referees page.</p>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div><label className="fld">From</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label className="fld">To</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <div><label className="fld">League</label>
            <select value={filterLeague} onChange={(e) => setFilterLeague(e.target.value)}>
              <option value="">All</option>
              {allLeagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div><label className="fld">Field</label>
            <select value={filterField} onChange={(e) => setFilterField(e.target.value)}>
              <option value="">All</option>
              {allFields.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn primary" disabled={busy} onClick={run}>{busy ? "Running…" : "Run report"}</button>
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Referee</th><th style={{ textAlign: "right" }}>Rate / game</th><th style={{ textAlign: "right" }}>Games worked</th><th style={{ textAlign: "right" }}>Total</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td><b>{r.name}</b></td>
                <td style={{ textAlign: "right" }}>${r.rate.toFixed(2)}</td>
                <td style={{ textAlign: "right" }}>{r.games}</td>
                <td style={{ textAlign: "right" }}><b>${r.total.toFixed(2)}</b></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={4} className="muted" style={{ padding: 16 }}>No worked games match.</td></tr>}
            {rows.length > 0 && (
              <tr style={{ borderTop: "2px solid var(--line)" }}>
                <td><b>Total</b></td>
                <td></td>
                <td style={{ textAlign: "right" }}><b>{grandGames}</b></td>
                <td style={{ textAlign: "right" }}><b>${grandTotal.toFixed(2)}</b></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ScoresTab() {
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const [allGames, setAllGames] = useState([]);
  const [date, setDate] = useState(todayIso());
  const [filterField, setFilterField] = useState("");
  const [filterLeague, setFilterLeague] = useState("");
  const [flash, setFlash] = useState(null);
  const [editing, setEditing] = useState({}); // game_id -> { home, away, forfeit, note }
  const [standings, setStandings] = useState([]);
  const [showStandings, setShowStandings] = useState(false);

  async function loadGames() {
    const r = await api.scheduleList(null);
    setAllGames(r.games || []);
  }
  async function loadStandings() {
    const r = await api.standings(filterLeague || null);
    setStandings(r.rows || []);
  }
  useEffect(() => { loadGames(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (showStandings) loadStandings(); /* eslint-disable-next-line */ }, [showStandings, filterLeague]);

  const dates = [...new Set(allGames.map((g) => g.date).filter(Boolean))].sort();
  const leaguesAll = [...new Set(allGames.map((g) => g.league).filter(Boolean))].sort();
  const fieldsAll = [...new Set(allGames.map((g) => g.location).filter(Boolean))].sort();

  const onDate = allGames.filter((g) => g.date === date && (!filterField || g.location === filterField) && (!filterLeague || g.league === filterLeague));
  const byField = {};
  for (const g of onDate) { const k = g.location || "Field TBD"; (byField[k] = byField[k] || []).push(g); }
  const fieldKeys = Object.keys(byField).sort();

  const cell = (g) => editing[g.id] || { home: g.home_score == null ? "" : String(g.home_score), away: g.away_score == null ? "" : String(g.away_score), forfeit: g.winner?.startsWith("forfeit_") ? (g.winner === "forfeit_home" ? "home" : "away") : "", note: g.score_note || "" };
  const setCell = (gid, patch) => setEditing((prev) => ({ ...prev, [gid]: { ...cell({ id: gid, home_score: "", away_score: "" }), ...prev[gid], ...patch } }));

  async function saveScore(g) {
    const c = cell(g);
    const res = await api.gameSetScore(g.id, {
      home_score: c.home === "" ? null : Number(c.home),
      away_score: c.away === "" ? null : Number(c.away),
      forfeit: c.forfeit || "",
      note: c.note || "",
    });
    if (res.error) { setFlash({ ok: false, text: res.error }); return; }
    setFlash({ ok: true, text: `Saved: ${g.home} ${c.forfeit === "home" ? "F" : (c.home || 0)} – ${c.forfeit === "away" ? "F" : (c.away || 0)} ${g.away}` });
    setEditing((prev) => { const n = { ...prev }; delete n[g.id]; return n; });
    await loadGames();
    if (showStandings) await loadStandings();
  }
  async function clearScore(g) {
    if (!confirm("Clear the score for this game?")) return;
    await api.gameClearScore(g.id);
    setEditing((prev) => { const n = { ...prev }; delete n[g.id]; return n; });
    await loadGames();
    if (showStandings) await loadStandings();
  }

  const winnerLabel = (g) => {
    if (!g.winner) return null;
    if (g.winner === "home") return `${g.home} won`;
    if (g.winner === "away") return `${g.away} won`;
    if (g.winner === "tie") return "Tie";
    if (g.winner === "forfeit_home") return `${g.home} forfeited — ${g.away} wins`;
    if (g.winner === "forfeit_away") return `${g.away} forfeited — ${g.home} wins`;
    return null;
  };

  const sortGames = (arr) => arr.slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));

  return (
    <>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Score entry</h2>
        <p className="muted small">End-of-slot final scores. Pick a date, enter home / away, save — winner is computed. Use the forfeit toggle if a team didn't show.</p>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div><label className="fld">Game day</label>
            <select value={date} onChange={(e) => setDate(e.target.value)}>
              {dates.length ? dates.map((d) => <option key={d} value={d}>{fmtDate(d)} ({d})</option>) : <option value="">(no dates)</option>}
              {!dates.includes(date) && date && <option value={date}>{fmtDate(date)} ({date})</option>}
            </select>
          </div>
          <div><label className="fld">League</label>
            <select value={filterLeague} onChange={(e) => setFilterLeague(e.target.value)}>
              <option value="">All</option>{leaguesAll.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div><label className="fld">Field</label>
            <select value={filterField} onChange={(e) => setFilterField(e.target.value)}>
              <option value="">All</option>{fieldsAll.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>{onDate.length} game{onDate.length !== 1 ? "s" : ""} on {fmtDate(date)}.</div>
      </div>

      {!onDate.length && <div className="card"><p className="muted" style={{ margin: 0 }}>No games match. Pick another date or clear filters.</p></div>}

      {fieldKeys.map((fld) => (
        <div className="card" key={fld}>
          <div className="between" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>{fld}</h3>
            <span className="chip">{byField[fld].length} game{byField[fld].length !== 1 ? "s" : ""}</span>
          </div>
          <table className="tbl">
            <thead><tr><th>Time</th><th>League</th><th>Matchup</th><th>Home</th><th>Away</th><th>Forfeit</th><th></th></tr></thead>
            <tbody>
              {sortGames(byField[fld]).map((g) => {
                const c = cell(g);
                const scored = !!g.winner;
                return (
                  <tr key={g.id}>
                    <td><b>{g.time || "—"}</b></td>
                    <td className="muted small">{g.league || ""}</td>
                    <td>
                      <div>{g.home} <span className="muted">vs</span> {g.away}</div>
                      {scored && <div className="small" style={{ color: "var(--good)", fontWeight: 600 }}>✓ {winnerLabel(g)} ({g.home_score} – {g.away_score})</div>}
                      {g.score_note && <div className="muted small">{g.score_note}</div>}
                    </td>
                    <td><input type="number" min={0} value={c.home} onChange={(e) => setCell(g.id, { home: e.target.value })} style={{ width: 70 }} /></td>
                    <td><input type="number" min={0} value={c.away} onChange={(e) => setCell(g.id, { away: e.target.value })} style={{ width: 70 }} /></td>
                    <td>
                      <select value={c.forfeit} onChange={(e) => setCell(g.id, { forfeit: e.target.value })} style={{ minWidth: 110 }}>
                        <option value="">No</option>
                        <option value="home">{g.home} forfeit</option>
                        <option value="away">{g.away} forfeit</option>
                      </select>
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button className="btn primary sm" onClick={() => saveScore(g)}>{scored ? "Update" : "Save"}</button>
                      {scored && <button className="btn ghost sm" style={{ marginLeft: 4 }} onClick={() => clearScore(g)}>Clear</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}

      <div className="card">
        <div className="between">
          <h3 style={{ margin: 0 }}>Standings</h3>
          <button className="btn ghost sm" onClick={() => setShowStandings((v) => !v)}>{showStandings ? "Hide" : "Show"}</button>
        </div>
        {showStandings && (
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead><tr><th>Team</th><th>League</th><th>W</th><th>L</th><th>T</th><th>PF</th><th>PA</th></tr></thead>
            <tbody>
              {standings.length ? standings.map((s) => (
                <tr key={s.team}><td><b>{s.team}</b></td><td className="muted small">{s.league}</td><td>{s.wins}</td><td>{s.losses}</td><td>{s.ties}</td><td>{s.pf}</td><td>{s.pa}</td></tr>
              )) : <tr><td colSpan={7} className="muted" style={{ padding: 16 }}>No scored games yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function BlackoutsCard({ league, bare = false }) {
  const [list, setList] = useState([]);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState("league"); // "league" or "global"
  async function load() { const r = await api.blackoutsList(league); setList(r.blackouts || []); }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [league]);
  async function add() {
    if (!date) return;
    const r = await api.blackoutAdd({ date, league: scope === "global" ? "" : league, reason });
    if (r.error) return alert(r.error);
    setDate(""); setReason(""); await load();
  }
  async function remove(id) { await api.blackoutRemove(id); await load(); }
  const Body = (
    <>
      {!bare && <>
        <h3 style={{ marginTop: 0 }}>Blackout dates</h3>
        <p className="muted small">Dates the schedule should skip — field unavailable, holidays, etc. The week dates auto-jump past them.</p>
      </>}
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
        <div><label className="fld">Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div style={{ flex: "1 1 220px", minWidth: 180 }}><label className="fld">Reason (optional)</label><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Memorial Day, fields closed" /></div>
        <div><label className="fld">Scope</label>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="league">Just {league}</option>
            <option value="global">All leagues</option>
          </select>
        </div>
        <button className="btn primary" style={{ flex: "0 0 auto" }} disabled={!date} onClick={add}>Add date</button>
      </div>
      <div className="stack" style={{ marginTop: 12 }}>
        {list.length ? list.map((b) => (
          <div className="between" key={b.id} style={{ borderBottom: "1px solid var(--line-soft)", paddingBottom: 6 }}>
            <div className="small"><b>{b.date}</b>{b.league ? <span className="muted"> · {b.league}</span> : <span className="muted"> · all leagues</span>}{b.reason ? <span className="muted"> · {b.reason}</span> : null}</div>
            <button className="btn ghost sm" onClick={() => remove(b.id)}>Remove</button>
          </div>
        )) : <div className="muted small">No blackouts yet — the season runs straight through.</div>}
      </div>
    </>
  );
  return bare ? Body : <div className="card">{Body}</div>;
}

// Combined rainout + explicit reschedule card. Sits at the top of the Saved
// schedule so day-of-game admin actions are one click away.
//
// Two modes:
//   - Shift to next weekend (current rainout behavior — adds a blackout, then
//     cascades all games from that date forward into the next available slot).
//   - Move to a specific date (explicit; doesn't add a blackout, doesn't cascade).
//
// The "to" picker auto-suggests the next non-blackout Saturday after the source
// date so the common case (parents' kid's birthday on Saturday, push to next
// week) is one click.
function RescheduleCard({ saved, league, onApplied, setFlash }) {
  // Distinct game dates we can act on, sorted ascending.
  const dates = [...new Set(saved.map((g) => g.date).filter(Boolean))].sort();
  const [mode, setMode] = useState("cascade"); // "cascade" | "move"
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("Rainout");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  // Default to the earliest dated game and the next-week date.
  useEffect(() => {
    if (!from && dates.length) setFrom(dates[0]);
  }, [dates.join(",")]); // eslint-disable-line

  // Suggest "to" = from + 7 days when in move mode and nothing typed yet.
  useEffect(() => {
    if (mode !== "move" || !from || to) return;
    const d = new Date(from + "T00:00:00");
    if (!isNaN(d)) { d.setDate(d.getDate() + 7); setTo(d.toISOString().slice(0, 10)); }
  }, [mode, from, to]);

  const fromCount = saved.filter((g) => g.date === from).length;

  async function doPreview() {
    if (!from) return;
    setPreview(null);
    if (mode === "cascade") {
      const r = await api.scheduleRainoutPreview(from, league || null);
      setPreview(r);
    } else {
      if (!to) return;
      const r = await api.scheduleRescheduleDate(from, to, league || null, true);
      setPreview(r);
    }
  }
  useEffect(() => { doPreview(); /* eslint-disable-next-line */ }, [mode, from, to]);

  async function apply() {
    if (!from) return;
    setBusy(true);
    try {
      if (mode === "cascade") {
        const r = await api.scheduleRainoutApply(from, league || null, reason || "Rainout");
        if (r.error) { setFlash?.({ ok: false, text: r.error }); return; }
        setFlash?.({ ok: true, text: `Shifted ${r.moved} game${r.moved === 1 ? "" : "s"}.` });
      } else {
        if (!to) return;
        const r = await api.scheduleRescheduleDate(from, to, league || null, false);
        if (r.error) { setFlash?.({ ok: false, text: r.error }); return; }
        setFlash?.({ ok: true, text: `Moved ${r.moved} game${r.moved === 1 ? "" : "s"} from ${from} to ${to}.` });
      }
      onApplied && onApplied();
    } finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ borderColor: "var(--brand)" }}>
      <div className="between" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Reschedule / rainout</h3>
        <div className="btn-row" style={{ gap: 4 }}>
          <button className={"pill" + (mode === "cascade" ? " active" : "")} onClick={() => { setMode("cascade"); setPreview(null); }}>Shift cascade</button>
          <button className={"pill" + (mode === "move" ? " active" : "")} onClick={() => { setMode("move"); setPreview(null); }}>Move to date</button>
        </div>
      </div>
      <p className="muted small" style={{ margin: "0 0 10px" }}>
        {mode === "cascade"
          ? "Cancels every game on this date and slides them — and everything after — to the next available weekend (skipping blackouts). Adds a blackout for the chosen date."
          : "Moves every game on this date to a specific other date. Doesn't add a blackout, doesn't touch other weekends."}
      </p>
      <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
        <div>
          <label className="fld">From date</label>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {dates.map((d) => <option key={d} value={d}>{fmtDate(d)} ({saved.filter((g) => g.date === d).length})</option>)}
          </select>
        </div>
        {mode === "move" && (
          <div>
            <label className="fld">To date</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        {mode === "cascade" && (
          <div style={{ flex: 1, minWidth: 180 }}>
            <label className="fld">Reason (logged with the blackout)</label>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Rainout, holiday, field closure…" />
          </div>
        )}
        <button
          className="btn primary"
          disabled={busy || !from || (mode === "move" && !to) || fromCount === 0}
          onClick={apply}
        >
          {busy ? "Applying…" : mode === "cascade" ? `Shift cascade · ${fromCount} game${fromCount === 1 ? "" : "s"}` : `Move ${fromCount} game${fromCount === 1 ? "" : "s"} to ${to ? fmtDate(to) : "—"}`}
        </button>
      </div>
      {preview && preview.mapping && preview.mapping.length > 0 && (
        <div className="muted small" style={{ marginTop: 8 }}>
          Preview: {preview.mapping.map((m, i) => <span key={i}>{i > 0 ? " · " : ""}{fmtDate(m.from)} → {fmtDate(m.to)} ({m.count} game{m.count === 1 ? "" : "s"})</span>)}
        </div>
      )}
    </div>
  );
}

// Compact month-grid calendar of the season. Shows game count per date with a
// subtle heat indicator, blackouts (red ring), and any active date filter
// applied via the saved filter (lit up). Read-only — meant as an at-a-glance
// view to spot empty weekends / overloaded days.
function ScheduleCalendar({ saved, league, onApplied, setFlash }) {
  const [blackouts, setBlackouts] = useState([]);
  const [openDay, setOpenDay] = useState(null); // ISO date of opened day-detail modal
  async function refreshBlackouts() {
    try { const r = await api.blackoutsList(league || null); setBlackouts((r && r.blackouts) || []); }
    catch { setBlackouts([]); }
  }
  useEffect(() => { refreshBlackouts(); /* eslint-disable-next-line */ }, [league]);

  // Bucket: ISO date → game count.
  const counts = {};
  for (const g of saved) { if (g.date) counts[g.date] = (counts[g.date] || 0) + 1; }
  // Map ISO → blackout entry so the modal can show reason / league scope.
  const blackByDate = {};
  for (const b of blackouts || []) blackByDate[b.date] = b;
  const blackSet = new Set(Object.keys(blackByDate));
  const dates = Object.keys(counts).sort();
  if (!dates.length) return null;

  // Determine the months to render — span first→last saved date, plus any
  // blackout outside that range so a blocked-but-no-games week still shows.
  const allDates = [...new Set([...dates, ...Object.keys(blackByDate)])].sort();
  const first = new Date(allDates[0] + "T00:00:00");
  const last = new Date(allDates[allDates.length - 1] + "T00:00:00");
  const months = [];
  const cur = new Date(first.getFullYear(), first.getMonth(), 1);
  const end = new Date(last.getFullYear(), last.getMonth(), 1);
  while (cur <= end) { months.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }

  // Two-state coloring: any day with games = solid red; blackout = solid black.
  // No density gradient — at a glance the user just wants to see "are there
  // games here" / "is this day blocked".
  const GAME_RED = "var(--brand, #c8102e)";
  const BLACKOUT_BLACK = "#111";
  const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="card">
      <div className="between" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Season calendar</h3>
        <div className="muted small">{dates.length} game day{dates.length === 1 ? "" : "s"} · {Object.values(counts).reduce((a, b) => a + b, 0)} game{Object.values(counts).reduce((a, b) => a + b, 0) === 1 ? "" : "s"}{blackouts.length ? ` · ${blackouts.length} blackout${blackouts.length === 1 ? "" : "s"}` : ""}</div>
      </div>
      <p className="muted small" style={{ marginTop: 0, marginBottom: 10 }}>
        Click any day with games to open its schedule. Blackouts (red ring) mean no games can be scheduled on that date for the selected league — or for <b>every</b> league when the blackout is league-blank.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        {months.map((m) => {
          const monthName = m.toLocaleDateString([], { month: "long", year: "numeric" });
          const firstDay = new Date(m.getFullYear(), m.getMonth(), 1).getDay();
          const daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
          const cells = [];
          for (let i = 0; i < firstDay; i++) cells.push(null);
          for (let d = 1; d <= daysInMonth; d++) {
            const iso = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            cells.push({ d, iso, count: counts[iso] || 0, blackout: blackByDate[iso] || null });
          }
          return (
            <div key={monthName}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{monthName}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, fontSize: 11 }}>
                {WEEKDAY.map((w, i) => <div key={"h" + i} className="muted" style={{ textAlign: "center", padding: "2px 0", fontWeight: 700 }}>{w}</div>)}
                {cells.map((c, i) => {
                  if (!c) return <div key={i} />;
                  const clickable = c.count > 0 || c.blackout;
                  const scope = c.blackout ? (c.blackout.league ? `${c.blackout.league} blackout` : "Blackout (all leagues)") : "";
                  const title = c.blackout
                    ? `${scope}${c.blackout.reason ? ` — ${c.blackout.reason}` : ""} · ${c.iso}`
                    : c.count
                      ? `${c.iso} · ${c.count} game${c.count === 1 ? "" : "s"} — click to open`
                      : c.iso;
                  // Blackout wins over games (a blackout day shouldn't have games anyway,
                  // and visually black needs to read as "no games allowed here").
                  const isBlackout = !!c.blackout;
                  const isGame = !isBlackout && c.count > 0;
                  const bg = isBlackout ? BLACKOUT_BLACK : isGame ? GAME_RED : "transparent";
                  const fg = (isBlackout || isGame) ? "#fff" : "var(--ink)";
                  return (
                    <div key={i}
                      role={clickable ? "button" : undefined}
                      tabIndex={clickable ? 0 : -1}
                      title={title}
                      onClick={() => clickable && setOpenDay(c.iso)}
                      onKeyDown={(e) => { if (clickable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpenDay(c.iso); } }}
                      style={{
                        aspectRatio: "1 / 1",
                        borderRadius: 6,
                        border: "1px solid var(--line-soft, #eee)",
                        background: bg,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontWeight: (isBlackout || isGame) ? 700 : 400,
                        color: fg,
                        padding: 2,
                        cursor: clickable ? "pointer" : "default",
                      }}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1 }}>
                        <span>{c.d}</span>
                        {isGame && <span style={{ fontSize: 9, opacity: 0.9 }}>{c.count}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="muted small" style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 14, background: GAME_RED, border: "1px solid var(--line)", borderRadius: 3, display: "inline-block" }} /> games scheduled
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 14, background: BLACKOUT_BLACK, border: "1px solid var(--line)", borderRadius: 3, display: "inline-block" }} /> blackout — no games allowed
        </span>
      </div>

      <DayDetailModal
        open={!!openDay}
        date={openDay}
        league={league}
        games={openDay ? saved.filter((g) => g.date === openDay) : []}
        blackout={openDay ? blackByDate[openDay] : null}
        onClose={() => setOpenDay(null)}
        onAnyChange={() => { refreshBlackouts(); onApplied && onApplied(); }}
        setFlash={setFlash}
      />
    </div>
  );
}

// Day-detail / day-packet modal. Lists every game on a specific date with
// inline editing for time, field, and referees. The header "Print day packet"
// button opens a print-friendly view of just this day's games.
function DayDetailModal({ open, date, league, games, blackout, onClose, onAnyChange, setFlash }) {
  const [drafts, setDrafts] = useState({}); // gameId → { time, location, referee }
  const [savingId, setSavingId] = useState(null);
  useEffect(() => { setDrafts({}); }, [date]);

  if (!open) return null;

  // Sort by time then field so the packet reads top-to-bottom in playing order.
  const sorted = games.slice().sort((a, b) => (a.time || "").localeCompare(b.time || "") || (a.location || "").localeCompare(b.location || ""));

  function setDraft(id, patch) { setDrafts((d) => ({ ...d, [id]: { ...(d[id] || {}), ...patch } })); }

  async function saveGame(g) {
    const patch = drafts[g.id] || {};
    if (!Object.keys(patch).length) return;
    setSavingId(g.id);
    try {
      // Translate to record fields the schema actually uses.
      const fields = {};
      if ("time" in patch) fields.time = patch.time;
      if ("location" in patch) fields.location = patch.location;
      if ("referee" in patch) fields.referee = patch.referee;
      const r = await api.updateRecord(g.id, fields);
      if (r && r.error) { setFlash?.({ ok: false, text: r.error }); return; }
      setDrafts((d) => { const n = { ...d }; delete n[g.id]; return n; });
      onAnyChange && onAnyChange();
    } finally { setSavingId(null); }
  }

  // Open the dedicated /print/packet route for a single field — full cover
  // sheet plus a 1-page scorecard per game (coin toss, score grid, timeouts,
  // possessions, ref sig). User saves as PDF from the browser's print dialog.
  function openFieldPacket(fieldName) {
    if (typeof window === "undefined") return;
    const url = `/print/packet?date=${encodeURIComponent(date)}&field=${encodeURIComponent(fieldName)}${league ? `&league=${encodeURIComponent(league)}` : ""}`;
    window.open(url, "_blank", "noopener");
  }
  function openAllFieldPackets() {
    const fields = [...new Set(sorted.map((g) => g.location || "Field TBD"))];
    if (!fields.length) return;
    for (const f of fields) openFieldPacket(f);
    if (fields.length > 1) setFlash?.({ ok: true, text: `Opened ${fields.length} packet tabs — use each browser's Save as PDF.` });
  }

  function printPacket() {
    // Printable view — mirrors the on-screen grouping (Division → Field → time)
    // so the packet matches what the admin sees.
    const dStr = (() => { try { return new Date(date + "T00:00:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }); } catch { return date; } })();
    const divisionOf = (g) => {
      const split = (s) => { const i = String(s || "").indexOf(" / "); return i > 0 ? s.slice(0, i) : ""; };
      return split(g.home_team || g.home || "") || split(g.away_team || g.away || "") || "(no division)";
    };
    const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
    const byDiv = new Map();
    for (const g of sorted) {
      const dv = divisionOf(g);
      if (!byDiv.has(dv)) byDiv.set(dv, new Map());
      const byField = byDiv.get(dv);
      const f = g.location || "(no field)";
      if (!byField.has(f)) byField.set(f, []);
      byField.get(f).push(g);
    }
    const divs = [...byDiv.keys()].sort(natural);
    const sections = divs.map((dv) => {
      const fields = [...byDiv.get(dv).keys()].sort(natural);
      const total = fields.reduce((n, f) => n + byDiv.get(dv).get(f).length, 0);
      const fieldCards = fields.map((f) => {
        const list = byDiv.get(dv).get(f).slice().sort((a, b) => (a.time || "").localeCompare(b.time || "") || natural(a.home_team || a.home || "", b.home_team || b.home || ""));
        const rows = list.map((g) => `
          <tr>
            <td style="padding:5px 8px;border-bottom:1px solid #e6e6ee;font-weight:700;white-space:nowrap;">${escapeHtml(g.time || "")}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #e6e6ee;"><b>${escapeHtml(g.home_team || g.home || "")}</b> <span style="color:#888">vs</span> ${escapeHtml(g.away_team || g.away || "")}</td>
            <td style="padding:5px 8px;border-bottom:1px solid #e6e6ee;color:#555;">${escapeHtml(g.referee || "")}</td>
          </tr>`).join("");
        return `
          <div style="break-inside:avoid;border:1px solid #ddd;border-radius:8px;padding:10px 12px;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
              <div style="font-weight:700;font-size:14px;">${escapeHtml(f)}</div>
              <div style="color:#888;font-size:12px;">${list.length} game${list.length === 1 ? "" : "s"}</div>
            </div>
            <table style="border-collapse:collapse;width:100%;font-size:12px;">${rows}</table>
          </div>`;
      }).join("");
      return `
        <section style="margin-bottom:20px;break-inside:avoid-page;">
          <h2 style="margin:0 0 6px;font-size:17px;border-bottom:2px solid #c8102e;padding-bottom:4px;">
            ${escapeHtml(dv)} <span style="color:#888;font-size:13px;font-weight:400;">· ${total} game${total === 1 ? "" : "s"} · ${fields.length} field${fields.length === 1 ? "" : "s"}</span>
          </h2>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(260px, 1fr));gap:10px;">${fieldCards}</div>
        </section>`;
    }).join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Day packet — ${escapeHtml(date)}</title>
      <style>@page { margin: 0.5in; } body { font-family: -apple-system, system-ui, sans-serif; color:#111; margin:0; }</style>
      </head><body>
      <h1 style="margin:0 0 4px;">Game day packet</h1>
      <div style="color:#555;margin-bottom:16px;">${escapeHtml(dStr)}${league ? ` · ${escapeHtml(league)}` : ""} · ${sorted.length} game${sorted.length === 1 ? "" : "s"}</div>
      ${sections}
      </body></html>`;
    const w = typeof window !== "undefined" ? window.open("", "_blank") : null;
    if (!w) { setFlash?.({ ok: false, text: "Pop-ups are blocked — allow them to print the day packet." }); return; }
    w.document.write(html); w.document.close();
    // Give the browser a tick to lay out before triggering the print dialog.
    setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 250);
  }

  const dStr = (() => { try { return new Date(date + "T00:00:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }); } catch { return date; } })();

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 920 }}>
        <div className="between" style={{ alignItems: "flex-start" }}>
          <div>
            <h2 style={{ marginBottom: 2 }}>{dStr}</h2>
            <div className="muted small">
              {league ? `${league} · ` : ""}
              {sorted.length} game{sorted.length === 1 ? "" : "s"}
              {blackout && <span style={{ marginLeft: 6, color: "var(--danger)", fontWeight: 700 }}>
                · BLACKOUT{blackout.league ? ` (${blackout.league})` : " (all leagues)"}{blackout.reason ? ` — ${blackout.reason}` : ""}
              </span>}
            </div>
          </div>
          <div className="btn-row">
            <button className="btn" onClick={openAllFieldPackets} disabled={!sorted.length} title="Opens a printable scorecard packet per field — save each as PDF from your browser">Field packets (PDF)</button>
            <button className="btn ghost sm" onClick={printPacket} disabled={!sorted.length} title="Quick summary print of the whole day">Day summary</button>
            <button className="btn ghost sm" onClick={onClose}>Close</button>
          </div>
        </div>

        {sorted.length === 0 && (
          <div className="muted small" style={{ marginTop: 12 }}>
            No games scheduled on this date{blackout ? " — it's a blackout." : "."}
          </div>
        )}

        {sorted.length > 0 && (() => {
          // Group: Division → Field → time-sorted games. Division comes from the
          // team-name prefix ("Ages 11-12 / Team 1"); games with no clear prefix
          // bucket under "(no division)" so they're still visible.
          const divisionOf = (g) => {
            const split = (s) => { const i = String(s || "").indexOf(" / "); return i > 0 ? s.slice(0, i) : ""; };
            return split(g.home_team || g.home || "") || split(g.away_team || g.away || "") || "(no division)";
          };
          const byDiv = new Map();
          for (const g of sorted) {
            const dv = divisionOf(g);
            if (!byDiv.has(dv)) byDiv.set(dv, new Map());
            const byField = byDiv.get(dv);
            const f = g.location || "(no field)";
            if (!byField.has(f)) byField.set(f, []);
            byField.get(f).push(g);
          }
          // Stable, human-friendly order: divisions sorted alphabetically (so
          // "Ages 9-10" comes before "Ages 11-12" only when natural-sort is on),
          // fields sorted with natural numbers ("Field 2" < "Field 10"), games
          // within a field by time then home team.
          const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });
          const divs = [...byDiv.keys()].sort(natural);

          return (
            <div className="stack" style={{ gap: 18, marginTop: 14 }}>
              {divs.map((dv) => {
                const fields = [...byDiv.get(dv).keys()].sort(natural);
                const total = fields.reduce((n, f) => n + byDiv.get(dv).get(f).length, 0);
                return (
                  <section key={dv}>
                    <h3 style={{ margin: "0 0 8px", borderBottom: "2px solid var(--brand)", paddingBottom: 4 }}>
                      {dv} <span className="muted small">· {total} game{total === 1 ? "" : "s"} · {fields.length} field{fields.length === 1 ? "" : "s"}</span>
                    </h3>
                    {/* Compact field cards — multiple fit per row, each row is two
                        lines max (time + matchup, then ref). 200px min lets 5 fit
                        across on a 1100px content area. */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
                      {fields.map((f) => {
                        const list = byDiv.get(dv).get(f).slice().sort((a, b) => (a.time || "").localeCompare(b.time || "") || natural(a.home_team || a.home || "", b.home_team || b.home || ""));
                        return (
                          <div className="card" key={f} style={{ padding: "8px 10px" }}>
                            <div className="between" style={{ marginBottom: 4 }}>
                              <div style={{ fontWeight: 700, fontSize: 13 }}>{f}</div>
                              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                <span className="chip" style={{ fontSize: 11, padding: "1px 7px" }}>{list.length}</span>
                                <button className="btn ghost sm" style={{ fontSize: 11, padding: "2px 8px" }} title="Open this field's printable packet (scorecards)" onClick={() => openFieldPacket(f)}>Packet</button>
                              </div>
                            </div>
                            <div className="stack" style={{ gap: 4 }}>
                              {list.map((g) => {
                                const draft = drafts[g.id] || {};
                                const has = Object.keys(draft).length > 0;
                                return (
                                  <div key={g.id} style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 4 }}>
                                    <div style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 12, marginBottom: 3 }}>
                                      <input type="text" value={draft.time ?? (g.time || "")} placeholder="hh:mm"
                                        onChange={(e) => setDraft(g.id, { time: e.target.value })}
                                        style={{ width: 58, flex: "0 0 auto", padding: "3px 5px", fontVariantNumeric: "tabular-nums", fontWeight: 700, fontSize: 12 }} />
                                      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.25, fontSize: 12 }}>
                                        <b>{g.home_team || g.home || ""}</b>
                                        <span className="muted"> vs </span>
                                        <span>{g.away_team || g.away || ""}</span>
                                      </span>
                                    </div>
                                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                      <input type="text" value={draft.referee ?? (g.referee || "")} placeholder="Ref…"
                                        onChange={(e) => setDraft(g.id, { referee: e.target.value })}
                                        style={{ flex: 1, minWidth: 0, padding: "3px 5px", fontSize: 12 }} />
                                      {has && (
                                        <>
                                          <button className="btn primary sm" style={{ padding: "3px 8px", fontSize: 11 }} disabled={savingId === g.id} onClick={() => saveGame(g)}>{savingId === g.id ? "…" : "Save"}</button>
                                          <button className="btn ghost sm" style={{ padding: "3px 6px", fontSize: 11 }} onClick={() => setDrafts((d) => { const n = { ...d }; delete n[g.id]; return n; })}>×</button>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// Small HTML escape so the print packet can't be exploded by a stray "<" in
// team/league names.
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function RainoutButton({ date, league, onApplied }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [reason, setReason] = useState("Rainout");
  const [busy, setBusy] = useState(false);
  async function loadPreview() {
    const r = await api.rainoutPreview({ date, league: league || null });
    setPreview(r);
  }
  useEffect(() => { if (open && !preview) loadPreview(); /* eslint-disable-next-line */ }, [open]);
  async function apply() {
    setBusy(true);
    const r = await api.rainoutApply({ date, league: league || null, reason });
    setBusy(false);
    if (r.error) return alert(r.error);
    setOpen(false); setPreview(null); onApplied && onApplied();
  }
  return (
    <>
      <button className="btn ghost sm" onClick={() => setOpen(true)} title="Rainout — shift this week and everything after">Rainout</button>
      {open && (
        <div className="overlay" onClick={() => { setOpen(false); setPreview(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 4 }}>Rainout — {date}</h2>
            <p className="muted small" style={{ marginBottom: 12 }}>This blacks out <b>{date}</b>{league ? ` for ${league}` : ""} and shifts every saved game on or after it to the next non-blackout slot.</p>
            <label className="fld">Reason (optional, saved with the blackout)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Rainout" />
            <div style={{ marginTop: 14 }}>
              <div className="fld">Preview</div>
              {!preview ? <div className="muted small">Loading…</div>
                : preview.affected === 0 ? <div className="muted small">No saved games on or after that date.</div>
                : (
                  <table className="tbl">
                    <thead><tr><th>From</th><th></th><th>To</th><th style={{ textAlign: "right" }}>Games</th></tr></thead>
                    <tbody>
                      {preview.mapping.map((m, i) => (
                        <tr key={i}><td>{m.from}</td><td className="muted">→</td><td><b>{m.to}</b></td><td style={{ textAlign: "right" }}>{m.count}</td></tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </div>
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn primary" disabled={busy || !preview || preview.affected === 0} onClick={apply}>{busy ? "Applying…" : `Shift ${preview ? preview.affected : "…"} game${preview && preview.affected === 1 ? "" : "s"}`}</button>
              <button className="btn" onClick={() => { setOpen(false); setPreview(null); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
