"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";

const parse = (s) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
function groupsOf(players) {
  const g = {};
  for (const p of players) {
    if (!p.link_group) continue;
    const e = (g[p.link_group] = g[p.link_group] || { members: [], reason: "" });
    e.members.push(p);
    if (p.link_reason && !e.reason) e.reason = p.link_reason;
  }
  return g;
}

const ICON_KT = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><line x1="8" y1="12" x2="16" y2="12" />
  </svg>
);
const ICON_BAL = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" />
    <line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
    <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
  </svg>
);
const ICON_COACH = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const ICON_STAR = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);
const ruleMeta = (type) => type === "balance"
  ? { cls: "bal", ico: ICON_BAL, ty: "Spreads this number evenly across teams" }
  : type === "coach_child"
  ? { cls: "bal", ico: ICON_COACH, ty: "Keeps each coach's child on their team (admin toggle)" }
  : type === "cap"
  ? { cls: "bal", ico: ICON_STAR, ty: "Spreads all-stars evenly so no team is stacked" }
  : { cls: "kt", ico: ICON_KT, ty: "Keeps matching players on the same team" };

// Per-kind colors for the new player-links card. Inline so we don't add a new CSS file.
const LINK_KIND_META = {
  sibling:      { label: "Sibling",       bg: "#ccfbf1", fg: "#0f766e", border: "#0d9488" },
  coach_player: { label: "Coach link",    bg: "#dbeafe", fg: "#1e3a8a", border: "#1d4ed8" },
  carpool:      { label: "Carpool",       bg: "#fef3c7", fg: "#92400e", border: "#d97706" },
  do_not_link:  { label: "Do-not-link",   bg: "#fee2e2", fg: "#991b1b", border: "#dc2626" },
};
const LINK_KIND_OPTIONS = [
  { key: "sibling",      label: "Sibling" },
  { key: "coach_player", label: "Coach to player" },
  { key: "carpool",      label: "Carpool" },
  { key: "do_not_link",  label: "Do-not-link" },
];

