"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api.js";
import { divisionChoices, resolveDivision, leagueChoices } from "@/lib/ui.js";
import FieldInput from "./FieldInput.jsx";

const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0);
const headFirst = (cs) => [...cs].sort((a, b) => (/head/i.test(b.role) ? 1 : 0) - (/head/i.test(a.role) ? 1 : 0));

// Editable team board (no check-in): drag players between teams, edit details, and ask the AI.
export default function TeamEditor({ go, onAsk }) {
  const [players, setPlayers] = useState(undefined);
  const [coaches, setCoaches] = useState([]);
  const [fields, setFields] = useState([]);
  const [lowSet, setLowSet] = useState(() => new Set());
  const [league, setLeague] = useState("");
  const [division, setDivision] = useState("");
  const [flash, setFlash] = useState(null);
  const [edit, setEdit] = useState(null);
  const [vals, setVals] = useState({});
  const [aiText, setAiText] = useState("");
  const [over, setOver] = useState(null);
  const [renaming, setRenaming] = useState(null);   // { team, draft } while a heading is being edited
  const [renameBusy, setRenameBusy] = useState(false);
  const [divisions, setDivisions] = useState([]);   // the defined age brackets
  const dragId = useRef(null);

  async function load() {
    const r = await api.records("player");
    // The brackets you defined — the picker comes from these, not from the
    // strings sitting in players' division fields. That's how a dropdown ends
    // up offering "10".
    try {
      const dv = await api.records("division");
      setDivisions((dv.records || []).map((x) => { const d = parse(x.data); return { id: x.id, name: x.name || d.name || `#${x.id}`, league: d.league || "", age_min: d.age_min, age_max: d.age_max }; }));
    } catch { setDivisions([]); }
    // Scope to the sidebar's season picker (untagged players show everywhere).
    let sn = "";
    try { sn = (typeof localStorage !== "undefined" && localStorage.getItem("ff_season")) || ""; } catch {}
    const inScope = (x) => {
      if (!sn) return true;
      const s = parse(x.data).season ? String(parse(x.data).season) : "";
      return sn === "(no season)" ? !s : s === sn;
    };
    setPlayers((r.records || []).filter(inScope).map((x) => { const d = parse(x.data); return { id: x.id, name: x.name || d.full_name || `#${x.id}`, team: d.team || "", league: d.league || "", division: d.division || "", data: d }; }));
    try { const s = await api.schema("player"); setFields(s.fields || []); } catch {}
    try { const c = await api.records("coach"); setCoaches((c.records || []).map((x) => { const d = parse(x.data); return { id: x.id, name: x.name || d.full_name || `#${x.id}`, role: d.role || "", team: d.team || "" }; })); } catch { setCoaches([]); }
    try { const la = await api.teamsLowAvail(); setLowSet(new Set((la.ids || []).map(Number))); } catch {}
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Compute leagues/divisions before the early-return so the effects below can read them.
  const leagues = leagueChoices(fields, (players || []).map((p) => p.league));
  // Defined brackets first, youngest first. Anything on a player that isn't a
  // real bracket is still offered — otherwise those players are unreachable —
  // but flagged, because it needs cleaning up rather than picking.
  const divChoices = divisionChoices(divisions, league);
  const divOptions = divChoices.map((c) => c.value);
  // A player is in a bracket because of their AGE — not because of whatever
  // string is in their division field.
  const divOf = (p) => resolveDivision(divisions, p);

  // The filters are required (no "All" option), so once data lands we anchor on the
  // first available league and the first division within that league. Re-anchor if
  // the current selection disappears (e.g. last player in that division moved out).
  useEffect(() => {
    if (!players || players === undefined) return;
    if (!leagues.length) { if (league) setLeague(""); if (division) setDivision(""); return; }
    if (!league || !leagues.includes(league)) { setLeague(leagues[0]); setDivision(""); return; }
    if (!divOptions.length) { if (division) setDivision(""); return; }
    if (!division || !divOptions.includes(division)) setDivision(divOptions[0]);
  }, [players, league, division, leagues.join("|"), divOptions.join("|")]);

  if (players === undefined || players?.error) return <div className="muted">Loading…</div>;

  const scoped = players.filter((p) => p.league === league && divOf(p) === division);

  const units = {};
  for (const p of scoped) { if (!p.team) continue; (units[p.team] = units[p.team] || []).push(p); }
  const teamNames = Object.keys(units).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const unassigned = scoped.filter((p) => !p.team);
  const lowByTeam = teamNames.map((name) => units[name].filter((p) => lowSet.has(p.id)).length);
  const lowOff = lowByTeam.some((n) => n > 0) && (Math.max(...lowByTeam) - Math.min(...lowByTeam) > 1);

  async function moveTo(teamName) {
    const id = dragId.current; dragId.current = null; setOver(null);
    if (id == null) return;
    const p = players.find((x) => x.id === id);
    if (!p || (p.team || "") === (teamName || "")) return;
    await api.updateRecord(id, { team: teamName });
    setFlash({ ok: true, text: `Moved ${p.name} to ${teamName || "no team"}.` });
    await load();
  }
  function openEdit(p) { setEdit(p); setVals({ ...(p.data || {}) }); }
  async function saveEdit() {
    const res = await api.updateRecord(edit.id, vals);
    if (res && res.error) return setFlash({ ok: false, text: res.error });
    setEdit(null); setFlash({ ok: true, text: "Player updated." }); await load();
  }

  // Renaming a team is a cascade, not a text edit: the name is copied onto every
  // player, coach, game and bracket. The server does all of that in one audited
  // batch (api.renameTeam) — the UI just collects the new name and reports back.
  async function commitRename() {
    if (!renaming || renameBusy) return;
    const from = renaming.team;
    const to = renaming.draft.trim();
    if (!to || to === from) { setRenaming(null); return; }
    setRenameBusy(true);
    const res = await api.renameTeam(from, to, league || null);
    setRenameBusy(false);
    if (res && res.error) { setFlash({ ok: false, text: res.error }); return; }   // keep the box open so the name can be fixed
    setRenaming(null);
    const bits = [
      `${res.players} player${res.players === 1 ? "" : "s"}`,
      res.coaches ? `${res.coaches} coach${res.coaches === 1 ? "" : "es"}` : null,
      res.games ? `${res.games} game${res.games === 1 ? "" : "s"}` : null,
      res.brackets ? `${res.brackets} bracket${res.brackets === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    setFlash({ ok: true, text: `Renamed "${from}" to "${to}" — updated ${bits.join(", ")}.` });
    await load();
  }

  function submitAi() { const t = aiText.trim(); if (!t) return; if (onAsk) onAsk(`For team editing: ${t}`); setAiText(""); }

  const teamCard = (name, list) => {
    const cos = headFirst(coaches.filter((c) => (c.team || "") === (name || "")));
    return (
      <div className={"card team-col" + (over === (name || "__none") ? " over" : "")} key={name || "__none"}
        onDragOver={(e) => { e.preventDefault(); setOver(name || "__none"); }}
        onDragLeave={() => setOver((o) => (o === (name || "__none") ? null : o))}
        onDrop={() => moveTo(name)}>
        <div className="between">
          {renaming && renaming.team === name ? (
            <input
              className="team-rename"
              autoFocus
              disabled={renameBusy}
              value={renaming.draft}
              onChange={(e) => setRenaming((r) => (r ? { ...r, draft: e.target.value } : r))}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
              }}
            />
          ) : (
            <h3
              style={{ margin: 0 }}
              className={name ? "renamable" : undefined}
              title={name ? "Double-click to rename this team" : undefined}
              onDoubleClick={name ? () => setRenaming({ team: name, draft: name }) : undefined}>
              {name || "No team"}
            </h3>
          )}
          <div className="btn-row" style={{ gap: 6 }}>
            {list.some((p) => lowSet.has(p.id)) && <span className="chip" title="low-attendance players">{list.filter((p) => lowSet.has(p.id)).length} low</span>}
            <span className="chip">{list.length}{list.length ? ` · avg ${avg(list.map((p) => Number(p.data.age) || 0))}` : ""}</span>
          </div>
        </div>
        {cos.length > 0 && (
          <div className="coach-row">
            {cos.map((c) => <span className="coachpill" key={c.id} title={c.role || "Coach"}>{c.name}{/head/i.test(c.role) ? " · Head" : c.role ? " · Asst" : ""}</span>)}
          </div>
        )}
        <div className="stack" style={{ marginTop: 8 }}>
          {list.map((p) => (
            <div key={p.id} className={"drag-item" + (p.data.link_group ? " linked" : "")} draggable
              onDragStart={() => { dragId.current = p.id; }} onClick={() => openEdit(p)} title="Click to view & edit">
              <span>{p.name}
                {divOf(p) ? <span className="muted small"> · {divOf(p)}</span> : null}
                {p.data.link_group ? <span className="linkpill">{p.data.link_group}</span> : null}
                {p.data.all_star ? <span className="starpill">all-star</span> : null}
                {lowSet.has(p.id) ? <span className="muted small"> · low att</span> : null}
              </span>
              <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); openEdit(p); }}>Edit</button>
            </div>
          ))}
          {!list.length && <div className="muted small">drop players here</div>}
        </div>
      </div>
    );
  };

  return (
    <div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      {onAsk && (
        <div className="aibox">
          <div className="aibox-head"><span className="ai-badge">S-Dot</span> Edit teams with S-Dot</div>
          <p className="muted small">Tell S-Dot what to change in plain English — it drafts it and you confirm before anything is saved.</p>
          <div className="aibar">
            <input placeholder="e.g. move a player to another team, or keep two players together" value={aiText}
              onChange={(e) => setAiText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitAi(); }} />
            <button className="btn primary" onClick={submitAi}>Ask S-Dot</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <div>
            <label className="fld">League</label>
            <select value={league} onChange={(e) => { setLeague(e.target.value); setDivision(""); }}>
              {leagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="fld">Division</label>
            <select value={division} onChange={(e) => setDivision(e.target.value)}>
              {divChoices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>Drag a player to another team to move them — changes save right away. Tap Edit to update their details.</div>
      </div>

      {lowOff && (
        <div className="note warn">
          Low-attendance players are uneven across teams (per team: {lowByTeam.join(", ")}). Rebuild on the <a onClick={() => go({ page: "teambuilder", tab: "build" })}>Build teams</a> tab to spread them so no team is short on bodies.
        </div>
      )}

      {!teamNames.length && !unassigned.length && (
        <div className="card"><p className="muted" style={{ margin: 0 }}>No saved teams yet. Build teams first, then edit them here.</p></div>
      )}

      {(teamNames.length > 0 || unassigned.length > 0) && (
        <div className="team-grid">
          {teamNames.map((name) => teamCard(name, units[name]))}
          {unassigned.length > 0 && teamCard("", unassigned)}
        </div>
      )}

      {edit && (
        <div className="overlay" onClick={() => setEdit(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: 4 }}>Edit {edit.name}</h2>
            <div className="muted small" style={{ marginBottom: 8 }}>Update this player’s details.</div>
            {fields.map((f) => <FieldInput key={f.name} field={f} value={vals[f.name]} onChange={(v) => setVals({ ...vals, [f.name]: v })} />)}
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
