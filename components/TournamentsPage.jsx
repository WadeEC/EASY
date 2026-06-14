"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import { buildRounds, recompute, scheduleRounds, champion, roundName, winnerOf } from "@/lib/bracket.js";
import { refBusyAt } from "@/lib/conflicts.js";

const isBye = (m) => m.home === "(bye)" || m.away === "(bye)";
const decidable = (m) => !!(m.home && m.away && !isBye(m));
const refsOfMatch = (m) => String(m && m.ref ? m.ref : "").split(",").map((s) => s.trim()).filter(Boolean);
const clone = (x) => JSON.parse(JSON.stringify(x));
const fmtDate = (iso) => { if (!iso) return ""; const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso); return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }); };
const slug = (s) => String(s || "tournament").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tournament";

function parseTour(rec) {
  let f = {}; try { f = JSON.parse(rec.data || "{}"); } catch {}
  let st = {}; try { st = JSON.parse(f.state || "{}"); } catch {}
  if (!Array.isArray(st.rounds)) st.rounds = [];
  return { id: rec.id, name: rec.name || f.name || "Tournament", date: f.date || st.date || "", st };
}
function flatGames(st) {
  const out = [];
  (st.rounds || []).forEach((rd, r) => rd.forEach((m, i) => { if (isBye(m)) return; out.push({ id: `${r}-${i}`, date: st.date || "T", time: m.time, referee: m.ref, home: m.home, away: m.away, location: m.field }); }));
  return out;
}
function gameList(st) {
  const out = [];
  (st.rounds || []).forEach((rd) => rd.forEach((m) => { if (isBye(m) || !m.time) return; out.push({ round: roundName(rd.length), time: m.time, field: m.field || "", home: m.home || "TBD", away: m.away || "TBD", ref: m.ref || "", score: m.score || "" }); }));
  return out;
}
function csvOf(st) {
  const esc = (c) => { const s = String(c == null ? "" : c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [["Round", "Time", "Field", "Home", "Away", "Referees", "Score"], ...gameList(st).map((g) => [g.round, g.time, g.field, g.home, g.away, g.ref, g.score])];
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}
function htmlOf(name, st) {
  const champ = champion(st.rounds);
  const body = gameList(st).map((g) => `<tr><td>${g.round}</td><td>${g.time}</td><td>${g.field}</td><td>${g.home}</td><td>${g.away}</td><td>${g.ref}</td><td>${g.score}</td></tr>`).join("");
  return `<h3>${name}${st.date ? ` &mdash; ${fmtDate(st.date)}` : ""}</h3>${champ ? `<p><b>Champion:</b> ${champ}</p>` : ""}<table border="1" cellpadding="6" cellspacing="0"><thead><tr><th>Round</th><th>Time</th><th>Field</th><th>Home</th><th>Away</th><th>Referees</th><th>Score</th></tr></thead><tbody>${body}</tbody></table>`;
}
function download(name, text, mime) { const b = new Blob([text], { type: mime }); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); }

export default function TournamentsPage() {
  const [list, setList] = useState([]);
  const [cfg, setCfg] = useState({ allTeams: [] });
  const [refs, setRefs] = useState([]);
  const [cur, setCur] = useState(null);
  const [flash, setFlash] = useState(null);
  const [mode, setMode] = useState("list");   // "list" | "create" | "manage"
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  // shared editor state (used by create + manage setup)
  const [nName, setNName] = useState("");
  const [nDate, setNDate] = useState("");
  const [seeds, setSeeds] = useState([]);
  const [guests, setGuests] = useState("");
  const [fields, setFields] = useState([]);
  const [fieldText, setFieldText] = useState("");
  const [startTime, setStartTime] = useState("09:00");
  const [slotMins, setSlotMins] = useState(45);
  const [roundGap, setRoundGap] = useState(15);

  async function load() {
    try { await api.ensureTournaments(); } catch {}
    try { const r = await api.records("tournament"); setList(r.records || []); } catch {}
    try { const c = await api.scheduleConfig(); setCfg(c || { allTeams: [] }); } catch {}
    try { const r = await api.records("referee"); setRefs((r.records || []).map((x) => x.name).filter(Boolean)); } catch {}
  }
  useEffect(() => { load(); }, []);

  function openTour(rec) { setCur(parseTour(rec)); setMode("manage"); setSetupOpen(false); setConfirmDel(false); }
  async function reopen(id) { const r = await api.records("tournament"); const rec = (r.records || []).find((x) => x.id === id); setList(r.records || []); if (rec) openTour(rec); }
  async function saveCur(nextSt) {
    const next = { ...cur, st: nextSt }; setCur(next);
    await api.updateRecord(cur.id, { name: cur.name, date: cur.date, state: JSON.stringify(nextSt) });
  }

  // editor helpers
  function addSeed(name) { const n = String(name).trim(); if (!n) return; setSeeds((s) => s.some((x) => x.toLowerCase() === n.toLowerCase()) ? s : [...s, n]); }
  function addGuests() { guests.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).forEach(addSeed); setGuests(""); }
  function moveSeed(i, dir) { setSeeds((s) => { const a = [...s]; const j = i + dir; if (j < 0 || j >= a.length) return a; const t = a[i]; a[i] = a[j]; a[j] = t; return a; }); }
  function removeSeed(i) { setSeeds((s) => s.filter((_, k) => k !== i)); }
  function randomize() { setSeeds((s) => { const a = [...s]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }); }
  function addFieldName() { const parts = fieldText.split(",").map((s) => s.trim()).filter(Boolean); if (!parts.length) return; setFields((prev) => [...prev, ...parts.filter((p) => !prev.some((x) => x.toLowerCase() === p.toLowerCase()))]); setFieldText(""); }

  function resetEditor() { setNName(""); setNDate(""); setSeeds([]); setGuests(""); setFields([]); setFieldText(""); setStartTime("09:00"); setSlotMins(45); setRoundGap(15); }
  function openCreate() { resetEditor(); setMode("create"); }
  function loadEditorFromCur() { const s = cur.st; setNName(cur.name); setNDate(cur.date || ""); setSeeds(s.teams || []); setFields(s.fields || []); setStartTime(s.startTime || "09:00"); setSlotMins(s.slotMins ?? 45); setRoundGap(s.roundGap ?? 15); setGuests(""); setFieldText(""); }

  async function createTournament() {
    if (seeds.length < 2) { setFlash({ ok: false, text: "Add at least two teams to make a bracket." }); return; }
    const rounds = scheduleRounds(buildRounds(seeds), fields, startTime, slotMins, roundGap);
    const st = { teams: seeds, fields, startTime, slotMins, roundGap, date: nDate, rounds };
    const name = nName.trim() || `Tournament (${seeds.length} teams)`;
    const res = await api.createRecord("tournament", { name, date: nDate, state: JSON.stringify(st) }, name);
    if (res && res.error) { setFlash({ ok: false, text: `Could not create the tournament: ${res.error}` }); return; }
    setFlash({ ok: true, text: `Created ${name}.` });
    await load();
    if (res && res.id) reopen(res.id);
    else { const r = await api.records("tournament"); const rec = (r.records || []).filter((x) => x.name === name).pop(); if (rec) openTour(rec); else setMode("list"); }
  }
  async function applyRebuild() {
    if (seeds.length < 2) { setFlash({ ok: false, text: "Add at least two teams." }); return; }
    const rounds = scheduleRounds(buildRounds(seeds), fields, startTime, slotMins, roundGap);
    const next = { teams: seeds, fields, startTime, slotMins, roundGap, date: nDate, rounds };
    setCur({ ...cur, name: nName.trim() || cur.name, date: nDate });
    await api.updateRecord(cur.id, { name: nName.trim() || cur.name, date: nDate, state: JSON.stringify(next) });
    setCur((c) => ({ ...c, st: next })); setSetupOpen(false); setFlash({ ok: true, text: "Bracket rebuilt." });
  }
  async function applyReschedule() {
    const rounds = scheduleRounds(clone(cur.st.rounds), fields, startTime, slotMins, roundGap);
    const next = { ...cur.st, fields, startTime, slotMins, roundGap, rounds };
    await saveCur(next); setSetupOpen(false); setFlash({ ok: true, text: "Times and fields updated (results kept)." });
  }
  async function delTour() { if (!confirmDel) { setFlash({ ok: false, text: "Tick confirm first." }); return; } await api.deleteRecord(cur.id); setCur(null); setMode("list"); await load(); setFlash({ ok: true, text: "Tournament removed." }); }

  // bracket actions
  async function setWinner(r, i, who) { const next = clone(cur.st); const m = next.rounds[r][i]; m.winner = m.winner === who ? null : who; recompute(next.rounds); await saveCur(next); }
  async function setScore(r, i, val) { const next = clone(cur.st); next.rounds[r][i].score = val; await saveCur(next); }
  async function addMatchRef(r, i, name) {
    if (!name) return;
    const m = cur.st.rounds[r][i];
    const clash = refBusyAt(flatGames(cur.st), name, cur.st.date || "T", m.time, `${r}-${i}`);
    if (clash) { setFlash({ ok: false, text: `${name} is already on ${clash.home} vs ${clash.away} at ${m.time}. A referee cannot be in two places at once.` }); return; }
    const next = clone(cur.st); next.rounds[r][i].ref = [...refsOfMatch(m), name].join(", "); await saveCur(next);
  }
  async function removeMatchRef(r, i, name) { const next = clone(cur.st); const m = next.rounds[r][i]; m.ref = refsOfMatch(m).filter((x) => x !== name).join(", "); await saveCur(next); }

  async function copyText(text, label) {
    try { await navigator.clipboard.writeText(text); setFlash({ ok: true, text: `${label} copied.` }); }
    catch { setFlash({ ok: false, text: "Could not copy automatically." }); }
  }

  // ---------- editor block (shared) ----------
  function Editor({ primaryLabel, onPrimary, extra }) {
    return (
      <div className="card">
        <div className="field-grid">
          <div><label className="fld">Tournament name</label><input value={nName} onChange={(e) => setNName(e.target.value)} placeholder="e.g. Summer Shootout" /></div>
          <div><label className="fld">Date</label><input type="date" value={nDate} onChange={(e) => setNDate(e.target.value)} /></div>
          <div><label className="fld">First game time</label><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></div>
          <div><label className="fld">Minutes per game slot</label><input type="number" min={5} step={5} value={slotMins} onChange={(e) => setSlotMins(Math.max(5, Number(e.target.value) || 0))} /></div>
          <div><label className="fld">Minutes between rounds</label><input type="number" min={0} step={5} value={roundGap} onChange={(e) => setRoundGap(Math.max(0, Number(e.target.value) || 0))} /></div>
        </div>

        <div style={{ marginTop: 14 }}>
          <label className="fld">Fields</label>
          <div className="aibar">
            <input placeholder="Add a field — e.g. Field 1…" value={fieldText} onChange={(e) => setFieldText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addFieldName(); }} />
            <button className="btn" onClick={addFieldName}>Add field</button>
          </div>
          {fields.length > 0 && <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap" }}>{fields.map((f) => <span className="member" key={f}>{f}<button className="x" onClick={() => setFields(fields.filter((x) => x !== f))}>×</button></span>)}</div>}
        </div>

        <div style={{ marginTop: 14 }}>
          <label className="fld">Teams &amp; seeds <span className="muted">(top of the list is seed 1)</span></label>
          {seeds.length > 0 ? (
            <div className="stack" style={{ gap: 6, marginBottom: 8 }}>
              {seeds.map((t, i) => (
                <div className="drag-item" key={t + i} style={{ cursor: "default" }}>
                  <span><b>#{i + 1}</b> &nbsp;{t}</span>
                  <span style={{ display: "flex", gap: 4 }}>
                    <button className="btn ghost sm" onClick={() => moveSeed(i, -1)} disabled={i === 0}>↑</button>
                    <button className="btn ghost sm" onClick={() => moveSeed(i, 1)} disabled={i === seeds.length - 1}>↓</button>
                    <button className="btn ghost sm" onClick={() => removeSeed(i)}>Remove</button>
                  </span>
                </div>
              ))}
            </div>
          ) : <div className="muted small" style={{ marginBottom: 8 }}>No teams yet. Add from your league below, or paste guest teams.</div>}
          <div className="btn-row" style={{ marginBottom: 8 }}>
            <button className="btn" onClick={randomize} disabled={seeds.length < 2}>Randomize draw</button>
          </div>
          <div style={{ marginBottom: 8 }}>
            <div className="muted small" style={{ marginBottom: 4 }}>Add from your teams:</div>
            {(() => {
              const groupedExisting = {};
              const groups = Object.entries(cfg.teamsByLeague || {});
              if (groups.length === 0 && (cfg.allTeams || []).length) {
                groupedExisting["All teams"] = (cfg.allTeams || []).filter((t) => !seeds.some((s) => s.toLowerCase() === String(t).toLowerCase()));
              } else {
                for (const [lg, teams] of groups) {
                  const remaining = (teams || []).filter((t) => !seeds.some((s) => s.toLowerCase() === String(t).toLowerCase()));
                  if (remaining.length) groupedExisting[lg] = remaining;
                }
              }
              const keys = Object.keys(groupedExisting);
              if (!keys.length) return <div className="muted small">All teams already added as seeds.</div>;
              return (
                <div className="stack" style={{ gap: 10 }}>
                  {keys.map((lg) => (
                    <div key={lg}>
                      <div className="between" style={{ marginBottom: 4 }}>
                        <div className="muted small"><b>{lg}</b> · {groupedExisting[lg].length} team{groupedExisting[lg].length !== 1 ? "s" : ""}</div>
                        <button className="btn ghost sm" onClick={() => groupedExisting[lg].forEach(addSeed)}>Add all from {lg}</button>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap" }}>
                        {groupedExisting[lg].map((t) => (
                          <button className="member" key={t} onClick={() => addSeed(t)} title={`Add ${t} as a seed`} style={{ cursor: "pointer", border: "1px solid var(--line)" }}>+ {t}</button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
          <div className="aibar">
            <input placeholder="Paste guest teams (comma or new line)…" value={guests} onChange={(e) => setGuests(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addGuests(); }} />
            <button className="btn" onClick={addGuests}>Add teams</button>
          </div>
        </div>

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={onPrimary}>{primaryLabel}</button>
          {extra}
        </div>
      </div>
    );
  }

  // ---------- LIST ----------
  if (mode === "list") {
    return (
      <div>
        <div className="page-head"><h1>Tournaments</h1><div className="muted">Quick-turnaround brackets between regular seasons.</div></div>
        {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
        <div className="btn-row" style={{ marginBottom: 14 }}><button className="btn primary" onClick={openCreate}>New tournament</button></div>
        {!list.length && <div className="card"><p className="muted" style={{ margin: 0 }}>No tournaments yet. Create one to seed teams and auto-build the bracket.</p></div>}
        <div className="grid cols-2">
          {list.map((rec) => { const t = parseTour(rec); const champ = champion(t.st.rounds); return (
            <div className="card clickable" key={rec.id} onClick={() => openTour(rec)}>
              <div className="between"><h3 style={{ margin: 0 }}>{t.name}</h3>{t.date && <span className="chip">{fmtDate(t.date)}</span>}</div>
              <div className="muted small" style={{ marginTop: 6 }}>{(t.st.teams || []).length} teams · {(t.st.rounds || []).length} rounds{champ ? ` · Champion: ${champ}` : ""}</div>
            </div>
          ); })}
        </div>
      </div>
    );
  }

  // ---------- CREATE ----------
  if (mode === "create") {
    return (
      <div>
        <div className="page-head"><h1>New tournament</h1><div className="muted">Seed the teams; the bracket and field/time schedule are built for you.</div></div>
        {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}
        <div className="btn-row" style={{ marginBottom: 12 }}><button className="btn ghost" onClick={() => setMode("list")}>← Back</button></div>
        <Editor primaryLabel="Create bracket" onPrimary={createTournament} />
      </div>
    );
  }

  // ---------- MANAGE ----------
  if (!cur) { setMode("list"); return null; }
  const st = cur.st;
  const champ = champion(st.rounds);
  return (
    <div>
      <div className="page-head"><h1>{cur.name}</h1><div className="muted">{cur.date ? fmtDate(cur.date) + " · " : ""}Tap a team to record the winner; the next round fills in.</div></div>
      {flash && <div className={"note " + (flash.ok ? "good" : "warn")}>{flash.text}</div>}

      <div className="btn-row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <button className="btn ghost" onClick={() => { setCur(null); setMode("list"); }}>← All tournaments</button>
        <button className="btn" onClick={() => { if (!setupOpen) loadEditorFromCur(); setSetupOpen(!setupOpen); }}>{setupOpen ? "Close setup" : "Setup / re-seed"}</button>
        <button className="btn" onClick={() => copyText(htmlOf(cur.name, st), "Results table")}>Copy results</button>
        <button className="btn" onClick={() => download(`tournament-${slug(cur.name)}.csv`, csvOf(st), "text/csv")}>Download CSV</button>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </div>

      {champ && <div className="note good" style={{ marginBottom: 12 }}>Champion: <b>{champ}</b></div>}

      {setupOpen && (
        <Editor
          primaryLabel="Rebuild bracket (clears results)"
          onPrimary={applyRebuild}
          extra={<>
            <button className="btn" onClick={applyReschedule}>Update times only (keep results)</button>
            <label className="small" style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
              <input type="checkbox" style={{ width: "auto" }} checked={confirmDel} onChange={(e) => setConfirmDel(e.target.checked)} /> confirm
            </label>
            <button className="btn danger" onClick={delTour}>Delete tournament</button>
          </>}
        />
      )}

      {!st.rounds.length
        ? <div className="card"><p className="muted" style={{ margin: 0 }}>No bracket yet. Use Setup to seed teams.</p></div>
        : (
          <div className="bracket">
            {st.rounds.map((rd, r) => (
              <div className="bk-round" key={r}>
                <div className="bk-rhead">{roundName(rd.length)}</div>
                {rd.map((m, i) => (
                  <div className={"bk-match" + (isBye(m) ? " bye" : "")} key={i}>
                    {m.time && <div className="bk-meta">{m.time}{m.field ? ` · ${m.field}` : ""}</div>}
                    <button className={"bk-team" + (winnerOf(m) === m.home && m.home ? " win" : "")} disabled={!decidable(m)} onClick={() => setWinner(r, i, m.home)}>{m.home || "TBD"}</button>
                    <button className={"bk-team" + (winnerOf(m) === m.away && m.away ? " win" : "")} disabled={!decidable(m)} onClick={() => setWinner(r, i, m.away)}>{m.away === "(bye)" ? "bye" : (m.away || "TBD")}</button>
                    {!isBye(m) && (
                      <input className="bk-score" key={`sc-${m.home}-${m.away}-${m.score}`} defaultValue={m.score} placeholder="score e.g. 13-7" onBlur={(e) => setScore(r, i, e.target.value)} />
                    )}
                    {!isBye(m) && (
                      <div className="bk-refs">
                        {refsOfMatch(m).map((rf) => <span className="member" key={rf}>{rf}<button className="x" onClick={() => removeMatchRef(r, i, rf)}>×</button></span>)}
                        <select value="" onChange={(e) => { addMatchRef(r, i, e.target.value); e.target.value = ""; }}>
                          <option value="">+ Ref…</option>
                          {refs.filter((rf) => !refsOfMatch(m).includes(rf)).map((rf) => { const busy = refBusyAt(flatGames(st), rf, st.date || "T", m.time, `${r}-${i}`); return <option key={rf} value={rf} disabled={!!busy}>{rf}{busy ? " — busy" : ""}</option>; })}
                        </select>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
