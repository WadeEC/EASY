"use client";
import { useEffect, useMemo, useState } from "react";
import { api, currentSeason } from "@/lib/api.js";
import ExportBar from "./ExportBar.jsx";

// Master Spreadsheet view — every row the league has ever imported, including
// columns we don't have a structured field for. Useful for:
//   - auditing what came in from a given township / file
//   - exporting a "union of all data" snapshot to CSV / XLSX
//   - finding the original source row for a current player
// Sort by surname, then first name — how you'd read a roster — with rows that
// have no name at all pushed to the bottom instead of sprinkled through.
function byName(a, b) {
  const al = (a.last_name || "").toLowerCase(), bl = (b.last_name || "").toLowerCase();
  if (!al !== !bl) return al ? -1 : 1;
  return al.localeCompare(bl) || (a.first_name || "").toLowerCase().localeCompare((b.first_name || "").toLowerCase());
}

export default function MasterSpreadsheet() {
  const [summary, setSummary] = useState(null);
  const [data, setData] = useState(null);                  // { columns, rows }
  const [type, setType] = useState("player");
  const [district, setDistrict] = useState("");            // "" = all
  const [status, setStatus] = useState("");                // added / recognized / ambiguous_added / ""
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [hiddenCols, setHiddenCols] = useState(() => new Set());
  const [showColsPicker, setShowColsPicker] = useState(false);
  const [sortBy, setSortBy] = useState("recent");   // "recent" (as imported) | "name"

  async function load() {
    setLoading(true);
    try {
      const [s, d] = await Promise.all([
        api.masterSummary(type || null),
        api.masterList(type || null),
      ]);
      setSummary(s);
      setData(d);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [type]);

  // Rows shape from the API (see app/api/master/route.js → handle):
  //   { record_type, columns: [...data column names...], rows: [{ id, source_file, source_district, source_league, status, player_id, imported_at, imported_by, record_type, data: {...} }] }
  const allColumns = data?.columns || [];
  // First / last lead the table. Uploads name people in every possible shape —
  // one "Player Name" column, separate First/Last, "Last, First" — and the master
  // sheet's job is to stop that being your problem.
  const provenance = ["_first_name", "_last_name", "_source_file", "_source_district", "_source_league", "_status", "_player_id", "_imported_at"];
  const allHeaders = [...provenance, ...allColumns];
  const visibleHeaders = allHeaders.filter((h) => !hiddenCols.has(h));

  const filtered = useMemo(() => {
    const rows = data?.rows || [];
    const qn = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (district && (r.source_district || "") !== district) return false;
      if (status && (r.status || "") !== status) return false;
      if (qn) {
        // Search across name + data values + filename + district
        const blob = [r.first_name, r.last_name, r.source_file, r.source_district, r.status, r.player_id, JSON.stringify(r.data || {})]
          .filter(Boolean).join(" ").toLowerCase();
        if (!blob.includes(qn)) return false;
      }
      return true;
    });
  }, [data, q, district, status]);

  // Default order is newest import first (how the rows arrive). Sorting by name
  // is the other thing people want from a master sheet, so it's one click.
  const rowsShown = useMemo(
    () => (sortBy === "name" ? [...filtered].sort(byName) : filtered),
    [filtered, sortBy]
  );

  const districtChoices = useMemo(() => {
    const s = new Set();
    for (const r of data?.rows || []) if (r.source_district) s.add(r.source_district);
    return [...s].sort();
  }, [data]);
  const statusChoices = useMemo(() => {
    const s = new Set();
    for (const r of data?.rows || []) if (r.status) s.add(r.status);
    return [...s].sort();
  }, [data]);
  const typeChoices = useMemo(() => {
    if (!summary?.byType) return ["player", "coach", "referee"];
    return Object.keys(summary.byType).length ? Object.keys(summary.byType) : ["player"];
  }, [summary]);

  // The season always travels with the download, and the filename it produces
  // names the season — so a master sheet sitting in someone's Downloads folder
  // can't be mistaken for another year's.
  function downloadUrl(format) {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    params.set("format", format);
    params.set("season", currentSeason());
    return `/api/master?${params.toString()}`;
  }

  function cellValue(row, header) {
    if (header === "_first_name") return row.first_name || "";
    if (header === "_last_name") return row.last_name || "";
    if (header === "_source_file") return row.source_file || "";
    if (header === "_source_district") return row.source_district || "";
    if (header === "_source_league") return row.source_league || "";
    if (header === "_status") return row.status || "";
    if (header === "_player_id") return row.player_id || "";
    if (header === "_imported_at") {
      const ts = Number(row.imported_at);
      return ts ? new Date(ts).toISOString().slice(0, 10) : "";
    }
    const v = row.data?.[header];
    if (v == null) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  const headerLabel = (h) => h.startsWith("_") ? h.slice(1).replace(/_/g, " ") : h;

  const stickyCellStyle = { position: "sticky", left: 0, background: "var(--card, #fff)", zIndex: 2, boxShadow: "2px 0 0 var(--line-soft, #eee)" };

  return (
    <div>
      <div className="page-head" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>
            Master spreadsheet{" "}
            <span className="chip brand lg">{currentSeason() === "*" ? "all seasons" : currentSeason()}</span>
          </h1>
          <div className="muted">
            Every row imported into <strong>{currentSeason() === "*" ? "any season" : currentSeason()}</strong>, including
            columns the structured schema doesn&apos;t track. Each season has its own master sheet — switch seasons
            in the sidebar to see another one.
          </div>
        </div>
        <div className="btn-row">
          <a className="btn" href={downloadUrl("csv")} download>Download CSV</a>
          <a className="btn primary" href={downloadUrl("xlsx")} download>Download Excel</a>
        </div>
      </div>

      {/* Those two buttons download the raw master rows. This exports the season
          as a working workbook — rosters, teams, schedule, standings, attendance
          and the master sheet as tabs. It sits up here because nobody finds a
          button parked under a 400-row table. */}
      <div className="card" style={{ padding: "12px 14px" }}>
        <div className="muted small" style={{ marginBottom: 6 }}><b>Export the whole season</b> — rosters, teams, schedule, standings, attendance and master, as tabs.</div>
        <ExportBar compact />
      </div>

      {/* Top summary strip */}
      {summary && (
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <div className="metric">
            <div className="label">Rows ({type})</div>
            <div className="value">{summary.total ?? 0}</div>
          </div>
          <div className="metric">
            <div className="label">Source files</div>
            <div className="value">{summary.files?.length ?? 0}</div>
          </div>
          <div className="metric">
            <div className="label">Districts</div>
            <div className="value">{summary.districts?.length ?? 0}</div>
          </div>
          <div className="metric">
            <div className="label">Columns seen</div>
            <div className="value">{summary.columns?.length ?? 0}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
          <div>
            <label className="fld">Section</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {typeChoices.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">District</label>
            <select value={district} onChange={(e) => setDistrict(e.target.value)}>
              <option value="">All districts</option>
              {districtChoices.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {statusChoices.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div style={{ flex: 2 }}>
            <label className="fld">Search</label>
            <input type="text" placeholder="name, file, district, any cell…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Count line + columns picker */}
      <div className="between" style={{ margin: "8px 0", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div className="muted small" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>
            {loading ? "Loading…" : `${filtered.length} of ${data?.rows?.length || 0} rows`}
            {hiddenCols.size > 0 ? ` · ${hiddenCols.size} columns hidden` : ""}
          </span>
          <span className="btn-row">
            <button className={"pill" + (sortBy === "recent" ? " active" : "")} onClick={() => setSortBy("recent")}>Newest first</button>
            <button className={"pill" + (sortBy === "name" ? " active" : "")} onClick={() => setSortBy("name")}>By last name</button>
          </span>
        </div>
        <div style={{ position: "relative" }}>
          <button className="btn ghost sm" onClick={() => setShowColsPicker((v) => !v)} title="Show or hide columns">
            Columns {hiddenCols.size > 0 ? `(${visibleHeaders.length}/${allHeaders.length})` : ""}
          </button>
          {showColsPicker && (
            <div className="card" style={{
              position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 10,
              minWidth: 240, maxHeight: 420, overflow: "auto", padding: 10,
              boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
            }} onClick={(e) => e.stopPropagation()}>
              <div className="between" style={{ marginBottom: 6 }}>
                <b className="small">Columns to show</b>
                <div className="btn-row" style={{ gap: 4 }}>
                  <button className="btn ghost sm" onClick={() => setHiddenCols(new Set())}>Show all</button>
                  <button className="btn ghost sm" onClick={() => setHiddenCols(new Set(allHeaders.filter((h) => !provenance.includes(h))))}>Provenance only</button>
                </div>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                {allHeaders.map((h) => (
                  <label key={h} className="small" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={!hiddenCols.has(h)}
                      onChange={(e) => {
                        const next = new Set(hiddenCols);
                        if (e.target.checked) next.delete(h); else next.add(h);
                        setHiddenCols(next);
                      }}
                    />
                    {h.startsWith("_") ? <i>{headerLabel(h)}</i> : headerLabel(h)}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card" style={{ padding: 0, overflow: "auto" }}>
        <table className="tbl">
          <thead>
            <tr>
              {visibleHeaders.map((h, i) => (
                <th key={h} style={i === 0 ? stickyCellStyle : undefined}>{headerLabel(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsShown.map((r, i) => (
              <tr key={r.id}>
                {visibleHeaders.map((h, j) => (
                  <td key={h} style={j === 0 ? stickyCellStyle : undefined}>{cellValue(r, h)}</td>
                ))}
              </tr>
            ))}
            {!rowsShown.length && !loading && (
              <tr><td className="muted" colSpan={Math.max(1, visibleHeaders.length)} style={{ padding: 16 }}>No rows match the filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}
