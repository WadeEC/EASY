"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import TeamSettings from "./TeamSettings.jsx";
import FlagsSettings from "./FlagsSettings.jsx";
import DivisionsSettings from "./DivisionsSettings.jsx";
import AiPromptBar from "./AiPromptBar.jsx";

const OPS = [">=", "<=", ">", "<", "==", "!="];

export default function Leagues({ refresh, onAsk }) {
  const [player, setPlayer] = useState(undefined); // undefined=loading, null=missing
  const [rules, setRules] = useState([]);
  const [flash, setFlash] = useState(null);
  const [newTwp, setNewTwp] = useState("");
  const [newLg, setNewLg] = useState("");
  const [seeding, setSeeding] = useState(false);
  const [tab, setTab] = useState("townships");
  const [aiRule, setAiRule] = useState("");
  const [locks, setLocks] = useState([]);
  const [reassigning, setReassigning] = useState(false);

  // assignment builder
  const [name, setName] = useState("");
  const [conds, setConds] = useState([{ field: "(none)", op: ">=", value: "" }, { field: "(none)", op: ">=", value: "" }, { field: "(none)", op: ">=", value: "" }]);
  const [target, setTarget] = useState("");

  async function load() {
    const full = await api.schema();
    setPlayer(full.schema?.player || null);
    const a = await api.assignment("player");
    setRules(a.rules || []);
    try {
      const lr = await api.leagueLocks();
      setLocks(lr.locks || []);
    } catch { setLocks([]); }
  }
  useEffect(() => { load(); }, []);

  if (player === undefined || player?.error) return <div className="muted">Loading…</div>;

  if (!player) {
    return (
      <div>
        <div className="page-head"><h1>Leagues &amp; Assignment</h1></div>
        <div className="card">
          <h2>Set up your Players section first</h2>
          <p className="muted">This creates a standard Players section with the five townships and two leagues,
            so you can upload rosters and route kids into leagues.</p>
          <button className="btn primary" disabled={seeding}
            onClick={async () => { setSeeding(true); await api.seed(); await load(); refresh && refresh(); setSeeding(false); }}>
            {seeding ? "Setting up…" : "Set up standard Players"}
          </button>
        </div>
      </div>
    );
  }

  const field = (n) => player.fields.find((f) => f.name === n);
  const opts = (n) => { const f = field(n); return f && Array.isArray(f.options) ? f.options : []; };
  const townships = opts("township");
  const leagues = opts("league");
  const fieldNames = player.fields.map((f) => f.name);

  async function addOption(fieldName, value, clear) {
    if (!value.trim()) return;
    const res = await api.option("player", fieldName, value.trim());
    setFlash(res.error ? { ok: false, text: res.error } : { ok: true, text: "Added." });
    clear(""); await load(); refresh && refresh();
  }

  async function saveRule() {
    const used = conds.filter((c) => c.field !== "(none)" && String(c.value).trim() !== "")
      .map((c) => ({ field: c.field, op: c.op, value: String(c.value).trim() }));
    if (!name.trim()) return setFlash({ ok: false, text: "Give the rule a name." });
    if (!used.length) return setFlash({ ok: false, text: "Add at least one condition." });
    if (!leagues.length) return setFlash({ ok: false, text: "Add at least one league first." });
    const res = await api.createAssignment({ name: name.trim(), conditions: used, set_value: target || leagues[0], set_field: "league", record_type: "player" });
    if (res.error) return setFlash({ ok: false, text: res.error });
    setFlash({ ok: true, text: "Rule saved — it applies to new and imported players." });
    setName(""); setConds([{ field: "(none)", op: ">=", value: "" }, { field: "(none)", op: ">=", value: "" }, { field: "(none)", op: ">=", value: "" }]);
    await load();
  }

  function submitAiRule() {
    const t = aiRule.trim();
    if (!t) return;
    if (onAsk) onAsk(`Create a player assignment rule: ${t}`);
    setAiRule("");
  }

  // Re-run every assignment rule against every existing player. Used after editing
  // a rule (or changing a player's data) when stored leagues / divisions should
  // catch up. Existing values get overwritten only when a rule actually matches —
  // a manually-set value with no matching rule is left alone.
  async function reassignNow() {
    if (reassigning) return;
    setReassigning(true);
    setFlash(null);
    try {
      const res = await api.reassignAll("player");
      if (res.error) { setFlash({ ok: false, text: res.error }); return; }
      const parts = [];
      const { fields = {}, updated = 0, scanned = 0 } = res;
      const keys = Object.keys(fields);
      if (!updated) parts.push(`No changes — all ${scanned} players already match.`);
      else {
        parts.push(`Updated ${updated} of ${scanned} players.`);
        if (keys.length) parts.push(`Fields: ${keys.map((k) => `${k} ×${fields[k]}`).join(", ")}.`);
      }
      setFlash({ ok: true, text: parts.join(" ") });
      refresh && refresh();
    } finally {
      setReassigning(false);
    }
  }

  return (
    <div>
      <div className="page-head"><h1>Leagues &amp; Assignment</h1>
        <div className="muted">Manage your sources and leagues, and route players automatically.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      <div className="btn-row" style={{ marginBottom: 16 }}>
        <button className={"pill" + (tab === "townships" ? " active" : "")} onClick={() => setTab("townships")}>Townships</button>
        <button className={"pill" + (tab === "leagues" ? " active" : "")} onClick={() => setTab("leagues")}>Leagues</button>
        <button className={"pill" + (tab === "assignment" ? " active" : "")} onClick={() => setTab("assignment")}>Assignment</button>
        <button className={"pill" + (tab === "divisions" ? " active" : "")} onClick={() => setTab("divisions")}>Divisions</button>
        <button className={"pill" + (tab === "teams" ? " active" : "")} onClick={() => setTab("teams")}>Team building</button>
        <button className={"pill" + (tab === "flags" ? " active" : "")} onClick={() => setTab("flags")}>Home flags</button>
        <button className={"pill" + (tab === "moves" ? " active" : "")} onClick={() => setTab("moves")}>Roster moves</button>
      </div>

      {tab === "townships" && (
      <div className="card">
        <div className="between"><h2 style={{ margin: 0 }}>Townships</h2>{townships.length > 0 && <span className="chip">{townships.length}</span>}</div>
        <p className="muted small">Where players register — used as import sources and in assignment rules.</p>
        <div className="chip-well">
          {townships.length ? townships.map((t) => <span className="chip accent lg" key={t}>{t}</span>) : <span className="muted small">No townships yet.</span>}
        </div>
        <label className="fld">Add a township</label>
        <div className="addbar">
          <input placeholder="New township name" value={newTwp} onChange={(e) => setNewTwp(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addOption("township", newTwp, setNewTwp); }} />
          <button className="btn primary" onClick={() => addOption("township", newTwp, setNewTwp)}>Add township</button>
        </div>
      </div>
      )}

      {tab === "leagues" && (
      <div className="card">
        <div className="between"><h2 style={{ margin: 0 }}>Leagues</h2>{leagues.length > 0 && <span className="chip">{leagues.length}</span>}</div>
        <p className="muted small">The groups players are routed into by your assignment rules.</p>
        <div className="chip-well">
          {leagues.length ? leagues.map((t) => <span className="chip brand lg" key={t}>{t}</span>) : <span className="muted small">No leagues yet.</span>}
        </div>
        {leagues.length > 0 && (
          <div className="stack" style={{ marginTop: 14 }}>
            {leagues.map((lg) => {
              const lk = locks.find((l) => l.league === lg);
              const isLocked = !!(lk && lk.locked);
              return (
                <div className="between" key={lg} style={{ borderBottom: "1px solid var(--line-soft)", paddingBottom: 8 }}>
                  <div><b>{lg}</b> <span className="muted small">{isLocked ? "🔒 Roster locked" : "Unlocked"}</span></div>
                  <button className="btn" onClick={async () => {
                    await api.setLeagueLock(lg, !isLocked);
                    await load();
                  }}>{isLocked ? "Unlock" : "Lock roster"}</button>
                </div>
              );
            })}
          </div>
        )}
        <label className="fld">Add a league</label>
        <div className="addbar">
          <input placeholder="New league name" value={newLg} onChange={(e) => setNewLg(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addOption("league", newLg, setNewLg); }} />
          <button className="btn primary" onClick={() => addOption("league", newLg, setNewLg)}>Add league</button>
        </div>
      </div>
      )}

      {tab === "assignment" && (
      <div className="card">
        <div className="between" style={{ alignItems: "flex-start" }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Assignment rules</h2>
            <p className="muted small" style={{ marginTop: 0 }}>If a player matches ALL conditions, they’re routed to the chosen league — automatically, when added or imported.</p>
          </div>
          <button
            className="btn"
            disabled={reassigning || !rules.length}
            title={!rules.length ? "Add at least one rule first" : "Re-evaluate the rules above against every existing player. Use this after editing a rule or a player's data."}
            onClick={reassignNow}
          >
            {reassigning ? "Reassigning…" : "Reassign all players"}
          </button>
        </div>
        <div className="stack">
          {rules.map((r) => (
            <div className="between" key={r.id} style={{ borderBottom: "1px solid var(--line-soft)", paddingBottom: 8 }}>
              <div className="small"><b>{r.name}</b> — if {r.conditions.map((c) => `${c.field} ${c.op} ${c.value}`).join("  and  ") || "(any)"} → <b>{r.set_field} = {r.set_value}</b></div>
              <button className="btn ghost sm" onClick={async () => { await api.deleteAssignment(r.id); await load(); }}>Delete</button>
            </div>
          ))}
          {!rules.length && <div className="muted small">No assignment rules yet.</div>}
        </div>

        <div className="divider" />
        <div className="aibox" style={{ marginBottom: 0 }}>
          <div className="aibox-head"><span className="ai-badge">S-Dot</span> Add or edit a rule with S-Dot</div>
          <AiPromptBar
            pageId="leagues"
            value={aiRule}
            onChange={setAiRule}
            onSend={(t) => { setAiRule(t); setTimeout(submitAiRule, 0); }}
            placeholder="e.g. players 13 and older go to Saturday Limerick"
            sendLabel="Create with S-Dot"
            hint="Tap a quick option below — or describe a rule in plain English."
          />
        </div>
      </div>
      )}

      {tab === "divisions" && <DivisionsSettings onAsk={onAsk} />}
      {tab === "teams" && <TeamSettings onAsk={onAsk} />}
      {tab === "flags" && <FlagsSettings onAsk={onAsk} />}
      {tab === "moves" && <RosterMoves locks={locks} reloadLocks={load} setFlash={setFlash} />}
    </div>
  );
}

function upd(setter, arr, i, key, value) {
  const next = arr.map((x, j) => (j === i ? { ...x, [key]: value } : x));
  setter(next);
}

function RosterMoves({ locks, reloadLocks, setFlash }) {
  const [ctx, setCtx] = useState(null);
  const [sourceLeague, setSourceLeague] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [destLeague, setDestLeague] = useState("");
  const [destDivision, setDestDivision] = useState("");
  const [mode, setMode] = useState("set");
  const [result, setResult] = useState(null);

  async function load() {
    const c = await api.rosterContext();
    setCtx(c);
  }
  useEffect(() => { load(); }, []);

  if (!ctx) return <div className="card"><div className="muted">Loading…</div></div>;

  const filtered = ctx.players.filter((p) => !sourceLeague || p.league === sourceLeague || p.second_league === sourceLeague);
  const divisionsForDest = (ctx.divisions || []).filter((d) => !d.league || d.league === destLeague);
  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const apply = async () => {
    const changes = {};
    if (destLeague) changes.league = destLeague;
    if (destDivision) changes.division = destDivision;
    const r = await api.rosterMoveBulk([...selected], changes, mode);
    setResult(r);
    setFlash({ ok: !r.error, text: r.error || `Moved ${r.moved}, blocked ${r.blocked?.length || 0}.` });
    await load(); reloadLocks && reloadLocks();
    setSelected(new Set());
  };

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Move players between leagues / divisions</h2>
      <p className="muted small">Moves involving locked leagues are blocked automatically.</p>

      <label className="fld">From league</label>
      <select value={sourceLeague} onChange={(e) => setSourceLeague(e.target.value)}>
        <option value="">(any)</option>
        {ctx.leagues.map((lg) => <option key={lg} value={lg}>{lg}</option>)}
      </select>

      <div className="muted small" style={{ margin: "10px 0 4px" }}>{filtered.length} players · {selected.size} selected</div>
      <div className="card" style={{ maxHeight: 240, overflow: "auto", padding: 0 }}>
        <table className="tbl">
          <thead><tr><th></th><th>Player</th><th>Age</th><th>League</th><th>Also in</th><th>Division</th></tr></thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id}>
                <td><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
                <td>{p.name}</td>
                <td>{p.age}</td>
                <td>{p.league}</td>
                <td>{p.second_league}</td>
                <td>{p.division}</td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={6} className="muted" style={{ padding: 12 }}>No players match.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <div>
          <label className="fld">To league</label>
          <select value={destLeague} onChange={(e) => { setDestLeague(e.target.value); setDestDivision(""); }}>
            <option value="">(none)</option>
            {ctx.leagues.map((lg) => {
              const locked = (ctx.locks || []).find((l) => l.league === lg && l.locked);
              return <option key={lg} value={lg}>{lg}{locked ? " 🔒" : ""}</option>;
            })}
          </select>
        </div>
        <div>
          <label className="fld">Division (optional)</label>
          <select value={destDivision} onChange={(e) => setDestDivision(e.target.value)}>
            <option value="">(none)</option>
            {divisionsForDest.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </select>
        </div>
      </div>

      <div className="btn-row" style={{ marginTop: 12 }}>
        <label className="small"><input type="radio" name="mode" checked={mode === "set"} onChange={() => setMode("set")} /> Move them</label>
        <label className="small" style={{ marginLeft: 12 }}><input type="radio" name="mode" checked={mode === "add"} onChange={() => setMode("add")} /> Also add (player stays in current primary league)</label>
      </div>

      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!selected.size || !destLeague} onClick={apply}>Apply</button>
      </div>

      {result && result.blocked?.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="muted small">{result.blocked.length} blocked — click to see why</summary>
          <ul className="small">{result.blocked.map((b, i) => <li key={i}>#{b.id}: {b.reason}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
