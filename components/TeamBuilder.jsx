"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api.js";

const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : 0);
const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

function groupsOf(players) {
  const g = {};
  for (const p of players) if (p.link_group) (g[p.link_group] = g[p.link_group] || []).push(p);
  return g;
}

export default function TeamBuilder({ go, onAsk }) {
  const [cfg, setCfg] = useState(undefined);
  const [league, setLeague] = useState("");
  const [division, setDivision] = useState("");
  const [divisions, setDivisions] = useState([]);
  const [targetSize, setTargetSize] = useState(10);   // admin target roster size (recommended 8–12)
  const [numTeams, setNumTeams] = useState("");        // "" = auto from target size
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);
  const [showRules, setShowRules] = useState(false);
  const [rtype, setRtype] = useState("keep_together");
  const [rfield, setRfield] = useState("__siblings__");

  const [players, setPlayers] = useState([]);      // for the Links card
  const [groupName, setGroupName] = useState("");
  const [search, setSearch] = useState("");

  const [editTeams, setEditTeams] = useState(null); // editable preview
  const [linkConflicts, setLinkConflicts] = useState([]); // unresolved do-not-link pairs from the last preview
  const [cap, setCap] = useState(null);             // all-star cap { field, max }
  const [over, setOver] = useState(-1);
  const [pending, setPending] = useState(null); // proposed move awaiting confirmation
  const [advanced, setAdvanced] = useState(false);   // show manual size controls
  const [saved, setSaved] = useState(false);          // were the current teams just saved?
  const [confirmSave, setConfirmSave] = useState(false);
  const [aiText, setAiText] = useState("");
  const dragId = useRef(null);

  async function loadCfg() {
    const c = await api.teamConfig();
    setCfg(c);
    if (!league && c.leagues?.length) setLeague(c.leagues[0]);
  }
  async function loadPlayers() {
    const r = await api.records("player");
    const list = (r.records || []).map((x) => ({ id: x.id, ...parse(x.data), name: x.name || parse(x.data).full_name || `#${x.id}` }));
    setPlayers(league ? list.filter((p) => (p.league || "") === league) : list);
    const dv = await api.records("division");
    setDivisions((dv.records || []).map((x) => ({ id: x.id, ...parse(x.data) })));
  }
  useEffect(() => { loadCfg(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (cfg?.hasPlayer) loadPlayers(); /* eslint-disable-next-line */ }, [league, cfg]);
  useEffect(() => { const v = Number(typeof window !== "undefined" && localStorage.getItem("ff_target")); if (v >= 4 && v <= 30) setTargetSize(v); }, []);
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("ff_target", String(targetSize)); }, [targetSize]);

  if (cfg === undefined || cfg?.error) return <div className="muted">Loading…</div>;
  if (!cfg.hasPlayer) {
    return (
      <div>
        <div className="page-head"><h1>Teams</h1></div>
        <div className="card">
          <p className="muted">No Players section yet. Set one up and add players first.</p>
          <button className="btn" onClick={() => go({ page: "leagues" })}>Go to Leagues &amp; Assignment</button>
        </div>
      </div>
    );
  }

  function onRtype(v) {
    setRtype(v);
    setRfield(v === "keep_together" ? "__siblings__" : (cfg.fields.find((f) => f.type === "number")?.name || cfg.fields[0]?.name || ""));
  }

  async function addToGroup(playerId) {
    const g = groupName.trim();
    if (!g) return setFlash({ ok: false, text: "Name the group first (e.g. Carpool A)." });
    await api.linkPlayers([playerId], g);
    setSearch(""); await loadPlayers(); await loadCfg();
    setFlash({ ok: true, text: `Added to “${g}” — they’ll be kept on the same team.` });
  }
  async function unlink(id) { await api.unlinkPlayer(id); await loadPlayers(); }

  async function doPreview() {
    setBusy(true); setFlash(null);
    const opts = { league: league || null, division: division || null, targetSize: Number(targetSize) || 10 };
    if (numTeams) opts.numTeams = Number(numTeams);
    const res = await api.teamsPreview(opts);
    setBusy(false);
    if (res.error) return setFlash({ ok: false, text: res.error });
    if (!res.total) { setEditTeams(null); setLinkConflicts([]); return setFlash({ ok: false, text: "No players in that league yet." }); }
    setCap(res.cap || null);
    const teams = res.teams || [];
    setEditTeams(teams.map((t) => ({ name: t.name, players: t.players, coaches: t.coaches || [] })));
    setLinkConflicts(res.linkConflicts || []);
    setSaved(false);
  }
  function doSave() { if (editTeams && editTeams.length) setConfirmSave(true); }
  async function commitSave() {
    const teams = editTeams.map((t) => ({ name: t.name, ids: t.players.map((p) => p.id), coachIds: (t.coaches || []).map((c) => c.id) }));
    const res = await api.teamsSave(teams);
    setConfirmSave(false); setSaved(true);
    const extra = res.coachesSaved ? ` and ${res.coachesSaved} coaches` : "";
    setFlash({ ok: true, text: `Saved — ${res.saved} players${extra} assigned to teams.` });
  }
  function submitAi() {
    const t = aiText.trim(); if (!t) return;
    if (onAsk) onAsk(`For team building: ${t}`);
    setAiText("");
  }
  async function setupCoaches() {
    await api.coachSetup(); await loadCfg();
    setFlash({ ok: true, text: "Coaches section created. Add coaches (with each one’s child), then rebuild." });
  }

  // Drag-and-drop: a drop PROPOSES a move (it isn't applied until the user confirms).
  // The dragged player's whole keep-together unit moves, then we auto-shuffle other movable
  // players so the rules still hold: even team sizes, the all-star cap, locked groups stay
  // together, and a coach's child stays with their coach.
  function onDrop(targetIdx) {
    const id = dragId.current; dragId.current = null; setOver(-1);
    if (id == null || !editTeams) return;
    const plan = planMove(editTeams, id, targetIdx);
    if (plan) setPending(plan); // null = dropped on the same team, nothing to do
  }

  function planMove(prev, draggedId, targetIdx) {
    const teams = prev.map((t) => ({ name: t.name, coaches: t.coaches, players: t.players.map((p) => ({ ...p })) }));
    let srcIdx = -1, dragged = null;
    teams.forEach((t, i) => { const f = t.players.find((p) => p.id === draggedId); if (f) { dragged = f; srcIdx = i; } });
    if (!dragged || srcIdx === targetIdx) return null;
    const moveIds = new Set(teams.flatMap((t) => t.players).filter((p) => p.unit === dragged.unit).map((p) => p.id));
    const moved = [];
    for (const t of teams) t.players = t.players.filter((p) => { if (moveIds.has(p.id)) { moved.push(p); return false; } return true; });
    teams[targetIdx].players.push(...moved);
    const primary = moved.map((p) => ({ id: p.id, name: p.name, from: prev[srcIdx].name, to: teams[targetIdx].name }));
    const adjust = rebalance(teams, moveIds);
    return { teams, primary, adjust };
  }

  // Move other (movable) players to restore the rules after a manual move. A player is movable
  // only if they aren't a coach's child (pinned), aren't part of a multi-player locked unit, and
  // weren't the ones just dragged.
  function rebalance(teams, keepIds) {
    const moves = [];
    const stars = (t) => t.players.filter((p) => p.star).length;
    const unitSize = {};
    teams.flatMap((t) => t.players).forEach((p) => { unitSize[p.unit] = (unitSize[p.unit] || 0) + 1; });
    const movable = (t) => t.players.filter((p) => !p.pinned && (unitSize[p.unit] || 1) <= 1 && !keepIds.has(p.id));
    const move = (pid, fromI, toI) => {
      const k = teams[fromI].players.findIndex((p) => p.id === pid); if (k < 0) return;
      const [p] = teams[fromI].players.splice(k, 1); teams[toI].players.push(p);
      moves.push({ id: p.id, name: p.name, from: teams[fromI].name, to: teams[toI].name });
    };
    // 1) all-star cap: bleed excess all-stars off any over-cap team onto the team with the fewest
    if (cap && cap.max != null) {
      let g = 0;
      while (g++ < 300) {
        const over = teams.findIndex((t) => stars(t) > cap.max);
        if (over < 0) break;
        const s = movable(teams[over]).find((p) => p.star); if (!s) break;
        let tgt = -1;
        teams.forEach((t, i) => {
          if (i === over || stars(t) >= cap.max) return;
          if (tgt < 0 || stars(t) < stars(teams[tgt]) || (stars(t) === stars(teams[tgt]) && t.players.length < teams[tgt].players.length)) tgt = i;
        });
        if (tgt < 0) break;
        move(s.id, over, tgt);
      }
    }
    // 2) even team sizes (no team more than one ahead of the smallest)
    let g = 0;
    while (g++ < 600) {
      let big = 0, small = 0;
      teams.forEach((t, i) => { if (t.players.length > teams[big].players.length) big = i; if (t.players.length < teams[small].players.length) small = i; });
      if (teams[big].players.length - teams[small].players.length <= 1) break;
      const cands = movable(teams[big]).sort((a, b) => (a.star ? 1 : 0) - (b.star ? 1 : 0)); // move non-stars first
      let cand = cands[0];
      if (cap && cap.max != null && cand && cand.star && stars(teams[small]) >= cap.max) cand = cands.find((p) => !p.star) || null;
      if (!cand) break;
      move(cand.id, big, small);
    }
    return moves;
  }

  const scope = division ? players.filter((p) => (p.division || "") === division) : players;
  const evenCount = (n, target) => { let c = Math.max(2, Math.round(n / (target || 10)) || 2); if (c % 2) c++; return c; };
  const autoTeams = evenCount(scope.length, Number(targetSize) || 10);
  const teamOptions = [...new Set([Math.max(2, autoTeams - 2), autoTeams, autoTeams + 2])].filter((c) => c >= 2 && c <= Math.max(2, scope.length || 2));
  const selectedTeams = numTeams ? Number(numTeams) : autoTeams;
  const sizesArr = editTeams ? editTeams.map((t) => t.players.length) : [];
  const minSize = sizesArr.length ? Math.min(...sizesArr) : 0;
  const maxSize = sizesArr.length ? Math.max(...sizesArr) : 0;
  const totalPlayers = sizesArr.reduce((a, b) => a + b, 0);
  const ageAvgs = editTeams ? editTeams.map((t) => avg(t.players.map((p) => Number(p.age) || 0))) : [];
  const ageSpread = ageAvgs.length ? +(Math.max(...ageAvgs) - Math.min(...ageAvgs)).toFixed(1) : 0;
  const coachCount = editTeams ? editTeams.reduce((a, t) => a + ((t.coaches && t.coaches.length) || 0), 0) : 0;
  const sizesOff = editTeams ? editTeams.filter((t) => t.players.length < 8 || t.players.length > 12) : [];
  const starOverride = (t) => {
    // Returns array of unique reasons from units that contain all-stars on this team, if any.
    // Empty array means: no reasoning attached to the excess.
    if (!cap || !t) return [];
    const stars = t.players.filter((p) => p.star);
    if (stars.length <= cap.max) return [];
    const reasons = new Set();
    for (const p of stars) if (p.reason) reasons.add(p.reason);
    return [...reasons];
  };
  const starsOff = (editTeams && cap)
    ? editTeams.filter((t) => t.players.filter((p) => p.star).length > cap.max && starOverride(t).length === 0)
    : [];
  const starsOverride = (editTeams && cap)
    ? editTeams.filter((t) => t.players.filter((p) => p.star).length > cap.max && starOverride(t).length > 0)
    : [];
  const lowByTeam = editTeams ? editTeams.map((t) => t.players.filter((p) => p.low).length) : [];
  const anyLow = lowByTeam.some((n) => n > 0);
  const lowOff = anyLow && (Math.max(...lowByTeam) - Math.min(...lowByTeam) > 1);
  const warnCount = sizesOff.length + starsOff.length + (lowOff ? 1 : 0);

  // Link classification — coach pin / sibling / carpool — so the drag-and-drop UI surfaces
  // who NOT to move freely. Coach pins are flagged server-side via p.pinned. Carpools come in
  // as p.group (the named link_group). Siblings are inferred from a same-unit pair that has no
  // explicit group AND shares a last name (the __siblings__ keep_together rule's footprint).
  const lastNameOf = (s) => {
    const parts = String(s || "").trim().split(/\s+/);
    return (parts.length > 1 ? parts[parts.length - 1] : "").toLowerCase();
  };
  const linkInfo = (() => {
    if (!editTeams) return { byId: new Map(), unitKind: new Map() };
    const unitMembers = new Map();
    for (const t of editTeams) for (const p of t.players) {
      const arr = unitMembers.get(p.unit) || [];
      arr.push(p); unitMembers.set(p.unit, arr);
    }
    const unitKind = new Map();
    for (const [u, members] of unitMembers.entries()) {
      if (members.length < 2) { unitKind.set(u, null); continue; }
      const grp = members.find((m) => m.group)?.group;
      if (grp) { unitKind.set(u, { kind: "carpool", label: grp }); continue; }
      // No named group — siblings inferred when 2+ share last name in the unit.
      const counts = {};
      for (const m of members) { const ln = lastNameOf(m.name); if (ln) counts[ln] = (counts[ln] || 0) + 1; }
      const sibLn = Object.keys(counts).find((k) => counts[k] >= 2);
      if (sibLn) unitKind.set(u, { kind: "sibling", label: sibLn[0].toUpperCase() + sibLn.slice(1) });
      else unitKind.set(u, { kind: "linked", label: "linked" });
    }
    return { unitMembers, unitKind };
  })();
  const linkKindFor = (p) => {
    // Explicit links (from the new player_links table) take precedence over inferred unit kinds.
    if (Array.isArray(p.linkKinds) && p.linkKinds.length) {
      // For the primary chip, prefer a positive kind so we don't hide positive bonds behind a DNL.
      const primary = p.linkKinds.find((k) => k.kind !== "do_not_link") || p.linkKinds[0];
      const labelMap = { sibling: "sibling", coach_player: "coach link", carpool: "carpool", do_not_link: "do-not-link" };
      return { kind: primary.kind, label: primary.reason || labelMap[primary.kind] || primary.kind, allKinds: p.linkKinds };
    }
    if (p.pinned) return { kind: "coach", label: "coach pin" };
    return linkInfo.unitKind?.get(p.unit) || null;
  };
  const teamLinkedCount = (t) => t.players.reduce((n, p) => n + (linkKindFor(p) ? 1 : 0), 0);

  return (
    <div>
      <div className="page-head"><h1>Teams</h1>
        <div className="muted">Build balanced teams from your rules, then fine-tune by dragging players between teams.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}


      {/* Build controls */}
      <div className="card">
        <div className="row">
          <div>
            <label className="fld">League</label>
            <select value={league} onChange={(e) => { setLeague(e.target.value); setDivision(""); setNumTeams(""); setEditTeams(null); setSaved(false); }}>
              {cfg.leagues.length ? cfg.leagues.map((l) => <option key={l} value={l}>{l}</option>) : <option value="">(all players)</option>}
            </select>
          </div>
          <div>
            <label className="fld">Division</label>
            <select value={division} onChange={(e) => { setDivision(e.target.value); setNumTeams(""); setEditTeams(null); setSaved(false); }}>
              <option value="">(all divisions)</option>
              {divisions.filter((d) => !league || d.league === league).map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </select>
          </div>
        </div>

        <label className="fld" style={{ marginTop: 12 }}>How should we split {scope.length ? `these ${scope.length}` : "the"} players into teams?</label>
        <div className="btn-row" style={{ flexWrap: "wrap" }}>
          {teamOptions.map((c) => (
            <button key={c} className={"btn" + (selectedTeams === c ? " primary" : "")} onClick={() => setNumTeams(c)}>
              {c} teams <span style={{ opacity: 0.7 }}>· ~{Math.max(1, Math.round((scope.length || 0) / c))} each</span>
            </button>
          ))}
          <button className="btn ghost sm" onClick={() => setAdvanced((a) => !a)}>{advanced ? "Hide size options" : "More options"}</button>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          Aim for 8–12 per team. Siblings and linked players stay together, each coach’s child stays with their coach, and all-stars are spread evenly.
        </div>

        {advanced && (
          <div className="row" style={{ marginTop: 12 }}>
            <div>
              <label className="fld">Target team size</label>
              <input type="number" min={4} max={20} value={targetSize}
                onChange={(e) => { setTargetSize(Math.max(1, Number(e.target.value) || 10)); setNumTeams(""); }} />
            </div>
            <div>
              <label className="fld">Number of teams</label>
              <input type="number" min={2} step={2} value={numTeams} placeholder={`auto — ${autoTeams}`}
                onChange={(e) => setNumTeams(e.target.value === "" ? "" : Math.max(2, Number(e.target.value) || 2))} />
            </div>
          </div>
        )}

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={doPreview} disabled={busy}>{busy ? "Building…" : (editTeams ? "Rebuild teams" : "Build teams")}</button>
        </div>
      </div>

      {onAsk && (
        <div className="aibox">
          <div className="aibox-head"><span className="ai-badge">S-Dot</span> Build or adjust teams with S-Dot</div>
          <p className="muted small">Tell S-Dot what you want in plain English — it drafts the change and you confirm before anything is saved.</p>
          <div className="aibar">
            <input placeholder="e.g. put two players on the same team, or even out a team that is too big" value={aiText}
              onChange={(e) => setAiText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitAi(); }} />
            <button className="btn primary" onClick={submitAi}>Ask S-Dot</button>
          </div>
        </div>
      )}

      {editTeams && (
        <>
          <div className="card" style={{ marginTop: 14 }}>
            <div className="between" style={{ flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <h2 style={{ margin: 0 }}>Preview</h2>
                  {saved ? <span className="chip good">Saved</span> : <span className="chip brand">Not saved yet</span>}
                </div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  {editTeams.length} teams · {totalPlayers} players · {minSize}–{maxSize} per team · ages within ±{ageSpread}{coachCount ? ` · ${coachCount} coaches` : ""} · {warnCount ? `${warnCount} to review` : "looks balanced"}
                </div>
              </div>
              <div className="btn-row">
                <button className="btn primary" onClick={doSave}>{saved ? "Save again" : "Save these teams"}</button>
                <button className="btn ghost" onClick={() => { setEditTeams(null); setSaved(false); setFlash(null); }}>Discard</button>
              </div>
            </div>
          </div>

          {saved && (
            <div className="note good" style={{ marginTop: 12 }}>
              Saved. Tweak them on the <a onClick={() => go({ page: "teambuilder", tab: "editor" })}>Team Editor</a> tab, or see them under <a onClick={() => go({ page: "people" })}>Players &amp; Coaches</a>.
            </div>
          )}

          {sizesOff.length > 0 && (
            <div className="note warn" style={{ marginTop: 12 }}>
              {sizesOff.length} team{sizesOff.length !== 1 ? "s" : ""} fall outside the recommended 8–12 players (sizes: {editTeams.map((t) => t.players.length).join(", ")}). Adjust the target size or number of teams, or drag players to even them out.
            </div>
          )}
          {starsOff.length > 0 && (
            <div className="note warn" style={{ marginTop: 12 }}>
              {starsOff.length} team{starsOff.length !== 1 ? "s" : ""} have more than {cap.max} all-star{cap.max !== 1 ? "s" : ""}. Drag all-stars to other teams to even them out.
            </div>
          )}
          {lowOff && (
            <div className="note warn" style={{ marginTop: 12 }}>
              Low-attendance players are spread unevenly (per team: {lowByTeam.join(", ")}). Rebuild to even them out so no team is short on reliable bodies.
            </div>
          )}
          {linkConflicts.length > 0 && (
            <div className="note warn" style={{ marginTop: 12, borderColor: "#dc2626" }}>
              {linkConflicts.length} do-not-link conflict{linkConflicts.length !== 1 ? "s" : ""}: players who should NOT share a team are currently together. Drag one to a different team to resolve.
              <ul style={{ margin: "6px 0 0 18px" }}>
                {linkConflicts.slice(0, 6).map((c, i) => <li key={i} className="small">Team {c.team || "?"}: players #{c.players.join(" + #")}</li>)}
              </ul>
            </div>
          )}
          <div className="muted small" style={{ margin: "8px 2px" }}>Drag a player to move them. Linked players move together; other teams auto-rebalance to keep the rules, and you confirm before it applies.</div>
          <div className="link-legend">
            <span><span className="sw coach" />Coach pin — child stays with coach</span>
            <span><span className="sw sib" />Sibling group</span>
            <span><span className="sw carpool" />Carpool / linked group</span>
            <span><span className="sw low" />Low attendance</span>
            <span><span className="sw" style={{ background: "#fee2e2", borderColor: "#dc2626" }} />Do-not-link</span>
          </div>
          <div className="team-grid">
            {editTeams.map((t, idx) => (
              <div key={t.name}
                className={"card team-col" + (over === idx ? " over" : "")}
                onDragOver={(e) => { e.preventDefault(); setOver(idx); }}
                onDragLeave={() => setOver((o) => (o === idx ? -1 : o))}
                onDrop={() => onDrop(idx)}>
                <div className="between">
                  <h3 style={{ margin: 0 }}>{t.name}</h3>
                  <div className="btn-row" style={{ gap: 6 }}>
                    {cap && t.players.some((p) => p.star) && (() => { const s = t.players.filter((p) => p.star).length; return <span className={"chip" + (s > cap.max ? " brand" : "")}>{s} all-star{s !== 1 ? "s" : ""}</span>; })()}
                    {cap && (() => {
                      const ov = starOverride(t);
                      if (!ov.length) return null;
                      return <span className="chip" title="Cap exceeded with admin override" style={{ marginLeft: 6 }}>Override: {ov.join(" · ")}</span>;
                    })()}
                    {t.players.some((p) => p.low) && <span className="chip" title="low-attendance players">{t.players.filter((p) => p.low).length} low</span>}
                    {teamLinkedCount(t) > 0 && <span className="chip" title="Players with coach / sibling / carpool links — don't move freely">{teamLinkedCount(t)} linked</span>}
                    <span className="chip">{t.players.length} · avg {avg(t.players.map((p) => Number(p.age) || 0))}</span>
                  </div>
                </div>
                {t.coaches && t.coaches.length > 0 && (
                  <div className="coach-row">
                    {t.coaches.map((c) => (
                      <span className="coachpill" key={c.id} title={c.role || "Coach"}>{c.name}{/head/i.test(c.role) ? " · Head" : c.role ? " · Asst" : ""}</span>
                    ))}
                  </div>
                )}
                <div className="stack" style={{ marginTop: 8 }}>
                  {t.players.map((p) => {
                    const lk = linkKindFor(p);
                    const itemCls = "drag-item"
                      + (p.group ? " linked" : "")
                      + (lk?.kind === "coach" ? " is-pinned" : "")
                      + (lk?.kind === "sibling" ? " is-sibling" : "");
                    const lkTitle = lk?.kind === "coach"
                      ? "Coach's child — stays with coach"
                      : lk?.kind === "sibling"
                      ? `Sibling group (${lk.label})`
                      : lk?.kind === "carpool"
                      ? `Carpool / linked: ${lk.label}`
                      : "";
                    return (
                      <div key={p.id} className={itemCls} draggable
                        onDragStart={() => { dragId.current = p.id; }}
                        title={lkTitle}>
                        <span>
                          <span>
                            {p.name}
                            {lk?.kind === "coach" && <span className="pinpill" title="Coach's child">coach</span>}
                            {lk?.kind === "sibling" && <span className="sibpill" title={`Siblings — ${lk.label}`}>sibling</span>}
                            {p.group ? <span className="linkpill">{p.group}</span> : null}
                            {p.star ? <span className="starpill">all-star</span> : null}
                            {p.low ? <span className="lowpill" title="Low attendance">low att</span> : null}
                            {Array.isArray(p.linkKinds) && p.linkKinds.some((k) => k.kind === "do_not_link") && (
                              <span style={{ display: "inline-block", fontSize: 10, fontWeight: 700, color: "#fff", background: "#dc2626", border: "1px solid #dc2626", borderRadius: 999, padding: "0 6px", marginLeft: 6 }} title="Has a do-not-link constraint">DNL</span>
                            )}
                          </span>
                          {p.reason ? <div className="muted" style={{ fontSize: 11, lineHeight: 1.2 }}>{p.reason}</div> : null}
                        </span>
                        <span className="muted">{p.age ?? ""}</span>
                      </div>
                    );
                  })}
                  {!t.players.length && <div className="muted small">drop players here</div>}
                </div>
              </div>
            ))}
          </div>

          {pending && (
            <div className="overlay" onClick={() => setPending(null)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2 style={{ marginBottom: 4 }}>Confirm move</h2>
                <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                  {pending.primary.map((m) => (
                    <div key={m.id} className="small"><b>{m.name}</b>: {m.from} → <b>{m.to}</b></div>
                  ))}
                </div>
                {pending.adjust.length > 0 ? (
                  <>
                    <div className="muted small" style={{ margin: "12px 0 4px" }}>To keep teams even and within the rules, these also move:</div>
                    <div className="stack" style={{ gap: 6 }}>
                      {pending.adjust.map((m) => (
                        <div key={m.id} className="small">{m.name}: {m.from} → {m.to}</div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="muted small" style={{ marginTop: 10 }}>No other players need to move.</div>
                )}
                <div className="btn-row" style={{ marginTop: 16 }}>
                  <button className="btn primary" onClick={() => { setEditTeams(pending.teams); setPending(null); setSaved(false); setFlash({ ok: true, text: "Move applied." }); }}>Apply move</button>
                  <button className="btn" onClick={() => setPending(null)}>Cancel</button>
                </div>
              </div>
            </div>
          )}
          {confirmSave && (
            <div className="overlay" onClick={() => setConfirmSave(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <h2 style={{ marginBottom: 4 }}>Save these teams?</h2>
                <div className="muted small">This assigns {totalPlayers} players across {editTeams.length} teams{coachCount ? ` and ${coachCount} coaches` : ""}{league ? ` in ${league}` : ""}, replacing any earlier team assignments for them. You can rebuild or drag players to adjust anytime.</div>
                <div className="stack" style={{ gap: 4, marginTop: 10, maxHeight: 220, overflow: "auto" }}>
                  {editTeams.map((t) => (
                    <div key={t.name} className="small">{t.name}: <b>{t.players.length}</b> player{t.players.length !== 1 ? "s" : ""}{t.coaches && t.coaches.length ? ` · ${t.coaches.length} coach${t.coaches.length > 1 ? "es" : ""}` : ""}</div>
                  ))}
                </div>
                <div className="btn-row" style={{ marginTop: 14 }}>
                  <button className="btn primary" onClick={commitSave}>Save teams</button>
                  <button className="btn" onClick={() => setConfirmSave(false)}>Cancel</button>
                </div>
              </div>
            </div>
          )}
          {cfg.hasCoach ? (
            <div className="muted small" style={{ marginTop: 12 }}>
              Coaches are placed automatically — each coach’s child stays on their team and coaches are spread evenly.
              <a onClick={() => go({ page: "section", type: "coach" })}> Add or edit coaches</a>.
            </div>
          ) : (
            <div className="note info" style={{ marginTop: 14 }}>
              Want coaches on these teams? <button className="btn sm" onClick={setupCoaches}>Set up coaches</button> — then the builder keeps each coach’s child on their team and spreads coaches evenly.
            </div>
          )}
        </>
      )}
    </div>
  );
}
