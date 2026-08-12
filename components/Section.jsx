"use client";
import { useEffect, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { api } from "@/lib/api.js";
import { plural, recordName } from "@/lib/ui.js";
import { HEADER_ALIASES, normHeader, guessHeader, prepareImport, mappedCount, PREDICTED_FIELDS } from "@/lib/import-helpers.js";
import FieldInput from "./FieldInput.jsx";
import ConfirmDeleteModal from "./ConfirmDeleteModal.jsx";
import AiPromptBar from "./AiPromptBar.jsx";

export default function Section({ type, label, refresh, onAsk }) {
  const L = label || type;
  const [fields, setFields] = useState([]);
  const [records, setRecords] = useState([]);
  const [playerNames, setPlayerNames] = useState([]);
  const [tab, setTab] = useState("list");
  const [flash, setFlash] = useState(null);
  const [reassigning, setReassigning] = useState(false);

  // Re-evaluate assignment rules across every record of this section. Same
  // endpoint the Leagues & Assignment page uses; surfaced here too so users
  // don't have to leave the Players list to fix everyone's league after a rule
  // change or a bulk edit.
  async function doReassign() {
    if (reassigning) return;
    setReassigning(true);
    setFlash(null);
    try {
      const res = await api.reassignAll(type);
      if (res && res.error) { setFlash({ ok: false, text: res.error }); return; }
      const { updated = 0, scanned = 0, fields: byField = {} } = res || {};
      const keys = Object.keys(byField);
      const bits = updated
        ? [`Updated ${updated} of ${scanned} ${plural(L).toLowerCase()}.`].concat(keys.length ? [`Fields: ${keys.map((k) => `${k} ×${byField[k]}`).join(", ")}.`] : [])
        : [`No changes — all ${scanned} ${plural(L).toLowerCase()} already match the rules.`];
      setFlash({ ok: true, text: bits.join(" ") });
      await reload();
      refresh && refresh();
    } finally {
      setReassigning(false);
    }
  }

  async function reload() {
    if (type === "player") { try { await api.ensurePlayerFields(); } catch {} } // make sure key tag + notes exist
    const s = await api.schema(type);
    setFields(s.fields || []);
    const r = await api.records(type);
    setRecords(r.records || []);
    // player names power the type-ahead on player-reference fields (e.g. a coach's child)
    try {
      const pr = await api.records("player");
      setPlayerNames((pr.records || []).map((x) => { try { return x.name || JSON.parse(x.data || "{}").full_name || ""; } catch { return x.name || ""; } }).filter(Boolean));
    } catch { setPlayerNames([]); }
  }
  useEffect(() => { setTab("list"); setFlash(null); reload(); /* eslint-disable-next-line */ }, [type]);

  const ctx = { type, fields, L, reload, refresh, setFlash, playerNames };

  // Show Reassign for sections whose schema has a `league` field — that's where
  // assignment rules apply (today: player). Avoids a useless button on Coaches /
  // Referees if those sections never grow league rules.
  const hasLeagueField = fields.some((f) => f.name === "league");

  return (
    <div>
      <div className="page-head" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>{plural(L)}</h1>
          <div className="muted">{records.length} total</div>
        </div>
        {hasLeagueField && records.length > 0 && (
          <button
            className="btn"
            disabled={reassigning}
            title="Re-run all assignment rules against every record in this section. Use after editing rules or a player's data."
            onClick={doReassign}
          >
            {reassigning ? "Reassigning…" : "Reassign all"}
          </button>
        )}
      </div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
      {onAsk && <AiBox type={type} L={L} hasFields={fields.length > 0} onAsk={onAsk} />}
      {!fields.length ? (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>“{L}” has no details yet.</p>
          {(type === "player" || type === "coach") && (
            <div className="btn-row" style={{ marginBottom: 8 }}>
              <button className="btn primary" onClick={async () => {
                setFlash({ ok: true, text: `Setting up ${plural(L)}…` });
                try {
                  const res = type === "player" ? await api.seed() : await api.coachSetup();
                  if (res && res.error) { setFlash({ ok: false, text: `Set up failed: ${res.error}. Try restarting the dev server.` }); return; }
                } catch (e) {
                  setFlash({ ok: false, text: `Set up errored: ${e?.message || String(e)}. Try restarting the dev server.` });
                  return;
                }
                await reload();
                // Re-fetch the schema explicitly and verify fields landed; if not, surface the issue.
                const s2 = await api.schema(type);
                const got = (s2 && s2.fields) ? s2.fields.length : 0;
                if (got === 0) {
                  setFlash({ ok: false, text: `Set up ran but no fields appeared. Restart \`npm run dev\` and click again — the SQLite connection may be stale.` });
                  return;
                }
                refresh && refresh();
                setFlash({ ok: true, text: `Set up standard ${plural(L)} — ${got} fields ready. Now add details, import a sheet, or add one.` });
              }}>Set up standard {plural(L)}</button>
            </div>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>Or use the box above to describe the first detail — e.g. “add name, age and jersey size” — or set them up in <b>Build &amp; Ask</b>.</p>
        </div>
      ) : (
        <>
          <div className="tabs">
            <button className={"tab" + (tab === "list" ? " active" : "")} onClick={() => setTab("list")}>List</button>
            <button className={"tab" + (tab === "add" ? " active" : "")} onClick={() => setTab("add")}>Add one</button>
            <button className={"tab" + (tab === "import" ? " active" : "")} onClick={() => setTab("import")}>Import CSV / Excel</button>
          </div>
          {tab === "list" && <ListTab {...ctx} records={records} />}
          {tab === "add" && <AddTab {...ctx} />}
          {tab === "import" && <ImportTab {...ctx} />}
        </>
      )}
    </div>
  );
}

// Fields we hide by default in the list view — rarely useful at a glance, but the
// Columns picker lets users turn them back on. Low-noise default = "more visible".
const DEFAULT_HIDDEN_BY_TYPE = {
  player: new Set([
    "second_league",
    "link_group", "link_reason",
    "size_confirmed_at", "size_confirmed_by",
  ]),
};

// Fields that are NEVER shown as columns in the list view (or in the Columns
// picker). They're audit/internal data that's still on the record (visible in
// the full Edit modal), but they don't belong as their own column. Press
// override metadata is stamped automatically when an admin acts on the Press
// cleared checkbox; surfacing it as 3 extra columns just clutters the table.
const INTERNAL_FIELDS_BY_TYPE = {
  player: new Set([
    "press_override_reason", "press_override_by", "press_override_at",
  ]),
};

function ListTab({ type, fields, L, records, reload, refresh, setFlash, playerNames }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState("");
  const [vals, setVals] = useState({});
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmDelOpen, setConfirmDelOpen] = useState(false);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [activeLg, setActiveLg] = useState(null);
  const [moveTarget, setMoveTarget] = useState(null); // {id, name, league, second_league, division}
  const [moveCtx, setMoveCtx] = useState({ leagues: [], divisions: [], locks: [] });
  const [moveError, setMoveError] = useState("");
  const [moreBelow, setMoreBelow] = useState(false);
  const endRef = useRef(null);

  // Column visibility — persisted per record-type. Defaults hide low-signal fields
  // so the table doesn't sprawl off-screen, but the picker reveals everything.
  const colsKey = `section.${type}.hiddenCols`;
  const [hiddenCols, setHiddenCols] = useState(() => {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(colsKey) : null;
      if (raw) return new Set(JSON.parse(raw));
    } catch {}
    return new Set(DEFAULT_HIDDEN_BY_TYPE[type] || []);
  });
  const [showColsPicker, setShowColsPicker] = useState(false);
  useEffect(() => {
    try { if (typeof localStorage !== "undefined") localStorage.setItem(colsKey, JSON.stringify([...hiddenCols])); } catch {}
  }, [colsKey, hiddenCols]);

  // Inline cell editing — { recordId, field } when active. Click any non-name cell
  // to swap in an input; Enter/blur saves, Escape cancels. The row "Edit" button
  // still opens the full modal.
  const [inlineEdit, setInlineEdit] = useState(null); // { id, name, value }
  const inlineRef = useRef(null);

  // AI filter — user types "under 13 in upper merion", we get back a predicate.
  const [aiQuery, setAiQuery] = useState("");
  const [aiPredicate, setAiPredicate] = useState(null); // { all: [{field, op, value}] }
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");

  // Quick all-stars-only filter. Visible only when the section has an all_star field.
  const [starsOnly, setStarsOnly] = useState(false);

  // Press status for every player, keyed by id. Populated for player sections so
  // the synthetic "Press cleared" checkbox can render auto-derivation, override
  // reason, and the per-player requirements checklist without re-deriving.
  const [pressStatus, setPressStatus] = useState({});
  useEffect(() => {
    if (type !== "player") { setPressStatus({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const q = await api.pressList(null);
        const map = {};
        for (const bucket of ["cleared", "waiting", "hold"]) {
          for (const p of q[bucket] || []) map[p.id] = p;
        }
        if (!cancelled) setPressStatus(map);
      } catch { /* leave map empty */ }
    })();
    return () => { cancelled = true; };
  }, [type, records]);

  // Modal state for the press-clearance editor (separate from inlineEdit because
  // it handles the cell click directly with its own confirmation flow).
  const [pressEdit, setPressEdit] = useState(null); // { id, name, status }

  useEffect(() => {
    const node = endRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setMoreBelow(!entry.isIntersecting), { threshold: 0.05 });
    io.observe(node);
    return () => io.disconnect();
  }, [records, q, activeLg]);

  function scrollMoreIntoView() {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  const dataOf = (r) => { try { return JSON.parse(r.data || "{}"); } catch { return {}; } };

  // Same comparison logic as the assignment rule engine — kept inline so we don't
  // have to round-trip to the server for every filter run.
  function _matches(predicate, data) {
    if (!predicate || !Array.isArray(predicate.all) || !predicate.all.length) return true;
    for (const c of predicate.all) {
      if (!c || !c.field) return false;
      const a = data[c.field];
      const b = c.value;
      if (a == null || a === "") return false;
      if ([">", ">=", "<", "<="].includes(c.op)) {
        const x = parseFloat(a), y = parseFloat(b);
        if (Number.isNaN(x) || Number.isNaN(y)) return false;
        if (!(c.op === ">" ? x > y : c.op === ">=" ? x >= y : c.op === "<" ? x < y : x <= y)) return false;
      } else {
        const sa = String(a).trim().toLowerCase(), sb = String(b).trim().toLowerCase();
        if ((c.op || "==") === "!=") { if (sa === sb) return false; }
        else if (sa !== sb) return false;
      }
    }
    return true;
  }

  const shown = records.filter((r) => {
    if (q && !((r.name || "") + " " + (r.data || "")).toLowerCase().includes(q.toLowerCase())) return false;
    if (aiPredicate && !_matches(aiPredicate, dataOf(r))) return false;
    if (starsOnly && !dataOf(r).all_star) return false;
    return true;
  });

  // Total all-stars across all records of this section (for the chip count).
  const hasAllStarField = fields.some((f) => f.name === "all_star");
  const allStarCount = hasAllStarField ? records.filter((r) => dataOf(r).all_star).length : 0;

  async function runAiFilter() {
    const t = aiQuery.trim();
    if (!t) { setAiPredicate(null); setAiError(""); return; }
    setAiBusy(true); setAiError("");
    try {
      const res = await api.aiFilter({ record_type: type, query: t });
      if (res.error) { setAiError(res.error); return; }
      if (!res.predicate || !Array.isArray(res.predicate.all) || !res.predicate.all.length) {
        setAiError("Couldn't turn that into a filter. Try mentioning specific fields, e.g. \"age < 13\" or \"township is Upper Merion\".");
        return;
      }
      setAiPredicate(res.predicate);
    } finally { setAiBusy(false); }
  }
  function clearAiFilter() { setAiQuery(""); setAiPredicate(null); setAiError(""); }

  async function saveInline() {
    if (!inlineEdit) return;
    const { id, name, value } = inlineEdit;
    const rec = records.find((r) => r.id === id);
    if (!rec) { setInlineEdit(null); return; }
    const current = dataOf(rec)[name];
    setInlineEdit(null);
    if ((current == null ? "" : current) === (value == null ? "" : value)) return;
    const res = await api.updateRecord(id, { [name]: value });
    if (res && res.error) { setFlash({ ok: false, text: res.error }); return; }
    await reload(); refresh && refresh();
  }

  function pick(id) {
    setSel(id); setConfirmDel(false);
    const rec = records.find((r) => String(r.id) === String(id));
    setVals(rec ? dataOf(rec) : {});
  }
  async function save() {
    await api.updateRecord(Number(sel), vals);
    setFlash({ ok: true, text: "Updated." }); setSel(""); await reload(); refresh && refresh();
  }
  async function del() {
    setDeletingBusy(true);
    try {
      const res = await api.deleteRecord(Number(sel));
      if (res && res.error) { setFlash({ ok: false, text: res.error }); return; }
      setFlash({ ok: true, text: "Removed." });
      setConfirmDelOpen(false);
      setSel("");
      await reload(); refresh && refresh();
    } finally { setDeletingBusy(false); }
  }

  // When this section has a "league" field, split the list by league (and by division when present) — like the old Rosters view.
  const leagueField = fields.find((f) => f.name === "league");
  const hasDivision = fields.some((f) => f.name === "division");
  let leagueOpts = [];
  if (leagueField && leagueField.options) { try { leagueOpts = JSON.parse(leagueField.options); } catch {} }
  const internal = INTERNAL_FIELDS_BY_TYPE[type] || new Set();
  const cols = fields.filter((f) => f.name !== "league" && !(hasDivision && f.name === "division") && !internal.has(f.name));

  const groups = {};
  for (const lg of leagueOpts) groups[lg] = [];
  groups["Unassigned"] = [];
  for (const r of shown) {
    const d = dataOf(r);
    const ls = [d.league, d.second_league].filter(Boolean);
    if (!ls.length) ls.push("Unassigned");
    for (const lg of ls) {
      const key = leagueOpts.includes(lg) ? lg : (lg === "Unassigned" ? "Unassigned" : lg);
      (groups[key] = groups[key] || []).push(r);
    }
  }
  const toggle = [...leagueOpts];
  for (const k of Object.keys(groups)) if (k !== "Unassigned" && !toggle.includes(k) && groups[k].length) toggle.push(k);
  if ((groups["Unassigned"] || []).length) toggle.push("Unassigned");
  const active = activeLg && groups[activeLg] ? activeLg : (toggle.find((lg) => (groups[lg] || []).length) || toggle[0]);
  const list = active ? (groups[active] || []) : [];

  const byDivision = (arr) => {
    const by = {};
    for (const r of arr) { const dv = String(dataOf(r).division || "").trim() || "No division"; (by[dv] = by[dv] || []).push(r); }
    return Object.entries(by).sort((a, b) => (a[0] === "No division" ? 1 : b[0] === "No division" ? -1 : a[0].localeCompare(b[0])));
  };
  async function openMove(r) {
    const d = dataOf(r);
    if (!moveCtx.leagues.length) {
      const ctx = await api.rosterContext();
      setMoveCtx(ctx);
    }
    setMoveError("");
    setMoveTarget({
      id: r.id,
      name: r.name || d.full_name || `#${r.id}`,
      league: d.league || "",
      second_league: d.second_league || "",
      division: d.division || "",
    });
  }
  async function saveMove() {
    setMoveError("");
    const res = await api.rosterMove(moveTarget.id, {
      league: moveTarget.league,
      second_league: moveTarget.second_league,
      division: moveTarget.division,
    });
    if (res.error) { setMoveError(res.error); return; }
    setMoveTarget(null);
    setFlash({ ok: true, text: "Player moved." });
    await reload(); refresh && refresh();
  }

  // Apply column visibility AFTER the structural exclusion of league/division. The
  // first column is rendered sticky-left so the player name stays visible while
  // the user scrolls horizontally through the remaining fields.
  const visibleCols = cols.filter((f) => !hiddenCols.has(f.name));
  const stickyCellStyle = { position: "sticky", left: 0, background: "var(--card, #fff)", zIndex: 2, boxShadow: "2px 0 0 var(--line-soft, #eee)" };

  function renderCell(rec, f, isSticky) {
    const d = dataOf(rec);
    const tdStyle = isSticky ? stickyCellStyle : undefined;
    // Sticky first column (typically Full Name) gets the All-Star chip so it's
    // visible without scrolling to the all_star column itself.
    const isFirstCol = isSticky;
    const showStar = isFirstCol && hasAllStarField && d.all_star;

    // Press-cleared synthetic cell — a single checkbox derived from pressStatus
    // (auto-rule + override). Clicking opens the requirements modal which asks
    // for an override confirmation when the click would conflict with the auto-
    // rule. The underlying press_override field stores "clear"/"hold"/""; we
    // never edit it as a free-text cell.
    if (f.name === "press_override" && type === "player") {
      const st = pressStatus[rec.id];
      const cleared = !!st?.cleared;
      const source = st?.source || "auto";
      const overrideKind = (d.press_override || "").toLowerCase();
      let icon, color, title;
      if (cleared && overrideKind === "clear") { icon = "✓"; color = "#a36800"; title = "Force-cleared (override)"; }
      else if (cleared) { icon = "✓"; color = "#0a7c3a"; title = "Auto-cleared — meets both requirements"; }
      else if (overrideKind === "hold") { icon = "✕"; color = "#b71d3a"; title = "Held by admin"; }
      else { icon = "☐"; color = "var(--muted, #888)"; title = st?.reason || "Waiting on requirements"; }
      return (
        <td key={f.name} style={tdStyle} title={title}
          onClick={(e) => { e.stopPropagation(); setPressEdit({ id: rec.id, recordName: rec.name || d.full_name || `#${rec.id}`, status: st || null, overrideKind, overrideReason: d.press_override_reason || "" }); }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color, fontWeight: 700 }}>
            <span style={{ fontSize: 16, lineHeight: 1 }}>{icon}</span>
            <span className="small">
              {cleared ? (source === "override" ? "Forced" : "Cleared") : (overrideKind === "hold" ? "Held" : "Waiting")}
            </span>
          </span>
        </td>
      );
    }

    // Cell display — pretty-print certain fields for readability.
    let display = fmt(d[f.name]);
    if (f.name === "end_season_rank" && d[f.name]) {
      const n = Math.max(0, Math.min(5, Number(d[f.name]) || 0));
      display = "★".repeat(n) + "☆".repeat(5 - n);
    }
    return (
      <td key={f.name} style={tdStyle}
        title="Click to edit"
        onClick={(e) => { e.stopPropagation(); setInlineEdit({ id: rec.id, name: f.name, value: d[f.name] ?? "", recordName: rec.name }); }}>
        {display}
        {showStar && (
          <span
            className="chip"
            title="All-Star"
            style={{
              marginLeft: 8, verticalAlign: "middle",
              background: "rgba(220,150,30,.14)", color: "#a36800", fontWeight: 700,
              padding: "1px 8px", borderRadius: 999, fontSize: 11,
            }}
          >★ All-Star</span>
        )}
      </td>
    );
  }

  const tableFor = (rows) => (
    <table className="tbl">
      <thead><tr>{visibleCols.map((f, i) => <th key={f.name} style={i === 0 ? stickyCellStyle : undefined}>{f.label || f.name}</th>)}<th></th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ cursor: "default" }}>
            {visibleCols.map((f, i) => renderCell(r, f, i === 0))}
            <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              {leagueField && <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); openMove(r); }}>Move</button>}
              {" "}<button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); pick(r.id); }} title="Open full edit">Edit</button>
            </td>
          </tr>
        ))}
        {!rows.length && <tr><td colSpan={visibleCols.length + 1} className="muted" style={{ padding: 16 }}>Nothing to show.</td></tr>}
      </tbody>
    </table>
  );

  const hiddenCount = cols.length - visibleCols.length;

  return (
    <div>
      <input type="text" placeholder={`Search ${plural(L).toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} />

      {/* Natural-language filter. Examples surface in the placeholder so users know what to type. */}
      <div className="aibox" style={{ marginTop: 10, marginBottom: 10 }}>
        <div className="aibox-head"><span className="ai-badge">S-Dot</span> Filter with S-Dot</div>
        <div className="aibar">
          <input
            placeholder={`e.g. "under 13 in Upper Merion" or "no jersey size yet"`}
            value={aiQuery}
            onChange={(e) => setAiQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runAiFilter(); }}
          />
          <button className="btn primary" disabled={aiBusy} onClick={runAiFilter}>{aiBusy ? "Asking…" : "Filter"}</button>
          {(aiPredicate || aiQuery || aiError) && (
            <button className="btn" onClick={clearAiFilter}>Clear</button>
          )}
        </div>
        {aiError && <div className="muted small" style={{ marginTop: 6, color: "var(--warn, #b40)" }}>{aiError}</div>}
        {aiPredicate && (
          <div className="muted small" style={{ marginTop: 6 }}>
            Active filter: {aiPredicate.all.map((c) => `${c.field} ${c.op || "=="} ${c.value}`).join(" and ")}
          </div>
        )}
      </div>

      <div className="between" style={{ margin: "8px 0", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div className="small" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="muted">{shown.length} of {records.length}{hiddenCount > 0 ? ` · ${hiddenCount} column${hiddenCount === 1 ? "" : "s"} hidden` : ""}</span>
          {hasAllStarField && allStarCount > 0 && (
            <button
              type="button"
              onClick={() => setStarsOnly((v) => !v)}
              title={starsOnly ? "Showing only all-stars — click to clear" : "Show only all-stars"}
              className="chip"
              style={{
                cursor: "pointer",
                background: starsOnly ? "rgba(220,150,30,.28)" : "rgba(220,150,30,.14)",
                color: "#a36800", border: "none", fontWeight: 700,
                padding: "2px 10px", borderRadius: 999, fontSize: 12,
              }}
            >★ {allStarCount} all-star{allStarCount === 1 ? "" : "s"}{starsOnly ? " · filter on" : ""}</button>
          )}
        </div>
        <div style={{ position: "relative" }}>
          <button className="btn ghost sm" onClick={() => setShowColsPicker((v) => !v)} title="Show or hide columns">
            Columns {hiddenCount > 0 ? `(${visibleCols.length}/${cols.length})` : ""}
          </button>
          {showColsPicker && (
            <div className="card" style={{
              position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 10,
              minWidth: 220, maxHeight: 360, overflow: "auto", padding: 10,
              boxShadow: "0 6px 18px rgba(0,0,0,0.18)",
            }} onClick={(e) => e.stopPropagation()}>
              <div className="between" style={{ marginBottom: 6 }}>
                <b className="small">Columns to show</b>
                <button className="btn ghost sm" onClick={() => setHiddenCols(new Set())}>Show all</button>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                {cols.map((f) => (
                  <label key={f.name} className="small" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={!hiddenCols.has(f.name)}
                      onChange={(e) => {
                        const next = new Set(hiddenCols);
                        if (e.target.checked) next.delete(f.name); else next.add(f.name);
                        setHiddenCols(next);
                      }}
                    />
                    {f.label || f.name}
                  </label>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 8 }}>Choices saved in this browser.</div>
            </div>
          )}
        </div>
      </div>

      {leagueField ? (
        toggle.length === 0 ? (
          <div className="card"><p className="muted" style={{ margin: 0 }}>Nothing to show.</p></div>
        ) : (
          <>
            <div className="btn-row" style={{ marginBottom: 14 }}>
              {toggle.map((lg) => (
                <button key={lg} className={"btn" + (lg === active ? " primary" : "")} onClick={() => setActiveLg(lg)}>
                  {lg} <span style={{ opacity: 0.7 }}>({(groups[lg] || []).length})</span>
                </button>
              ))}
            </div>
            {!list.length && <div className="card"><p className="muted" style={{ margin: 0 }}>No {plural(L).toLowerCase()} in {active} yet.</p></div>}
            {hasDivision
              ? byDivision(list).map(([dv, members]) => (
                <div className="card" key={dv} style={{ padding: 0, overflow: "auto", marginBottom: 12 }}>
                  <div style={{ padding: "10px 14px", fontWeight: 700, borderBottom: "1px solid var(--line)" }}>{dv} <span className="muted small">· {members.length}</span></div>
                  {tableFor(members)}
                </div>
              ))
              : (list.length > 0 && <div className="card" style={{ padding: 0, overflow: "auto", marginBottom: 12 }}>{tableFor(list)}</div>)}
          </>
        )
      ) : (
        <div className="card" style={{ padding: 0, overflow: "auto" }}>
          {tableFor(shown)}
        </div>
      )}

      {inlineEdit && (() => {
        const f = fields.find((x) => x.name === inlineEdit.name);
        if (!f) return null;
        return (
          <CellEditModal
            field={f}
            recordName={inlineEdit.recordName || ""}
            value={inlineEdit.value}
            onChange={(v) => setInlineEdit({ ...inlineEdit, value: v })}
            onSave={saveInline}
            onCancel={() => setInlineEdit(null)}
          />
        );
      })()}

      {pressEdit && (
        <PressClearanceModal
          recordName={pressEdit.recordName}
          status={pressEdit.status}
          overrideKind={pressEdit.overrideKind}
          overrideReason={pressEdit.overrideReason}
          onCancel={() => setPressEdit(null)}
          onApply={async (ov, reason) => {
            const res = await api.pressSetOverride(pressEdit.id, ov, reason);
            if (res && res.error) { setFlash({ ok: false, text: res.error }); return; }
            setPressEdit(null);
            await reload(); refresh && refresh();
          }}
        />
      )}

      {sel !== "" && (() => {
        const rec = records.find((r) => String(r.id) === String(sel));
        return (
          <div className="overlay" onClick={() => setSel("")}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h2 style={{ marginBottom: 4 }}>Edit {rec ? recordName(rec) : L.toLowerCase()}</h2>
              <div className="muted small" style={{ marginBottom: 8 }}>Update the details below, or remove.</div>
              {fields.map((f) => <FieldInput key={f.name} field={f} value={vals[f.name]} onChange={(v) => setVals({ ...vals, [f.name]: v })} suggest={/child|player/i.test(f.name) ? playerNames : null} />)}
              <div className="btn-row" style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={save}>Save changes</button>
                <button className="btn" onClick={() => setSel("")}>Cancel</button>
                <button className="btn danger" style={{ marginLeft: "auto" }} onClick={() => setConfirmDelOpen(true)}>Delete…</button>
              </div>
            </div>
          </div>
        );
      })()}

      <ConfirmDeleteModal
        open={confirmDelOpen}
        title={`Delete ${L.toLowerCase()} — ${(() => { const rec = records.find((r) => String(r.id) === String(sel)); return rec ? recordName(rec) : ""; })()}`}
        targetName={(() => { const rec = records.find((r) => String(r.id) === String(sel)); return rec ? (rec.name || recordName(rec) || `#${rec.id}`) : ""; })()}
        itemSummary={(() => {
          const rec = records.find((r) => String(r.id) === String(sel));
          if (!rec) return "";
          const d = dataOf(rec);
          const bits = [];
          if (d.league) bits.push(d.league);
          if (d.team) bits.push(`Team ${d.team}`);
          if (d.parent_phone || d.phone) bits.push("contact info on file");
          return bits.length ? `${L} record — ${bits.join(" · ")}` : `${L} record #${rec.id}`;
        })()}
        consequences={[
          `Remove this ${L.toLowerCase()} record permanently.`,
          "Attendance, team assignment, scan tag, and press status tied to this record are dropped.",
          "Imports referencing this record won't auto-recreate them — re-upload the roster if you want them back.",
        ]}
        undoNote="A delete audit row is written to the Change log. Restore via Time Machine if needed."
        confirmLabel={`Delete ${L.toLowerCase()}`}
        busy={deletingBusy}
        onCancel={() => setConfirmDelOpen(false)}
        onConfirm={del}
      />

      {moveTarget && (
        <div className="overlay" onClick={() => setMoveTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 4 }}>Move {moveTarget.name}</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>Change which league(s) and division this player is in.</div>

            <label className="fld">Primary league</label>
            <select value={moveTarget.league}
              onChange={(e) => setMoveTarget({ ...moveTarget, league: e.target.value })}>
              <option value="">(none)</option>
              {moveCtx.leagues.map((lg) => {
                const locked = (moveCtx.locks || []).find((l) => l.league === lg && l.locked);
                return <option key={lg} value={lg}>{lg}{locked ? " 🔒" : ""}</option>;
              })}
            </select>

            <label className="fld">Also in (optional second league)</label>
            <select value={moveTarget.second_league}
              onChange={(e) => setMoveTarget({ ...moveTarget, second_league: e.target.value })}>
              <option value="">(none)</option>
              {moveCtx.leagues.filter((lg) => lg !== moveTarget.league).map((lg) => {
                const locked = (moveCtx.locks || []).find((l) => l.league === lg && l.locked);
                return <option key={lg} value={lg}>{lg}{locked ? " 🔒" : ""}</option>;
              })}
            </select>

            <label className="fld">Division</label>
            <select value={moveTarget.division}
              onChange={(e) => setMoveTarget({ ...moveTarget, division: e.target.value })}>
              <option value="">(none)</option>
              {(moveCtx.divisions || [])
                .filter((d) => !d.league || d.league === moveTarget.league || d.league === moveTarget.second_league)
                .map((d) => <option key={d.id} value={d.name}>{d.name}{d.league ? ` (${d.league})` : ""}</option>)}
            </select>

            {moveError && <div className="note warn" style={{ marginTop: 10 }}>{moveError}</div>}

            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={saveMove}>Save move</button>
              <button className="btn" onClick={() => setMoveTarget(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div ref={endRef} aria-hidden="true" style={{ height: 1 }} />

      {moreBelow && shown.length > 5 && (
        <button
          onClick={scrollMoreIntoView}
          aria-label="Scroll to more results"
          style={{
            position: "fixed", left: "50%", bottom: 20, transform: "translateX(-50%)",
            background: "var(--brand, #d22)", color: "#fff", border: "none",
            borderRadius: 999, padding: "8px 18px", fontWeight: 700, fontSize: 13,
            boxShadow: "0 6px 18px rgba(0,0,0,0.25)", cursor: "pointer", zIndex: 50,
            display: "flex", alignItems: "center", gap: 6,
          }}>
          <span style={{ fontSize: 16, lineHeight: 1 }}>↓</span>
          More results below
        </button>
      )}
    </div>
  );
}

function AddTab({ type, fields, L, reload, refresh, setFlash, playerNames }) {
  const [vals, setVals] = useState({});
  async function save() {
    const missing = fields.filter((f) => f.required && (vals[f.name] == null || vals[f.name] === "")).map((f) => f.label || f.name);
    if (missing.length) { setFlash({ ok: false, text: "Please fill: " + missing.join(", ") }); return; }
    const res = await api.createRecord(type, vals, vals.full_name || vals.name);
    if (res && res.error) { setFlash({ ok: false, text: res.error }); return; }
    setFlash({ ok: true, text: `Added.` }); setVals({}); await reload(); refresh && refresh();
  }
  return (
    <div className="card">
      {fields.map((f) => <FieldInput key={f.name} field={f} value={vals[f.name]} onChange={(v) => setVals({ ...vals, [f.name]: v })} suggest={/child|player/i.test(f.name) ? playerNames : null} />)}
      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn primary" onClick={save}>Add {L.toLowerCase()}</button>
      </div>
    </div>
  );
}

function ImportTab({ type, fields, L, reload, refresh, setFlash }) {
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [mapping, setMapping] = useState({});
  const [source, setSource] = useState("");
  const [filename, setFilename] = useState("");
  const [detection, setDetection] = useState(null);
  const [leagueOverride, setLeagueOverride] = useState("");
  const [overrideText, setOverrideText] = useState("");
  const [asking, setAsking] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [accepted, setAccepted] = useState(false);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [skipped, setSkipped] = useState([]);
  const [extraTwpOpts, setExtraTwpOpts] = useState([]);
  const [importSummary, setImportSummary] = useState(null); // { addedNames, recognizedNames, ambiguous, skipped }
  const [pendingRows, setPendingRows] = useState(null);    // snapshot of rows for ambiguous re-submit
  const [pendingMapping, setPendingMapping] = useState(null);
  const [pendingSource, setPendingSource] = useState(null);
  const [pendingFilename, setPendingFilename] = useState(null);
  const [resubmitBusy, setResubmitBusy] = useState({});    // rowIndex -> bool
  const [masterSum, setMasterSum] = useState(null);        // import_master summary for this record type

  useEffect(() => {
    let on = true;
    (async () => {
      try { const r = await api.masterSummary(type); if (on) setMasterSum(r); } catch {}
    })();
    return () => { on = false; };
    // Refresh when an import finishes (importSummary changes), or when the type changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, importSummary]);

  const twp = fields.find((f) => f.name === "township" && f.data_type === "select");
  let baseTwpOpts = [];
  try { baseTwpOpts = twp && twp.options ? JSON.parse(twp.options) : []; } catch {}
  const twpOpts = [...baseTwpOpts, ...extraTwpOpts.filter((o) => !baseTwpOpts.includes(o))];

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // Use AOA so banner rows (Activity:, Season:, Catalog: …) above the real headers get skipped.
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      const prep = prepareImport({ aoa, fields });
      let { rows: r, cols, mapping: m } = prep;
      setRows(r); setColumns(cols); setMapping(m);
      setFilename(file.name);
      setAiResult(null); setAccepted(false); setShowSourcePicker(false);
      setSkipped([]); setOverrideText("");

      // Auto-detect district from cells + filename. On a confident hit, we commit
      // the township up-front (every row in this file gets tagged with it). League
      // is intentionally *not* auto-set — Assignment rules drive that, keyed off
      // the now-populated township field (chain: detection → township → league).
      try {
        const det = await api.importDetect({ rows: r.slice(0, 500), filename: file.name });
        setDetection(det);
        if (det && det.district && det.confidence >= 0.7) setSource(det.district);
      } catch {
        setDetection(null);
      }

      // AI fallback when the basic guesser barely mapped anything.
      // (Threshold: fewer than 2 fields mapped — almost always means the headers are weird and
      // the user would otherwise have to map everything by hand.)
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
            setFlash({ ok: true, text: `Headers were unusual — S-Dot filled in the mapping. Review below before importing.` });
          }
        } catch {}
      }
    } catch (err) {
      setFlash({ ok: false, text: "Couldn't read that file: " + (err.message || err) });
    }
  }

  async function doImport() {
    const res = await api.importRows({ type, rows, mapping, source: source || null, sourceFile: filename });
    const summary = {
      added: res.added || 0,
      addedNames: res.addedNames || [],
      recognized: res.recognized ?? res.duplicates ?? 0,
      recognizedNames: res.recognizedNames || [],
      ambiguous: res.ambiguous || [],
      skipped: res.skipped || [],
      unmatched: res.unmatched || [],
    };
    setImportSummary(summary);
    // Keep the rows + mapping in case the user resolves ambiguous rows after the fact.
    if (summary.ambiguous.length) {
      setPendingRows(rows);
      setPendingMapping(mapping);
      setPendingSource(source || null);
      setPendingFilename(filename || null);
    } else {
      setPendingRows(null); setPendingMapping(null); setPendingSource(null); setPendingFilename(null);
    }
    setSkipped(summary.skipped);
    const bits = [`Imported ${summary.added}.`];
    if (summary.recognized) bits.push(`${summary.recognized} already in system.`);
    if (summary.ambiguous.length) bits.push(`${summary.ambiguous.length} need review.`);
    if (summary.skipped.length) bits.push(`${summary.skipped.length} had problems.`);
    setFlash({ ok: true, text: bits.join(" ") });
    // Don't clear rows/columns — user may need to act on ambiguous rows. Clear when summary acknowledged.
    if (!summary.ambiguous.length) { setRows([]); setColumns([]); setDetection(null); setAiResult(null); setAccepted(false); }
    await reload(); refresh && refresh();
  }

  async function addAnywayRow(rowIndex) {
    if (!pendingRows || !pendingMapping) return;
    setResubmitBusy((b) => ({ ...b, [rowIndex]: true }));
    const res = await api.importRows({
      type, rows: pendingRows, mapping: pendingMapping, source: pendingSource,
      sourceFile: pendingFilename,
      allowAmbiguous: [rowIndex],
    });
    setResubmitBusy((b) => ({ ...b, [rowIndex]: false }));
    // Merge result into the existing summary: drop the resolved ambiguous row, add what landed.
    setImportSummary((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      next.ambiguous = (prev.ambiguous || []).filter((a) => a.rowIndex !== rowIndex);
      next.added = (prev.added || 0) + (res.added || 0);
      next.addedNames = [...(prev.addedNames || []), ...((res.addedNames || []).filter((x) => x.rowIndex === rowIndex))];
      if (res.skipped?.length) next.skipped = [...(prev.skipped || []), ...res.skipped.filter((s) => s.startsWith(`Row ${rowIndex} `))];
      return next;
    });
    await reload(); refresh && refresh();
  }
  function skipAmbiguousRow(rowIndex) {
    setImportSummary((prev) => prev ? { ...prev, ambiguous: (prev.ambiguous || []).filter((a) => a.rowIndex !== rowIndex) } : prev);
  }
  function clearSummary() {
    setImportSummary(null); setPendingRows(null); setPendingMapping(null); setPendingSource(null); setPendingFilename(null);
    setRows([]); setColumns([]); setDetection(null); setAiResult(null); setAccepted(false);
  }

  async function onAskAi() {
    if (asking) return;
    setAsking(true);
    try {
      const r = await api.importAskAi({
        rows: rows.slice(0, 20),
        filename,
        columns,
        knownDistricts: twpOpts,
      });
      setAiResult(r);
      if (r && r.district && twpOpts.includes(r.district)) {
        setSource(r.district);
      } else if (r && r.newDistrictSuggestion) {
        setOverrideText(r.newDistrictSuggestion);
      }
      if (r && r.league) setLeagueOverride(r.league);
    } catch (e) {
      setAiResult({ error: String(e?.message || e) });
    } finally {
      setAsking(false);
    }
  }

  async function onSaveAsNewDistrict() {
    const name = overrideText.trim();
    if (!name) return;
    const res = await api.importMarkers({ district: name, createDistrict: true, newMarkers: [] });
    if (res && res.error) {
      setFlash({ ok: false, text: "Couldn't save district: " + res.error });
      return;
    }
    setExtraTwpOpts((prev) => prev.includes(name) ? prev : [...prev, name]);
    setSource(name);
    setOverrideText("");
    setFlash({ ok: true, text: `Saved "${name}" as a new district. Future files with similar markers will auto-tag.` });
  }

  const detKnown = detection && detection.district && twpOpts.includes(detection.district);
  const overrideIsNew = overrideText.trim() && !twpOpts.includes(overrideText.trim());

  return (
    <div className="card">
      <p className="muted small">Upload a township’s registration export — <b>CSV or Excel</b> (.csv, .xlsx, .xls).</p>
      <input type="file" accept=".csv,.xlsx,.xls" onChange={onFile} />
      {columns.length > 0 && detection && !accepted && (
        <div className="card" style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Detection</div>
          {detection.district ? (
            <>
              <div>
                Best guess: <b>{detection.district}</b>
                <span className="muted"> (confidence {Math.round((detection.confidence || 0) * 100)}%)</span>
                {!detKnown && <span className="muted"> — not in current options</span>}
              </div>
              {detection.evidence?.length > 0 && (
                <div className="muted small" style={{ marginTop: 4 }}>
                  Evidence: {detection.evidence.slice(0, 4).map((e, i) => (
                    <span key={i}>
                      {i > 0 ? ", " : ""}“{e.marker}” ×{e.hits}
                      {e.columns?.length ? ` in ${e.columns.slice(0, 2).map((c) => `"${c}"`).join(", ")}` : ""}
                    </span>
                  ))}
                </div>
              )}
              <div style={{ marginTop: 4 }}>
                Suggested league: <b>{detection.suggestedLeague || "—"}</b>
                {detection.suggestedLeagueAlternates?.length > 1 && (
                  <span className="muted small"> (alternates: {detection.suggestedLeagueAlternates.join(", ")})</span>
                )}
              </div>
            </>
          ) : (
            <div className="muted">No district markers matched this file.</div>
          )}

          {aiResult && (
            <div style={{ marginTop: 8, padding: 8, background: "rgba(0,0,0,0.04)", borderRadius: 4 }}>
              <div className="small"><b>S-Dot suggestion:</b> {aiResult.district || "(none)"}{aiResult.league ? ` — league ${aiResult.league}` : ""}</div>
              {aiResult.reason && <div className="muted small">{aiResult.reason}</div>}
              {aiResult.newDistrictSuggestion && (
                <div className="muted small">Suggested new district name: {aiResult.newDistrictSuggestion}</div>
              )}
              {aiResult.error && <div className="muted small">Error: {aiResult.error}</div>}
            </div>
          )}

          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={asking || !detection.district} onClick={() => { if (detKnown) setSource(detection.district); setAccepted(true); }}>
              Accept
            </button>
            <button className="btn" disabled={asking} onClick={() => setShowSourcePicker((v) => !v)}>
              Pick another
            </button>
            <button className="btn" disabled={asking} onClick={onAskAi}>
              {asking ? "Asking…" : "Ask S-Dot"}
            </button>
          </div>

          <div style={{ marginTop: 10 }}>
            <label className="fld">Or type a district name (e.g. “West Norriton”)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={overrideText}
                onChange={(e) => setOverrideText(e.target.value)}
                placeholder="District name"
                style={{ flex: 1 }}
              />
              <button
                className="btn"
                disabled={!overrideIsNew}
                onClick={onSaveAsNewDistrict}
              >
                Save as new district
              </button>
            </div>
          </div>
        </div>
      )}
      {columns.length > 0 && (
        <div style={{ marginTop: 14 }}>
          {twp && (accepted || showSourcePicker || !detection) && (
            <div>
              <label className="fld">Which township is this file from? <span className="muted">(tags every row)</span></label>
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">(use the file’s own column)</option>
                {twpOpts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          )}
          {twp && accepted && !showSourcePicker && source && (
            <div className="muted small">Tagging every row as <b>{source}</b>. <button className="btn" style={{ padding: "2px 8px" }} onClick={() => setShowSourcePicker(true)}>Change</button></div>
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
            <button className="btn primary" onClick={doImport}>Import {rows.length} {plural(L).toLowerCase()}</button>
          </div>
        </div>
      )}
      {importSummary && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="between" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Import summary</h3>
            <button className="btn ghost sm" onClick={clearSummary}>Done</button>
          </div>
          <div className="btn-row" style={{ flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            <span className="chip good">Newly added: {importSummary.added}</span>
            <span className="chip">Already in system: {importSummary.recognized}</span>
            {importSummary.ambiguous?.length > 0 && <span className="chip brand">Needs review: {importSummary.ambiguous.length}</span>}
            {importSummary.skipped?.length > 0 && <span className="chip">Problems: {importSummary.skipped.length}</span>}
          </div>

          {importSummary.ambiguous?.length > 0 && (
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 10, marginBottom: 12 }}>
              <h4 style={{ margin: "0 0 4px" }}>Ambiguous matches — review before merging</h4>
              <p className="muted small" style={{ marginTop: 0 }}>Same name + matching phone or close age as an existing record. Decide each — don't let the system silently merge.</p>
              <div className="stack" style={{ gap: 8 }}>
                {importSummary.ambiguous.map((a) => (
                  <div key={a.rowIndex} className="card" style={{ padding: 10, borderColor: "var(--brand)", background: "var(--brand-soft)" }}>
                    <div className="between" style={{ alignItems: "flex-start", gap: 10 }}>
                      <div style={{ flex: 1 }}>
                        <div><b>Row {a.rowIndex}:</b> {a.incoming.name}{a.incoming.age != null ? <span className="muted"> · age {a.incoming.age}</span> : null}{a.incoming.phone_last4 ? <span className="muted"> · phone ···{a.incoming.phone_last4}</span> : null}{a.incoming.township ? <span className="muted"> · {a.incoming.township}</span> : null}</div>
                        <div className="muted small" style={{ marginTop: 4 }}>Possibly matches:</div>
                        <ul className="small" style={{ margin: "4px 0 0 18px" }}>
                          {a.candidates.map((c) => (
                            <li key={c.id}>
                              <b>{c.name}</b> (#{c.id}){c.age != null ? <span className="muted"> · age {c.age}</span> : null}{c.phone_last4 ? <span className="muted"> · phone ···{c.phone_last4}</span> : null}
                              {" — "}
                              {c.phoneMatch && <span className="chip" style={{ marginLeft: 4 }}>phone matches</span>}
                              {c.ageMatch && <span className="chip" style={{ marginLeft: 4 }}>age within ±1</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="btn-row" style={{ gap: 6, flexShrink: 0 }}>
                        <button className="btn primary sm" disabled={!!resubmitBusy[a.rowIndex]} onClick={() => addAnywayRow(a.rowIndex)}>{resubmitBusy[a.rowIndex] ? "Adding…" : "Add as new"}</button>
                        <button className="btn ghost sm" onClick={() => skipAmbiguousRow(a.rowIndex)}>Skip (same person)</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {importSummary.addedNames?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted small">{importSummary.addedNames.length} newly added — click to see names</summary>
              <ul className="small" style={{ marginTop: 6 }}>
                {importSummary.addedNames.map((p, i) => <li key={i}>{p.name}{p.id ? <span className="muted"> · #{p.id}</span> : null}</li>)}
              </ul>
            </details>
          )}
          {importSummary.recognizedNames?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted small">{importSummary.recognizedNames.length} already in system — click to see names</summary>
              <ul className="small" style={{ marginTop: 6 }}>
                {importSummary.recognizedNames.map((p, i) => <li key={i}>{p.name}{p.id ? <span className="muted"> · #{p.id}</span> : null}</li>)}
              </ul>
            </details>
          )}
          {importSummary.skipped?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted small">{importSummary.skipped.length} row{importSummary.skipped.length === 1 ? "" : "s"} had problems — click to see why</summary>
              <ul className="small" style={{ marginTop: 6 }}>
                {importSummary.skipped.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </details>
          )}
          {importSummary.unmatched?.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="muted small">{importSummary.unmatched.length} value{importSummary.unmatched.length === 1 ? "" : "s"} couldn't be matched and were left blank — click to see</summary>
              <ul className="small" style={{ marginTop: 6 }}>
                {importSummary.unmatched.map((u, i) => (
                  <li key={i}>Row {u.rowIndex} ({u.name}): {u.field} = <b>"{u.value}"</b></li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {masterSum && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="between" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>Master spreadsheet</h3>
            <span className="chip">{masterSum.total} rows</span>
          </div>
          <p className="muted small" style={{ marginTop: 0 }}>Every row from every uploaded sheet, including columns the system doesn't have a field for. Header row = the union of every column ever seen.</p>
          <div className="muted small" style={{ marginBottom: 8 }}>
            <b>Columns ({masterSum.columns?.length || 0}):</b> {(masterSum.columns || []).slice(0, 12).join(", ")}{(masterSum.columns?.length || 0) > 12 ? `, +${masterSum.columns.length - 12} more` : ""}
          </div>
          {masterSum.districts?.length ? (
            <div className="muted small" style={{ marginBottom: 8 }}>
              <b>Districts:</b> {masterSum.districts.map((d) => `${d.source_district || "(none)"} ×${d.c}`).join(", ")}
            </div>
          ) : null}
          <div className="btn-row" style={{ flexWrap: "wrap" }}>
            <a className="btn primary" href={`/api/master?type=${encodeURIComponent(type)}&format=xlsx`} download>Download XLSX</a>
            <a className="btn" href={`/api/master?type=${encodeURIComponent(type)}&format=csv`} download>Download CSV</a>
            <a className="btn" href={`/api/master?type=${encodeURIComponent(type)}&format=json`} target="_blank" rel="noreferrer">View JSON</a>
          </div>
        </div>
      )}
    </div>
  );
}

function AiBox({ type, L, hasFields, onAsk }) {
  const [text, setText] = useState("");
  const one = (type || L || "record").toLowerCase();
  function sendText(t) {
    const v = (t || "").trim(); if (!v) return;
    onAsk(`In the ${type} section: ${v}`);
    setText("");
  }
  return (
    <div className="aibox">
      <div className="aibox-head"><span className="ai-badge">S-Dot</span> Edit {plural(L).toLowerCase()} with S-Dot</div>
      <AiPromptBar
        pageId={type === "player" ? "people" : "section"}
        value={text}
        onChange={setText}
        onSend={sendText}
        placeholder={hasFields ? `e.g. set Cora Shaw’s age to 9` : `Add the details a ${one} should have…`}
        hint={hasFields
          ? <>Pick a quick action below — or type something like <i>“add a jersey size choice of S, M, L”</i>. S-Dot drafts the change and you confirm.</>
          : <>Pick a quick action — or describe the details a {one} should have, e.g. <i>“add name, age and jersey size”</i>.</>}
      />
    </div>
  );
}

function fmt(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "✓" : "";
  return String(v);
}

// Field-aware single-cell edit modal. Picks the right control based on the
// field's data type and well-known field names so each kind of detail gets the
// editor people actually expect (segmented buttons for press override, a 5-star
// rank picker, a textarea for notes / reasons, a phone formatter, etc.).
function CellEditModal({ field, recordName, value, onChange, onSave, onCancel }) {
  // Auto-focus the first input inside the modal when it opens.
  const firstRef = useRef(null);
  useEffect(() => { firstRef.current?.focus?.(); }, []);

  const name = field.name;
  const label = field.label || name;

  // Save on Enter (for single-line inputs), cancel on Escape.
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    if (e.key === "Enter" && !e.shiftKey && !e.target.matches("textarea")) { e.preventDefault(); onSave(); }
  }

  // ---- Field-name special cases first (so they beat the generic data_type fallback) ----

  // Press override (clear / hold / none) — three-way segmented control with a
  // reason textarea that becomes required-feel when an override is on.
  if (name === "press_override") {
    const choice = (value || "").toLowerCase();
    const Pill = ({ k, body, danger }) => (
      <button type="button"
        onClick={() => onChange(k)}
        className={"btn" + (choice === k ? " primary" : "")}
        style={{ flex: 1, background: choice === k && danger ? "var(--danger)" : undefined, borderColor: choice === k && danger ? "var(--danger)" : undefined, color: choice === k && danger ? "#fff" : undefined }}
      >{body}</button>
    );
    return (
      <ModalShell title={`Press status — ${recordName || "this player"}`} subtitle="Override what the auto-rule would do." onKey={onKey} onCancel={onCancel} onSave={onSave}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <Pill k="" body={<><b>None</b><div className="muted small">Use the auto-rule</div></>} />
          <Pill k="clear" body={<><b>✓ Clear</b><div className="muted small">Force eligible</div></>} />
          <Pill k="hold" body={<><b>✕ Hold</b><div className="muted small">Force ineligible</div></>} danger />
        </div>
        <div className="muted small">Reason and the actor + timestamp are stored on the player.</div>
      </ModalShell>
    );
  }

  // End-of-season rank: a 1-5 star/button picker. 0 = unranked.
  if (name === "end_season_rank") {
    const n = Math.max(0, Math.min(5, Number(value) || 0));
    return (
      <ModalShell title={`Rank — ${recordName || "this player"}`} subtitle="1 = lowest, 5 = highest. Click again to clear." onKey={onKey} onCancel={onCancel} onSave={onSave}>
        <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "12px 0" }}>
          {[1, 2, 3, 4, 5].map((i) => {
            const active = i <= n;
            return (
              <button key={i} type="button"
                onClick={() => onChange(i === n ? "" : i)}
                title={`${i} star${i === 1 ? "" : "s"}`}
                style={{
                  width: 56, height: 56, borderRadius: 12,
                  border: "1px solid " + (active ? "var(--brand)" : "var(--line)"),
                  background: active ? "var(--brand-soft, rgba(220,150,30,.14))" : "#fff",
                  color: active ? "#a36800" : "var(--ink)",
                  fontSize: 26, cursor: "pointer", fontWeight: 700,
                }}
              >{active ? "★" : "☆"}</button>
            );
          })}
        </div>
        <div className="muted small" style={{ textAlign: "center" }}>{n === 0 ? "Unranked" : `Current rank: ${n} / 5`}</div>
      </ModalShell>
    );
  }

  // Multiline text fields (notes, any *_reason).
  const multiline = name === "notes" || /(_reason|_notes|reason|notes|comment|comments|description)$/i.test(name);
  if (multiline) {
    return (
      <ModalShell title={`${label} — ${recordName || ""}`} onKey={onKey} onCancel={onCancel} onSave={onSave}>
        <textarea ref={firstRef} rows={6} value={value ?? ""} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey}
          style={{ width: "100%", resize: "vertical" }} placeholder={`Add ${label.toLowerCase()}…`} />
        <div className="muted small" style={{ marginTop: 6 }}>Enter inserts a newline. Cmd/Ctrl+Enter saves.</div>
      </ModalShell>
    );
  }

  // Phone number — show a formatter as the user types.
  if (/phone|tel|mobile|cell/.test(name)) {
    const fmtPhone = (raw) => {
      const d = String(raw || "").replace(/\D+/g, "").slice(0, 10);
      if (d.length <= 3) return d;
      if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
      return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    };
    return (
      <ModalShell title={`${label} — ${recordName || ""}`} onKey={onKey} onCancel={onCancel} onSave={onSave}>
        <input ref={firstRef} type="tel" value={fmtPhone(value)} onChange={(e) => onChange(e.target.value.replace(/\D+/g, ""))}
          onKeyDown={onKey} placeholder="(555) 123-4567" style={{ fontSize: 18 }} />
        <div className="muted small" style={{ marginTop: 6 }}>Digits only are stored; the format is just for display.</div>
      </ModalShell>
    );
  }

  // Boolean — toggle switch.
  if (field.data_type === "bool") {
    const on = !!value;
    return (
      <ModalShell title={`${label} — ${recordName || ""}`} onKey={onKey} onCancel={onCancel} onSave={onSave}>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className={"btn" + (on ? "" : " primary")} onClick={() => onChange(false)} style={{ flex: 1 }}>No</button>
          <button type="button" className={"btn" + (on ? " primary" : "")} onClick={() => onChange(true)} style={{ flex: 1 }}>Yes</button>
        </div>
      </ModalShell>
    );
  }

  // Select (configured options).
  if (field.data_type === "select") {
    let opts = []; try { opts = JSON.parse(field.options || "[]"); } catch {}
    return (
      <ModalShell title={`${label} — ${recordName || ""}`} onKey={onKey} onCancel={onCancel} onSave={onSave}>
        <select ref={firstRef} value={value ?? ""} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey}>
          <option value="">(blank)</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </ModalShell>
    );
  }

  // Number.
  if (field.data_type === "number") {
    return (
      <ModalShell title={`${label} — ${recordName || ""}`} onKey={onKey} onCancel={onCancel} onSave={onSave}>
        <input ref={firstRef} type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} />
      </ModalShell>
    );
  }

  // Date.
  if (field.data_type === "date") {
    return (
      <ModalShell title={`${label} — ${recordName || ""}`} onKey={onKey} onCancel={onCancel} onSave={onSave}>
        <input ref={firstRef} type="date" value={value ?? ""} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} />
      </ModalShell>
    );
  }

  // Plain text.
  return (
    <ModalShell title={`${label} — ${recordName || ""}`} onKey={onKey} onCancel={onCancel} onSave={onSave}>
      <input ref={firstRef} type="text" value={value ?? ""} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey}
        placeholder={`Type ${label.toLowerCase()}…`} />
    </ModalShell>
  );
}

// The Press cleared cell is rendered as a single checkbox. Clicking it opens
// this modal, which shows the two requirements that drive the auto-rule and a
// single Cleared toggle. If the toggle would contradict the auto-rule, the user
// has to add a reason — that becomes the press_override the system records.
//
// Behavior:
//   - Toggling matches auto-rule  → clear any override (revert to auto).
//   - Toggling against auto-rule  → require a reason; save as override
//                                   ("clear" if checking on a waiting player,
//                                    "hold" if unchecking an auto-cleared one).
function PressClearanceModal({ recordName, status, overrideKind, overrideReason, onCancel, onApply }) {
  const autoCleared = !!status?.cleared && status?.source === "auto";
  const initialChecked = !!status?.cleared; // current effective state
  const [checked, setChecked] = useState(initialChecked);
  const [reason, setReason] = useState(overrideReason || "");

  // What does the auto-rule say? Used to decide if the new state requires an
  // override and to render the requirements list.
  const autoSaysCleared = autoCleared
    ? true
    : (overrideKind ? !status?.missing?.length : !!status?.cleared);
  const missing = status?.missing || [];
  const sizeOk = !missing.includes("size_confirmed");
  const firstWeeksOk = !missing.includes("first_weeks_attendance");
  const seasonStarted = !missing.includes("season_started");

  // Determine the action implied by the toggle's current position.
  const wantsOverride = checked !== autoSaysCleared;
  const action = !wantsOverride
    ? (overrideKind ? "remove_override" : "noop")
    : (checked ? "force_clear" : "hold");

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  }

  async function apply() {
    if (action === "noop") { onCancel(); return; }
    if (action === "remove_override") return onApply("", "");
    if (!reason.trim()) return; // reason is required for overrides; the inline warning above will guide the user
    if (action === "force_clear") return onApply("clear", reason.trim());
    if (action === "hold") return onApply("hold", reason.trim());
  }

  const needsReason = action === "force_clear" || action === "hold";

  const RuleRow = ({ ok, label, detail }) => (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <span style={{ fontSize: 18, lineHeight: 1.2, color: ok ? "#0a7c3a" : "#b71d3a", flex: "0 0 auto", width: 22 }}>{ok ? "✓" : "✕"}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        {detail && <div className="muted small">{detail}</div>}
      </div>
    </div>
  );

  return (
    <ModalShell
      title={`Press clearance — ${recordName || "this player"}`}
      subtitle="Cleared players are safe to print on custom jerseys and public materials."
      onKey={onKey}
      onCancel={onCancel}
      onSave={apply}
    >
      {/* Requirements checklist — the rules attached to this checkbox. */}
      <div className="card" style={{ background: "var(--line-soft, #f6f6fa)", padding: "8px 12px", marginBottom: 14 }}>
        <div className="muted small" style={{ marginBottom: 4, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>Requirements (auto-rule)</div>
        <RuleRow ok={sizeOk} label="Size confirmed at check-in" detail="A staff member confirmed the jersey size when the player checked in." />
        <RuleRow ok={firstWeeksOk && seasonStarted} label="Attended at least one of the first two weeks"
          detail={seasonStarted ? "Catches no-shows before the league prints a custom jersey for them." : "Season hasn't started — this requirement isn't evaluated yet."} />
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 8, cursor: "pointer", background: checked ? "rgba(10,124,58,.08)" : "#fff" }}>
        <input type="checkbox" style={{ width: "auto", transform: "scale(1.35)", accentColor: "var(--brand)" }}
          checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span style={{ fontWeight: 700 }}>Cleared to press</span>
        {overrideKind && (
          <span className="chip" style={{ marginLeft: "auto", background: "rgba(220,150,30,.14)", color: "#a36800" }}>
            override: {overrideKind}
          </span>
        )}
      </label>

      {/* What's going to happen on Save? */}
      <div className="muted small" style={{ marginTop: 10 }}>
        {action === "noop" && "No change."}
        {action === "remove_override" && "Removes the current override; the auto-rule will determine status from now on."}
        {action === "force_clear" && "Player doesn't meet the auto-rule — this will record a manual override (\"force clear\") with your name and a timestamp."}
        {action === "hold" && "Player meets the auto-rule — this will record a manual hold with your name and a timestamp."}
      </div>

      {needsReason && (
        <>
          <label className="fld" style={{ marginTop: 10 }}>Reason {wantsOverride ? <span className="req">*</span> : null}</label>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={onKey}
            placeholder={action === "hold" ? "Why are you holding this player?" : "Why are you clearing this player even though the requirements aren't met?"}
            style={{ width: "100%", resize: "vertical" }} />
          {!reason.trim() && <div className="muted small" style={{ marginTop: 4, color: "var(--warn, #b40)" }}>A reason is required when overriding the auto-rule.</div>}
        </>
      )}
    </ModalShell>
  );
}

// Press override gets its own editor because it co-edits the reason field and
// saves through the press API (which stamps `by` + `at` + applies the auto-rule
// override flag in one call).
function PressOverrideModal({ recordName, initialOverride, initialReason, onSave, onCancel }) {
  const [choice, setChoice] = useState((initialOverride || "").toLowerCase());
  const [reason, setReason] = useState(initialReason || "");
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSave(choice, reason); }
  }
  const Pill = ({ k, body, danger }) => (
    <button type="button"
      onClick={() => setChoice(k)}
      className={"btn" + (choice === k ? " primary" : "")}
      style={{ flex: 1, background: choice === k && danger ? "var(--danger)" : undefined, borderColor: choice === k && danger ? "var(--danger)" : undefined, color: choice === k && danger ? "#fff" : undefined }}
    >{body}</button>
  );
  return (
    <ModalShell
      title={`Press status — ${recordName || "this player"}`}
      subtitle="Force-clear or hold a player for press materials. None falls back to the auto-rule."
      onKey={onKey}
      onCancel={onCancel}
      onSave={() => onSave(choice, reason)}
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <Pill k="" body={<><b>None</b><div className="muted small">Auto-rule</div></>} />
        <Pill k="clear" body={<><b>✓ Clear</b><div className="muted small">Force eligible</div></>} />
        <Pill k="hold" body={<><b>✕ Hold</b><div className="muted small">Force ineligible</div></>} danger />
      </div>
      <label className="fld">Reason {choice ? <span className="muted">(optional but recommended)</span> : <span className="muted">(none — auto-rule is active)</span>}</label>
      <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={onKey} disabled={!choice}
        placeholder={choice ? "Why are you overriding the auto-rule?" : "Pick Clear or Hold to add a reason."}
        style={{ width: "100%", resize: "vertical" }} />
      <div className="muted small" style={{ marginTop: 6 }}>Your name + the timestamp are saved with the override.</div>
    </ModalShell>
  );
}

// Shared modal chrome so each editor stays focused on its own control.
function ModalShell({ title, subtitle, children, onCancel, onSave, onKey }) {
  return (
    <div className="overlay" onClick={onCancel} onKeyDown={onKey}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h2 style={{ marginBottom: subtitle ? 2 : 8 }}>{title}</h2>
        {subtitle && <div className="muted small" style={{ marginBottom: 10 }}>{subtitle}</div>}
        {children}
        <div className="btn-row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
