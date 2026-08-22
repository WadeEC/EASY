"use client";
import { useEffect, useState } from "react";
import { api, currentSeason } from "@/lib/api.js";

// Export this season to Excel or CSV.
//
// Lives on the pages where you'd actually reach for it — Teams and the Master
// Spreadsheet — rather than on a settings page you'd have to remember exists.
// It always exports the season shown in the sidebar picker, and the filename
// says which season, so a workbook in someone's Downloads folder can't be
// mistaken for another year's.
export default function ExportBar({ title = "Export", compact = false }) {
  const season = currentSeason();
  const [leagues, setLeagues] = useState(null);   // null = loading
  const [league, setLeague] = useState("");        // "" = whole season
  const [err, setErr] = useState(null);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await api.exportOptions();
        if (dead) return;
        if (r?.error) { setErr(r.error); setLeagues([]); return; }
        const row = (r.seasons || []).find((s) => s.season === season);
        setLeagues(row ? row.leagues : []);
        setLeague("");
      } catch (e) { if (!dead) { setErr(String(e?.message || e)); setLeagues([]); } }
    })();
    return () => { dead = true; };
  }, [season]);

  if (season === "*") {
    return (
      <div className="muted small">
        Pick a single season in the sidebar to export — an export that blended two seasons
        would be worse than no export.
      </div>
    );
  }

  const url = (format) => api.exportUrl({
    season, league: league || null, scope: league ? "league" : "season", format,
  });

  return (
    <div className={compact ? "" : "card"}>
      {!compact && (
        <>
          <h3 style={{ marginTop: 0, marginBottom: 4 }}>{title}</h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            <b>{season}</b>. A league workbook has Roster, Unassigned, Teams, Coaches, Schedule,
            Standings, Attendance and Master Sheet tabs. The CSV bundle is the same tabs as
            separate files in a .zip.
          </p>
        </>
      )}
      {err && <div className="note warn">{err}</div>}
      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
        <div style={{ minWidth: 220 }}>
          <label className="fld">What</label>
          <select value={league} onChange={(e) => setLeague(e.target.value)}>
            <option value="">The whole {season} season</option>
            {(leagues || []).map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <a className="btn primary" href={url("xlsx")}>Excel (.xlsx)</a>
        <a className="btn" href={url("zip")}>All tabs as CSV (.zip)</a>
        <a className="btn ghost" href={url("csv")}>Roster only (.csv)</a>
      </div>
      {leagues && !leagues.length && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {season} has no leagues set yet — the whole-season export still works.
        </div>
      )}
    </div>
  );
}
