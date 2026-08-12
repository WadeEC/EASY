"use client";
import { useEffect, useState } from "react";
import * as XLSX from "xlsx";
import { api } from "@/lib/api.js";
import { guessHeader, prepareImport, mappedCount, normHeader, PREDICTED_FIELDS } from "@/lib/import-helpers.js";

// Reusable "import a roster" tool for the Players section. Used on Home (and anywhere).
export default function ImportPlayers({ onDone, go }) {
  const [fields, setFields] = useState(undefined); // undefined=loading, null=no Players section
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [mapping, setMapping] = useState({});
  const [source, setSource] = useState("");
  const [filename, setFilename] = useState("");
  const [detection, setDetection] = useState(null);
  const [flash, setFlash] = useState(null);
  const [season, setSeason] = useState("");        // which season this upload is for
  const [seasonOpts, setSeasonOpts] = useState([]);

  async function load() {
    const full = await api.schema();
    if (!full.schema?.player) { setFields(null); return; }
    const s = await api.schema("player");
    setFields(s.fields || []);
    try {
      const sl = await api.seasonsList();
      setSeasonOpts(sl.seasons || []);
      if (sl.active) setSeason(sl.active); // default new uploads to the current season
    } catch {}
  }
  useEffect(() => { load(); }, []);

  if (fields === undefined || fields?.error) return <div className="muted">Loading…</div>;
  if (fields === null) {
    return (
      <div>
        <p className="muted">There's no Players section yet.</p>
        <button className="btn primary" onClick={async () => { await api.seed(); await load(); onDone && onDone(); }}>Set up Players</button>
      </div>
    );
  }

  const twp = fields.find((f) => f.name === "township" && f.data_type === "select");
  let twpOpts = [];
  try { twpOpts = twp && twp.options ? JSON.parse(twp.options) : []; } catch {}

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // Banner-aware parse: skips title rows above the real header.
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      const prep = prepareImport({ aoa, fields });
      let { rows: r, cols, mapping: m } = prep;
      setRows(r); setColumns(cols); setMapping(m); setFilename(file.name); setDetection(null);

      // District detection — same as Players page. Auto-commits to the township
      // picker on confident hits; league still flows through Assignment rules.
      try {
        const det = await api.importDetect({ rows: r.slice(0, 500), filename: file.name });
        setDetection(det);
        if (det && det.district && det.confidence >= 0.7) setSource(det.district);
      } catch {}

      // AI fallback when alias guesser barely matches anything.
      if (mappedCount(m) < 2) {
        try {
          const ai = await api.importAskAi({
            rows: r.slice(0, 8),
            filename: file.name,
            columns: cols,
            knownDistricts: twpOpts,
            fields: fields.map((f) => ({ name: f.name, label: f.label || f.name, type: f.data_type })),
          });
          if (ai && ai.headerMap && typeof ai.headerMap === "object") {
            const merged = { ...m };
            for (const [k, v] of Object.entries(ai.headerMap)) {
              if (!v || v === "(skip)") continue;
              // league + township come from website prediction, never from a CSV column.
              if (PREDICTED_FIELDS.has(k)) continue;
              if (cols.includes(v)) merged[k] = v;
              else {
                const hit = cols.find((c) => normHeader(c) === normHeader(v));
                if (hit) merged[k] = hit;
              }
            }
            setMapping(merged);
            setFlash({ ok: true, text: `Headers were unusual — S-Dot filled in the mapping. Review below.` });
          }
        } catch {}
      }
    } catch (err) {
      setFlash({ ok: false, text: "Couldn't read that file: " + (err.message || err) });
    }
  }

  async function doImport() {
    const res = await api.importRows({ type: "player", rows, mapping, source: source || null, season: season || null, sourceFile: filename });
    const bits = [`Imported ${res.added}.`];
    if (res.recognized || res.duplicates) bits.push(`${res.recognized || res.duplicates} already in system.`);
    if (res.ambiguous?.length) bits.push(`${res.ambiguous.length} need review on the Players page.`);
    if (res.skipped?.length) bits.push(`${res.skipped.length} had problems.`);
    setFlash({ ok: true, text: bits.join(" ") });
    setRows([]); setColumns([]); setDetection(null); onDone && onDone();
  }

  return (
    <div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      <p className="muted">Upload a township's roster — <b>CSV or Excel</b> (.csv, .xlsx, .xls).</p>
      <input type="file" accept=".csv,.xlsx,.xls" onChange={onFile} />
      {detection && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {detection.district
            ? <>Detected district: <b>{detection.district}</b> (confidence {Math.round((detection.confidence || 0) * 100)}%)</>
            : "Couldn't auto-detect a district — pick below."}
        </div>
      )}
      {columns.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {twp && (
            <div>
              <label className="fld">Which township is this file from?</label>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">(use the file's own column)</option>
                {twpOpts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          )}
          {seasonOpts.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <label className="fld">Which season is this upload for?</label>
              <select value={season} onChange={(e) => setSeason(e.target.value)}>
                <option value="">(no season)</option>
                {seasonOpts.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <div className="muted small" style={{ marginTop: 4 }}>
                Every imported player is tagged with this season. A returning player from a
                previous season imports as a new registration, not a duplicate. Manage seasons
                on Leagues &amp; Assignment → Seasons.
              </div>
            </div>
          )}
          <div className="muted small" style={{ margin: "12px 0 4px" }}>Found {rows.length} rows. Match each detail to a column:</div>
          <div className="grid cols-2">
            {fields.map((f) => (
              <div key={f.name}>
                <label className="fld">{f.label || f.name}</label>
                <select value={mapping[f.name] || "(skip)"} onChange={(e) => setMapping({ ...mapping, [f.name]: e.target.value })}>
                  <option value="(skip)">(skip)</option>
                  {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn primary" onClick={doImport}>Import {rows.length} players</button>
          </div>
        </div>
      )}
    </div>
  );
}
