"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { recordName } from "@/lib/ui.js";

const safe = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const fmt = (v) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "✓" : "") : String(v));

function groupByDivision(list) {
  const by = {};
  for (const p of list) { const dv = (p.data.division || "").trim() || "No division"; (by[dv] = by[dv] || []).push(p); }
  return Object.entries(by).sort((a, b) =>
    a[0] === "No division" ? 1 : b[0] === "No division" ? -1 : a[0].localeCompare(b[0]));
}

export default function LeaguesView({ go }) {
  const [fields, setFields] = useState(undefined); // undefined=loading, null=no player section
  const [players, setPlayers] = useState([]);
  const [leagues, setLeagues] = useState([]);
  const [sel, setSel] = useState(null);

  async function load() {
    const full = await api.schema();
    if (!full.schema?.player) { setFields(null); return; }
    const s = await api.schema("player");
    const fs = s.fields || [];
    setFields(fs);
    const lf = fs.find((f) => f.name === "league");
    let opts = [];
    try { opts = lf && lf.options ? JSON.parse(lf.options) : []; } catch {}
    setLeagues(opts);
    const r = await api.records("player");
    setPlayers((r.records || []).map((x) => ({ id: x.id, name: x.name, data: safe(x.data) })));
  }
  useEffect(() => { load(); }, []);

  if (fields === undefined || fields?.error) return <div className="muted">Loading…</div>;
  if (fields === null) {
    return (
      <div>
        <div className="page-head"><h1>Leagues</h1></div>
        <div className="card">
          <p className="muted">There’s no Players section yet. Set one up first, then players will show up here by league.</p>
          <button className="btn" onClick={() => go({ page: "leagues" })}>Go to Leagues &amp; Assignment</button>
        </div>
      </div>
    );
  }

  // group players by league
  const groups = {};
  for (const lg of leagues) groups[lg] = [];
  groups["Unassigned"] = [];
  for (const p of players) {
    const lg = p.data.league && leagues.includes(p.data.league) ? p.data.league : (p.data.league || "Unassigned");
    (groups[lg] = groups[lg] || []).push(p);
  }
  const toggle = [...leagues];
  if ((groups["Unassigned"] || []).length) toggle.push("Unassigned");

  const active = sel && groups[sel] ? sel : toggle[0];
  const cols = fields.filter((f) => f.name !== "league" && f.name !== "division");
  const list = active ? (groups[active] || []) : [];

  return (
    <div>
      <div className="page-head">
        <h1>Leagues</h1>
        <div className="muted">{players.length} players across {leagues.length} league{leagues.length !== 1 ? "s" : ""}.</div>
      </div>

      {toggle.length === 0 ? (
        <div className="card"><p className="muted">No players yet. Add or import some in the Players section, and they’ll appear here once routed to a league.</p></div>
      ) : (
        <>
          <div className="btn-row" style={{ marginBottom: 16 }}>
            {toggle.map((lg) => (
              <button key={lg} className={"btn" + (lg === active ? " primary" : "")} onClick={() => setSel(lg)}>
                {lg} <span style={{ opacity: 0.7 }}>({(groups[lg] || []).length})</span>
              </button>
            ))}
          </div>

          {!list.length && <div className="card"><p className="muted">No players in {active} yet.</p></div>}
          {groupByDivision(list).map(([dv, members]) => (
            <div className="card" key={dv} style={{ padding: 0, overflow: "auto", marginBottom: 12 }}>
              <div style={{ padding: "10px 14px", fontWeight: 700, borderBottom: "1px solid var(--line)" }}>
                {dv} <span className="muted small">· {members.length}</span>
              </div>
              <table className="tbl">
                <thead><tr><th>Player</th>{cols.map((f) => <th key={f.name}>{f.label || f.name}</th>)}</tr></thead>
                <tbody>
                  {members.map((p) => (
                    <tr key={p.id}>
                      <td><b>{recordName({ name: p.name, data: JSON.stringify(p.data), id: p.id })}</b></td>
                      {cols.map((f) => <td key={f.name}>{fmt(p.data[f.name])}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
