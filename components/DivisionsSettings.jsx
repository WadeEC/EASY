"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";

const DIV_ICO = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" /><line x1="7" y1="7" x2="7.01" y2="7" />
  </svg>
);

// Divisions = age groups players are auto-sorted into. Lives on Leagues & Assignment.
export default function DivisionsSettings({ onAsk }) {
  const [cfg, setCfg] = useState(null);
  const [flash, setFlash] = useState(null);
  const [name, setName] = useState("");
  const [league, setLeague] = useState("");
  const [lo, setLo] = useState("");
  const [hi, setHi] = useState("");
  const [ai, setAi] = useState("");
  const [busy, setBusy] = useState(false);
  // Inline edit: the division being edited and its draft values.
  const [editId, setEditId] = useState(null);
  const [draft, setDraft] = useState({});

  async function load() { setCfg(await api.divisionsList()); }
  useEffect(() => { load(); }, []);
  if (!cfg || cfg.error) return null;

  const leagues = cfg.leagues || [];
  const divisions = cfg.divisions || [];

  async function add() {
    if (!name.trim()) return setFlash({ ok: false, text: "Name the division." });
    if (lo === "" || hi === "") return setFlash({ ok: false, text: "Set the min and max age." });
    const res = await api.divisionCreate({ name: name.trim(), league: league || "", age_min: Number(lo), age_max: Number(hi) });
    if (res.error) return setFlash({ ok: false, text: res.error });
    setFlash({ ok: true, text: `Added — ${res.reassigned} player(s) re-sorted.` });
    setName(""); setLo(""); setHi(""); await load();
  }
  async function seed() {
    setBusy(true); const res = await api.divisionsSeed(); setBusy(false);
    setFlash({ ok: true, text: `Standard divisions ready — ${res.added} added, ${res.reassigned} player(s) sorted.` });
    await load();
  }
  async function del(d) {
    if (!window.confirm(`Delete the division "${d.name}"? Players in it will be re-sorted into whichever division fits their age.`)) return;
    await api.divisionDel(d.id); await load();
  }
  // Save an edited division. The server re-sorts every player afterwards, so a
  // changed age range (or a renamed division) shows up on players right away.
  async function saveEdit() {
    if (!String(draft.name || "").trim()) return setFlash({ ok: false, text: "Name the division." });
    if (draft.age_min === "" || draft.age_max === "") return setFlash({ ok: false, text: "Set the min and max age." });
    const res = await api.divisionEdit(editId, { name: draft.name.trim(), league: draft.league || "", age_min: Number(draft.age_min), age_max: Number(draft.age_max) });
    if (res.error) return setFlash({ ok: false, text: res.error });
    setFlash({ ok: true, text: `Saved "${draft.name.trim()}" — players re-sorted.` });
    setEditId(null); await load();
  }
  function submitAi() {
    const t = ai.trim(); if (!t) return;
    if (onAsk) onAsk(`Create a division: ${t}`);
    setAi("");
  }

  return (
    <>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      <div className="card">
        <div className="between"><h2 style={{ margin: 0 }}>Divisions (age groups)</h2>{divisions.length > 0 && <span className="chip">{divisions.length}</span>}</div>
        <p className="muted small">Players are sorted automatically into the division whose age range fits — within their league. Aim to cover ages 4–17.</p>
        <div className="rule-list">
          {divisions.map((d) => editId === d.id ? (
            <div className="card" key={d.id} style={{ background: "var(--line-soft)", marginBottom: 0 }}>
              <div className="row">
                <div><label className="fld">Name</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
                <div>
                  <label className="fld">League</label>
                  <select value={draft.league} onChange={(e) => setDraft({ ...draft, league: e.target.value })}>
                    <option value="">All leagues</option>
                    {[...new Set([draft.league, ...leagues].filter(Boolean))].map((l) => <option key={l} value={l}>{l}</option>)}
                  </select>
                </div>
                <div><label className="fld">Min age</label><input type="number" value={draft.age_min} onChange={(e) => setDraft({ ...draft, age_min: e.target.value })} /></div>
                <div><label className="fld">Max age</label><input type="number" value={draft.age_max} onChange={(e) => setDraft({ ...draft, age_max: e.target.value })} /></div>
              </div>
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button className="btn primary sm" onClick={saveEdit}>Save division</button>
                <button className="btn ghost sm" onClick={() => setEditId(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="rule-row" key={d.id}>
              <div className="rule-ico kt">{DIV_ICO}</div>
              <div className="rule-main">
                <div className="nm">{d.name}</div>
                <div className="ty">ages {d.age_min}–{d.age_max}{d.league ? ` · ${d.league}` : " · all leagues"}</div>
              </div>
              <button className="btn ghost sm" onClick={() => { setEditId(d.id); setDraft({ name: d.name, league: d.league || "", age_min: d.age_min, age_max: d.age_max }); }}>Edit</button>
              <button className="btn ghost sm" onClick={() => del(d)}>Delete</button>
            </div>
          ))}
          {!divisions.length && <div className="muted small" style={{ marginTop: 4 }}>No divisions yet — set up the standard set or add your own below.</div>}
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={seed} disabled={busy}>{busy ? "Setting up…" : "Set up standard divisions (4–17)"}</button>
        </div>
      </div>

      <div className="card">
        <h3>Add a division</h3>
        <div className="row">
          <div><label className="fld">Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ages 9-10" /></div>
          <div>
            <label className="fld">League</label>
            <select value={league} onChange={(e) => setLeague(e.target.value)}>
              <option value="">All leagues</option>
              {leagues.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div><label className="fld">Min age</label><input type="number" min={4} max={17} value={lo} onChange={(e) => setLo(e.target.value)} /></div>
          <div><label className="fld">Max age</label><input type="number" min={4} max={17} value={hi} onChange={(e) => setHi(e.target.value)} /></div>
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={add}>Add division</button>
        </div>

        <div className="aibox" style={{ marginTop: 16 }}>
          <div className="aibox-head"><span className="ai-badge">S-Dot</span> Add with S-Dot</div>
          <p className="muted small">e.g. “ages 9 to 10 division” or “set up divisions for ages 4 to 17”.</p>
          <div className="aibar">
            <input placeholder="Describe a division…" value={ai} onChange={(e) => setAi(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAi(); }} />
            <button className="btn primary" onClick={submitAi}>Create with S-Dot</button>
          </div>
        </div>
      </div>
    </>
  );
}