// Team-builder settings (build rules + linked players). Lives on Leagues & Assignment.
export default function TeamSettings({ onAsk }) {
  const [cfg, setCfg] = useState(null);
  const [players, setPlayers] = useState([]);
  const [flash, setFlash] = useState(null);
  const [aiRule, setAiRule] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupReason, setGroupReason] = useState("");
  const [search, setSearch] = useState("");
  const [starMax, setStarMax] = useState(2);

  // ----- new generalized player-link UI state -----
  const [links, setLinks] = useState([]);
  const [coaches, setCoaches] = useState([]);
  const [newKind, setNewKind] = useState("carpool");
  const [newReason, setNewReason] = useState("");
  const [newPlayerIds, setNewPlayerIds] = useState([]); // numbers
  const [newCoachIds, setNewCoachIds] = useState([]);   // numbers (coach_player only)
  const [pickerSearch, setPickerSearch] = useState("");

  async function load() {
    const c = await api.teamConfig();
    setCfg(c);
    const cr = (c.rules || []).find((x) => x.type === "cap");
    if (cr && cr.max) setStarMax(Number(cr.max));
    const r = await api.records("player");
    setPlayers((r.records || []).map((x) => ({ id: x.id, ...parse(x.data), name: x.name || parse(x.data).full_name || `#${x.id}` })));
    // Generalized link table + coaches for the picker (best effort — silent on error).
    try {
      const lr = await api.linksList();
      setLinks(lr && lr.links ? lr.links : []);
    } catch { setLinks([]); }
    try {
      const cr2 = await api.records("coach");
      setCoaches((cr2.records || []).map((x) => ({ id: x.id, name: x.name || parse(x.data).full_name || `#${x.id}` })));
    } catch { setCoaches([]); }
  }
  useEffect(() => { load(); }, []);
  if (!cfg || cfg.error) return null;

  // Member-picker helpers for the new link card
  function togglePlayerPick(id) {
    const n = Number(id);
    setNewPlayerIds((arr) => arr.includes(n) ? arr.filter((x) => x !== n) : [...arr, n]);
  }
  function toggleCoachPick(id) {
    const n = Number(id);
    // coach_player allows only one coach for clarity; treat selecting another as replacing.
    setNewCoachIds((arr) => arr.includes(n) ? arr.filter((x) => x !== n) : [n]);
  }
  function resetLinkDraft() { setNewReason(""); setNewPlayerIds([]); setNewCoachIds([]); setPickerSearch(""); }
  async function createNewLink() {
    if (newKind === "do_not_link" && newPlayerIds.length < 2) return setFlash({ ok: false, text: "Pick at least 2 players for a do-not-link." });
    if (newKind === "coach_player" && (newCoachIds.length < 1 || newPlayerIds.length < 1)) return setFlash({ ok: false, text: "Pick a coach and at least one player." });
    if ((newKind === "sibling" || newKind === "carpool") && newPlayerIds.length < 2) return setFlash({ ok: false, text: `Pick at least 2 players for a ${newKind} link.` });
    const res = await api.linkCreate({ kind: newKind, playerIds: newPlayerIds, coachIds: newCoachIds, reason: newReason.trim() });
    if (res.error) return setFlash({ ok: false, text: res.error });
    resetLinkDraft();
    await load();
    setFlash({ ok: true, text: `Created ${LINK_KIND_META[newKind]?.label || newKind} link.` });
  }
  async function dropLink(link_id) {
    await api.linkDelete(link_id);
    await load();
    setFlash({ ok: true, text: "Link removed." });
  }
  async function dropMember(link_id, member) {
    await api.linkRemoveMember(link_id, member);
    await load();
  }
  async function saveReason(link_id, reason) {
    await api.linkSetReason(link_id, reason);
    await load();
  }

  async function applyCap() {
    const res = await api.setAllStarCap(starMax);
    setFlash({ ok: true, text: `All-stars limited to ${res.max} per team. Mark strong players as All-Star on their player page.` });
    await load();
  }

  function submitAiRule() {
    const t = aiRule.trim();
    if (!t) return;
    if (onAsk) onAsk(`For team building: ${t}`);
    setAiRule("");
  }
  async function addToGroup(id) {
    const g = groupName.trim();
    if (!g) return setFlash({ ok: false, text: "Name the group first (e.g. Carpool A)." });
    await api.linkPlayers([id], g, groupReason.trim() || undefined);
    setSearch(""); await load();
    setFlash({ ok: true, text: `Added to “${g}” — they’ll be kept on the same team.` });
  }
  async function unlink(id) { await api.unlinkPlayer(id); await load(); }

  const matches = (p) => p.name.toLowerCase().includes(search.trim().toLowerCase());
  const groups = groupsOf(players);

  return (
    <>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      {/* AI at the top — link players or suggest a build rule */}
      <div className="aibox">
        <div className="aibox-head"><span className="ai-badge">S-Dot</span> Link players or add a rule</div>
        <p className="muted small">Describe what you want in plain English — keep certain players together, or add a build rule — and S-Dot drafts it for you to confirm.</p>
        <div className="aibar">
          <input placeholder="e.g. keep Mia and Eli together, or cap all-stars at 2 per team" value={aiRule}
            onChange={(e) => setAiRule(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitAiRule(); }} />
          <button className="btn primary" onClick={submitAiRule}>Ask S-Dot</button>
        </div>
      </div>

      {/* Build rules — 2-column grid so they're all visible at a glance */}
      <div className="card">
        <div className="between"><h2 style={{ margin: 0 }}>Team build rules</h2><span className="chip">{cfg.rules.length}</span></div>
        <p className="muted small">Used by the Team Builder. Keep-together keeps matching players on one team; balance spreads a number evenly. Toggle off to pause a rule, or delete it.</p>
        <div className="rule-grid">
          {cfg.rules.map((r) => {
            const m = ruleMeta(r.type);
            return (
              <div className={"rule-row" + (r.active ? "" : " off")} key={r.id}>
                <div className={"rule-ico " + m.cls}>{m.ico}</div>
                <div className="rule-main">
                  <div className="nm">{r.name}</div>
                  <div className="ty">{r.active ? m.ty : "Turned off"}</div>
                </div>
                <button className={"switch" + (r.active ? " on" : "")} aria-label={r.active ? "On" : "Off"}
                  title={r.active ? "On — click to turn off" : "Off — click to turn on"}
                  onClick={async () => { await api.teamToggleRule(r.id, !r.active); load(); }} />
                <button className="btn ghost sm" onClick={async () => { await api.teamDelRule(r.id); load(); }}>Delete</button>
              </div>
            );
          })}
          {!cfg.rules.length && <div className="muted small" style={{ marginTop: 4 }}>No rules yet — add one with S-Dot above.</div>}
        </div>
      </div>

      {/* All-star limit — its own card */}
      <div className="card">
        <h2>All-star limit</h2>
        <p className="muted small">Mark strong players as <b>All-Star</b> on their player page, then cap how many can land on one team — the builder spreads them out so no team gets stacked.</p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: "0 0 170px" }}>
            <label className="fld">Max all-stars per team</label>
            <input type="number" min={1} max={10} value={starMax} onChange={(e) => setStarMax(Math.max(1, Number(e.target.value) || 1))} />
          </div>
          <button className="btn" style={{ flex: "0 0 auto" }} onClick={applyCap}>Apply limit</button>
        </div>
      </div>

      <div className="card">
        <h2>Linked players (keep together)</h2>
        <p className="muted small">Players in the same group always end up on the same team.</p>

        {Object.entries(groups).map(([g, info]) => (
          <div className="group-box" key={g}>
            <div className="gh">{g}<span className="chip accent">{info.members.length}</span>
              {info.reason ? <span className="chip" style={{ marginLeft: 6 }} title="Override reason">{info.reason}</span> : null}
            </div>
            <div>
              {info.members.map((p) => (
                <span className="member" key={p.id}>
                  {p.name}
                  <button className="x" title="Remove from group" onClick={() => unlink(p.id)}>×</button>
                </span>
              ))}
            </div>
            <div className="row" style={{ marginTop: 6, alignItems: "center", gap: 6 }}>
              <input
                defaultValue={info.reason}
                placeholder="Reason (e.g. Carpool — Smith family)"
                onBlur={async (e) => {
                  const v = e.target.value.trim();
                  if (v === (info.reason || "")) return;
                  await api.setLinkReason(g, v);
                  await load();
                  setFlash({ ok: true, text: `Reason saved for “${g}”.` });
                }}
                style={{ flex: 1 }}
              />
              <span className="muted small">Press Tab to save</span>
            </div>
          </div>
        ))}
        {!Object.keys(groups).length && <div className="muted small" style={{ marginTop: 6 }}>No groups yet.</div>}

        <div className="subpanel">
          <div className="subpanel-head">Add players to a group</div>
          <label className="fld">Group name</label>
          <input placeholder="e.g. Carpool A" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          <label className="fld">Reason (optional — shown as override note)</label>
          <input placeholder="e.g. Carpool — Smith family, coach pre-arrangement"
            value={groupReason} onChange={(e) => setGroupReason(e.target.value)} />
          <label className="fld">Find a player to add</label>
          <input placeholder="Type a name…" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search.trim() && (
            <div className="find-results">
              {players.filter(matches).slice(0, 8).map((p) => (
                <div className="between" key={p.id}>
                  <span className="small">{p.name} {p.link_group ? <span className="linkpill">{p.link_group}</span> : null}</span>
                  <button className="btn sm" onClick={() => addToGroup(p.id)}>Add</button>
                </div>
              ))}
              {!players.filter(matches).length && <div className="between"><span className="muted small">No matches.</span></div>}
            </div>
          )}
        </div>
      </div>

      {/* New generalized player-link card — typed links (sibling / coach-player / carpool / do-not-link). */}
      {/* The legacy "Linked players (keep together)" card above continues to work — links live in a */}
      {/* separate table and the builder honors both. */}
      <div className="card">
        <div className="between">
          <h2 style={{ margin: 0 }}>Player links (new)</h2>
          <span className="chip">{links.length}</span>
        </div>
        <p className="muted small">Typed links between players (and coaches). Positive kinds keep players on the same team; do-not-link forces them apart.</p>

        {/* Existing links, grouped by kind */}
        {LINK_KIND_OPTIONS.map((ko) => {
          const m = LINK_KIND_META[ko.key];
          const groupLinks = links.filter((l) => l.kind === ko.key);
          if (!groupLinks.length) return null;
          return (
            <div key={ko.key} style={{ marginTop: 10 }}>
              <div className="small" style={{ marginBottom: 4, fontWeight: 600, color: m.fg }}>{m.label} ({groupLinks.length})</div>
              {groupLinks.map((g) => (
                <div className="group-box" key={g.link_id}>
                  <div className="gh">
                    <span style={{ display: "inline-block", fontSize: 10, fontWeight: 700, color: m.fg, background: m.bg, border: `1px solid ${m.border}`, borderRadius: 999, padding: "1px 8px", marginRight: 8 }}>{m.label}</span>
                    {g.coachNames && g.coachNames.length > 0 && (
                      <span style={{ marginRight: 8 }}>
                        {g.coachNames.map((c) => (
                          <span className="member" key={"c" + c.id} title="Coach">
                            <b>coach:</b> {c.name}
                            <button className="x" title="Remove coach from link" onClick={() => dropMember(g.link_id, { coachId: c.id })}>×</button>
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                  <div>
                    {g.playerNames.map((p) => (
                      <span className="member" key={p.id}>
                        {p.name}
                        <button className="x" title="Remove from link" onClick={() => dropMember(g.link_id, { playerId: p.id })}>×</button>
                      </span>
                    ))}
                  </div>
                  <div className="row" style={{ marginTop: 6, alignItems: "center", gap: 6 }}>
                    <input
                      defaultValue={g.reason || ""}
                      placeholder="Reason (optional)"
                      onBlur={async (e) => {
                        const v = e.target.value.trim();
                        if (v === (g.reason || "")) return;
                        await saveReason(g.link_id, v);
                      }}
                      style={{ flex: 1 }}
                    />
                    <button className="btn ghost sm" onClick={() => dropLink(g.link_id)}>Delete</button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
        {!links.length && <div className="muted small" style={{ marginTop: 6 }}>No links yet.</div>}

        {/* New-link composer */}
        <div className="subpanel">
          <div className="subpanel-head">Create a link</div>
          <label className="fld">Kind</label>
          <div className="btn-row" style={{ flexWrap: "wrap" }}>
            {LINK_KIND_OPTIONS.map((ko) => {
              const m = LINK_KIND_META[ko.key];
              const active = newKind === ko.key;
              return (
                <button
                  key={ko.key}
                  className={"btn" + (active ? " primary" : "")}
                  onClick={() => { setNewKind(ko.key); if (ko.key !== "coach_player") setNewCoachIds([]); }}
                  style={active ? { background: m.bg, color: m.fg, borderColor: m.border } : undefined}
                >{ko.label}</button>
              );
            })}
          </div>

          {newKind === "coach_player" && (
            <>
              <label className="fld" style={{ marginTop: 10 }}>Coach (pick one)</label>
              <div className="find-results" style={{ maxHeight: 140, overflow: "auto" }}>
                {coaches.length === 0 && <div className="between"><span className="muted small">No coaches yet — add them on the Coaches page.</span></div>}
                {coaches.map((c) => (
                  <div className="between" key={c.id}>
                    <span className="small">
                      <input type="checkbox" checked={newCoachIds.includes(c.id)} onChange={() => toggleCoachPick(c.id)} style={{ marginRight: 6 }} />
                      {c.name}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <label className="fld" style={{ marginTop: 10 }}>Players</label>
          <input placeholder="Search players…" value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} />
          <div className="find-results" style={{ maxHeight: 220, overflow: "auto" }}>
            {players
              .filter((p) => !pickerSearch.trim() || p.name.toLowerCase().includes(pickerSearch.trim().toLowerCase()))
              .slice(0, 50)
              .map((p) => (
                <div className="between" key={p.id}>
                  <span className="small">
                    <input type="checkbox" checked={newPlayerIds.includes(p.id)} onChange={() => togglePlayerPick(p.id)} style={{ marginRight: 6 }} />
                    {p.name}
                  </span>
                </div>
              ))}
            {!players.length && <div className="between"><span className="muted small">No players yet.</span></div>}
          </div>
          {newPlayerIds.length > 0 && (
            <div className="small" style={{ marginTop: 6 }}>
              Selected: {newPlayerIds.map((id) => players.find((p) => p.id === id)?.name || `#${id}`).join(", ")}
            </div>
          )}

          <label className="fld" style={{ marginTop: 10 }}>Reason (optional)</label>
          <input placeholder="e.g. cousins / parental request / classroom conflict"
            value={newReason} onChange={(e) => setNewReason(e.target.value)} />

          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={createNewLink}>Create link</button>
            <button className="btn ghost sm" onClick={resetLinkDraft}>Reset</button>
          </div>
        </div>
      </div>
    </>
  );
}
