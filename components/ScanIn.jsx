"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api.js";

const fmtDate = (iso) => { if (!iso) return ""; const d = new Date(iso + "T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }); };
const headFirst = (cs) => [...cs].sort((a, b) => (/head/i.test(b.role) ? 1 : 0) - (/head/i.test(a.role) ? 1 : 0));
const toISO = (d) => d.toISOString().slice(0, 10);
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }

const SIZE_OPTS = ["YS", "YM", "YL", "AS", "AM", "AL"];

// Self-service kiosk (parent & kid view). One intake that accepts a name, the last 4 of a
// phone, or a scanned key tag — then shows your team, field, and coach. Full screen, no sidebar.
export default function ScanIn() {
  // The active check-in week is set on the admin Team Board and stored as a
  // league-wide setting. Fall back to the current calendar week when nothing is
  // set so the kiosk still works on day one of the season.
  const [week, setWeek] = useState(() => toISO(weekStart(new Date())));
  useEffect(() => {
    let cancel = false;
    const refresh = async () => {
      try {
        const s = await api.activeWeekGet();
        if (!cancel && s && s.week) setWeek(s.week);
      } catch {}
    };
    refresh();
    // The kiosk runs all day — poll every 60s so changing the week on the admin
    // side doesn't require restarting the kiosk tab.
    const id = setInterval(refresh, 60000);
    return () => { cancel = true; clearInterval(id); };
  }, []);
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState(null);
  const [searched, setSearched] = useState(false);
  const [connected, setConnected] = useState(true);
  const [checked, setChecked] = useState({}); // player id -> { size, confirmed_at }
  const [confirming, setConfirming] = useState({}); // player id -> { size, ok }
  const [busy, setBusy] = useState({}); // player id -> bool
  const [err, setErr] = useState({});   // player id -> string
  const [success, setSuccess] = useState(null); // { player, size } — full-screen success after check-in
  const [moreBelow, setMoreBelow] = useState(false);
  const inputRef = useRef(null);
  const timer = useRef(null);
  const successTimer = useRef(null);
  const endRef = useRef(null);

  // Watch the end-of-results sentinel — when it's NOT on screen there are more matches below the fold.
  useEffect(() => {
    const node = endRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setMoreBelow(!entry.isIntersecting), { threshold: 0.05 });
    io.observe(node);
    return () => io.disconnect();
  }, [groups, success]);

  function scrollMoreIntoView() {
    if (endRef.current) endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  // glowing "connected" indicator — light health ping to the local server
  useEffect(() => {
    let on = true;
    const ping = async () => { try { await api.state(); if (on) setConnected(true); } catch { if (on) setConnected(false); } };
    ping();
    const t = setInterval(ping, 8000);
    inputRef.current?.focus();
    return () => { on = false; clearInterval(t); };
  }, []);

  // The kiosk runs all day on a shared tablet. Whenever the search/intake view
  // is showing (success is null), park the cursor in the scan input so the
  // next person who walks up can just start typing or scan immediately.
  useEffect(() => {
    if (success) return;
    // Wait a tick for the input to mount after exiting the success screen.
    const id = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [success]);

  async function run(query) {
    try { const res = await api.kioskSearch({ method: "auto", query }); setGroups(res.groups || []); setSearched(true); setConnected(true); return res.groups || []; }
    catch { setConnected(false); return []; }
  }
  function onChange(v) {
    setQ(v);
    clearTimeout(timer.current);
    if (v.trim().length >= 2) timer.current = setTimeout(() => run(v.trim()), 250);
    else { setGroups(null); setSearched(false); }
  }
  async function submit() {
    clearTimeout(timer.current);
    if (q.trim().length < 2) return;
    const gs = await run(q.trim());
    const all = gs.flatMap((g) => g.players);
    if (all.length === 1) startConfirm(all[0]); // a scan / unique match → open the size-confirm gate
  }
  function reset() { setQ(""); setGroups(null); setSearched(false); setChecked({}); setConfirming({}); setErr({}); inputRef.current?.focus(); }
  function startConfirm(p) {
    setConfirming((c) => ({ ...c, [p.id]: { size: p.jersey_size || "", ok: false } }));
    setErr((e) => ({ ...e, [p.id]: "" }));
  }
  function cancelConfirm(p) {
    setConfirming((c) => { const n = { ...c }; delete n[p.id]; return n; });
    setErr((e) => ({ ...e, [p.id]: "" }));
  }
  function updateConfirm(p, patch) {
    setConfirming((c) => ({ ...c, [p.id]: { ...(c[p.id] || { size: "", ok: false }), ...patch } }));
  }
  async function commitConfirm(p) {
    const c = confirming[p.id];
    if (!c || !c.size) { setErr((e) => ({ ...e, [p.id]: "Pick a jersey size first." })); return; }
    if (!c.ok) { setErr((e) => ({ ...e, [p.id]: "Tick the confirmation box." })); return; }
    setBusy((b) => ({ ...b, [p.id]: true }));
    try {
      const res = await api.attendanceConfirmSize({ player_id: p.id, player: p.name, week, jersey_size: c.size, confirmed: true });
      if (res && res.error) { setErr((e) => ({ ...e, [p.id]: res.error })); setBusy((b) => ({ ...b, [p.id]: false })); return; }
      setChecked((ck) => ({ ...ck, [p.id]: { size: res.jersey_size, confirmed_at: res.size_confirmed_at } }));
      setConfirming((cc) => { const n = { ...cc }; delete n[p.id]; return n; });
      setErr((e) => ({ ...e, [p.id]: "" }));
      setConnected(true);
      // Full-screen success — fills the kiosk so players don't need the printed board.
      // Auto-dismisses after 12 seconds so the next person doesn't see the previous
      // player's info. Big Exit button below lets them clear immediately.
      setSuccess({ player: p, size: res.jersey_size, expires_at: Date.now() + 12000 });
      clearTimeout(successTimer.current);
      successTimer.current = setTimeout(() => { setSuccess(null); reset(); }, 12000);
    } catch {
      setConnected(false);
      setErr((e) => ({ ...e, [p.id]: "Connection issue — try again." }));
    } finally {
      setBusy((b) => ({ ...b, [p.id]: false }));
    }
  }

  function dismissSuccess() {
    clearTimeout(successTimer.current);
    setSuccess(null);
    reset();
  }

  if (success) {
    const p = success.player;
    const isLight = p.jersey_color === "light";
    const coachList = (p.coaches && p.coaches.length) ? headFirst(p.coaches) : [];
    return (
      <div style={{ position: "fixed", inset: 0, background: "linear-gradient(180deg, #0b1535 0%, #1a2858 100%)", color: "#fff", display: "flex", flexDirection: "column", zIndex: 999 }}>
        <div style={{ padding: "16px 28px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 1 }}>✓ CHECKED IN</div>
          <CountdownChip expiresAt={success.expires_at} />
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "10px 28px", textAlign: "center", gap: 8 }}>
          <div style={{ fontSize: 38, fontWeight: 800, lineHeight: 1.1 }}>{p.name}</div>
          <div style={{ fontSize: 15, opacity: 0.7 }}>{p.league || ""}{p.division ? ` · ${p.division}` : ""}</div>

          {/* 4-up info grid — tighter cards, single line where possible. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 14, width: "100%", maxWidth: 1100, marginTop: 14 }}>
            <InfoCard label="Team" value={p.team || "Not assigned"} small={(p.team || "").length > 18} />
            <InfoCard label="Field" value={p.field || "TBD"} sub={p.next?.time || ""} />
            <InfoCard label="Coach" value={coachList.length ? coachList.map((c) => c.name + (/head/i.test(c.role) ? " (H)" : "")).join(", ") : "TBD"} small />
            <div style={{
              background: isLight ? "#ffffff" : "#0b0f1d",
              color: isLight ? "#111" : "#fff",
              border: "2px solid " + (isLight ? "#ffd166" : "#3b4574"),
              borderRadius: 14, padding: "14px 16px",
              boxShadow: "0 6px 18px rgba(0,0,0,0.3)",
              display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 130,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.6, textTransform: "uppercase", letterSpacing: 1.5 }}>Jersey</div>
              <div style={{ fontSize: 38, fontWeight: 900, lineHeight: 1, marginTop: 6, letterSpacing: 1.5 }}>{p.jersey_color ? p.jersey_color.toUpperCase() : "—"}</div>
              <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>
                {p.next?.home_away === "home" ? "Home" : p.next?.home_away === "away" ? "Away" : ""}
                {success.size ? `${p.next?.home_away ? " · " : ""}size ${success.size}` : ""}
              </div>
            </div>
          </div>

          {p.next && p.next.vs && (
            <div style={{ marginTop: 12, fontSize: 14, opacity: 0.75 }}>
              First game: <b>vs {p.next.vs}</b>{p.next.date ? ` · ${fmtDate(p.next.date)}` : ""}
            </div>
          )}
        </div>

        <div style={{ padding: "12px 28px 22px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <button
            onClick={dismissSuccess}
            style={{
              background: "#fff", color: "#0b1535", border: "none",
              borderRadius: 999, padding: "12px 44px",
              fontSize: 18, fontWeight: 800, letterSpacing: 1,
              cursor: "pointer", boxShadow: "0 6px 18px rgba(0,0,0,0.3)",
              minWidth: 200,
            }}
          >Exit</button>
          <div style={{ opacity: 0.55, fontSize: 12 }}>This screen closes automatically — tap Exit to clear now.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="kiosk">
      <div className="kiosk-head">
        <div>
          <div className="kiosk-title"><span>Flag</span> Football · Find my team</div>
          <div className="muted small">Look yourself up, then tap Check in for the day.</div>
        </div>
        <span className={"conn" + (connected ? "" : " off")} title={connected ? "Connected" : "Not connected"}>
          <span className="dot" />{connected ? "Connected" : "Offline"}
        </span>
      </div>

      <div className="kiosk-card">
        <div className="scan-bar">
          <input ref={inputRef} autoFocus placeholder="Type a name, last 4 of your phone, or scan your key tag…"
            value={q} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
          {q ? <button className="btn" onClick={reset}>Clear</button> : <button className="btn primary" onClick={submit}>Find</button>}
        </div>
        <div className="muted small" style={{ marginTop: 10 }}>
          Three ways to look up: by <b>name</b>, the <b>last 4 digits</b> of a parent phone, or <b>scan a key tag</b>. Siblings show up together.
        </div>
      </div>

      {searched && groups && groups.length === 0 && (
        <div className="kiosk-card" style={{ marginTop: 16 }}>
          <div className="r-name" style={{ fontSize: 22, fontWeight: 800 }}>No match found</div>
          <div className="muted" style={{ marginTop: 4 }}>Check the spelling, try the last 4 digits of the parent phone number, or ask a volunteer.</div>
        </div>
      )}

      {groups && groups.map((g) => (
        <div className="kiosk-card" style={{ marginTop: 16 }} key={g.key}>
          {g.players.length > 1 && <div className="hh-label">{g.label}</div>}
          <div className="stack" style={{ gap: 14 }}>
            {g.players.map((p) => {
              const session = checked[p.id];
              const conf = confirming[p.id];
              const isBusy = !!busy[p.id];
              const errMsg = err[p.id] || "";
              return (
                <div className={"kresult" + (session ? " checked" : "")} key={p.id}>
                  <div className="between" style={{ marginBottom: 12 }}>
                    <div className="kr-name" style={{ marginBottom: 0 }}>{p.name}{p.age !== "" ? <span className="muted"> · {p.age}</span> : null}{p.division ? <span className="muted"> · {p.division}</span> : null}</div>
                    {session
                      ? <span className="good-chip">✓ Checked in · size {session.size}</span>
                      : conf
                        ? <span className="muted small">Confirm size to finish check-in</span>
                        : <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={() => startConfirm(p)}>Check in</button>}
                  </div>
                  <div className="kr-grid">
                    <div className="kr-cell"><div className="kr-label">Team</div><div className="kr-val">{p.team || "Not assigned yet"}</div></div>
                    <div className="kr-cell"><div className="kr-label">Field</div><div className="kr-val">{p.field || "TBD"}</div></div>
                    <div className="kr-cell"><div className="kr-label">Coach</div><div className="kr-val">{p.coaches.length ? headFirst(p.coaches).map((c) => c.name + (/head/i.test(c.role) ? " (Head)" : "")).join(", ") : "TBD"}</div></div>
                  </div>
                  {p.next && p.next.vs ? <div className="muted small" style={{ marginTop: 8 }}>Next game: vs <b>{p.next.vs}</b>{p.next.location ? ` at ${p.next.location}` : ""}{p.next.date ? ` · ${fmtDate(p.next.date)}` : ""}</div> : null}

                  {conf && (
                    <div style={{ marginTop: 14, padding: 14, border: "2px solid var(--brand)", borderRadius: 10, background: "var(--brand-soft)" }}>
                      <div style={{ fontWeight: 700, marginBottom: 8 }}>Confirm jersey size</div>
                      <div className="muted small" style={{ marginBottom: 10 }}>
                        Current on file: <b>{p.jersey_size || "(none)"}</b>. Show {p.name.split(" ")[0]} this size, then confirm or correct below.
                        <span className="small" style={{ display: "block", marginTop: 4, color: "var(--brand)" }}>Printing is blocked until size is confirmed.</span>
                      </div>
                      <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
                        <div>
                          <label className="fld">Jersey size</label>
                          <select value={conf.size} onChange={(e) => updateConfirm(p, { size: e.target.value })} style={{ minWidth: 110 }}>
                            <option value="">(pick)</option>
                            {SIZE_OPTS.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </div>
                        <label className="fld" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 22 }}>
                          <input type="checkbox" checked={conf.ok} onChange={(e) => updateConfirm(p, { ok: e.target.checked })} style={{ width: 18, height: 18 }} />
                          <span>I've confirmed this size on-site</span>
                        </label>
                      </div>
                      {errMsg && <div className="note warn" style={{ marginTop: 10 }}>{errMsg}</div>}
                      <div className="btn-row" style={{ marginTop: 12 }}>
                        <button className="btn primary" disabled={isBusy || !conf.ok || !conf.size} onClick={() => commitConfirm(p)}>{isBusy ? "Saving…" : "Confirm & Check in"}</button>
                        <button className="btn ghost" onClick={() => cancelConfirm(p)}>Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div ref={endRef} aria-hidden="true" style={{ height: 1 }} />

      {moreBelow && groups && groups.length > 1 && (
        <button
          onClick={scrollMoreIntoView}
          aria-label="Scroll to more results"
          style={{
            position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)",
            background: "var(--brand, #d22)", color: "#fff", border: "none",
            borderRadius: 999, padding: "10px 22px", fontWeight: 700, fontSize: 14,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)", cursor: "pointer", zIndex: 50,
            display: "flex", alignItems: "center", gap: 8,
          }}>
          <span style={{ fontSize: 18, lineHeight: 1 }}>↓</span>
          More matches below
        </button>
      )}
    </div>
  );
}

// Compact stat card used on the success screen. value font shrinks when the
// label is long so "Ages 11-12 / Team 12" doesn't overflow the cell.
function InfoCard({ label, value, sub, small = false }) {
  const len = String(value || "").length;
  const fontSize = small || len > 22 ? 22 : len > 14 ? 28 : 36;
  return (
    <div style={{
      background: "rgba(255,255,255,0.08)",
      border: "1px solid rgba(255,255,255,0.18)",
      borderRadius: 14, padding: "14px 16px",
      display: "flex", flexDirection: "column", justifyContent: "center", minHeight: 130,
    }}>
      <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.6, textTransform: "uppercase", letterSpacing: 1.5 }}>{label}</div>
      <div style={{ fontSize, fontWeight: 800, lineHeight: 1.1, marginTop: 6, wordBreak: "break-word" }}>{value}</div>
      {sub && <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// Small live countdown chip in the success-screen header so the player can see
// exactly how many seconds remain before the screen clears itself.
function CountdownChip({ expiresAt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return (
    <div style={{
      background: "rgba(255,255,255,0.12)", color: "#fff",
      border: "1px solid rgba(255,255,255,0.3)", borderRadius: 999,
      padding: "6px 14px", fontSize: 14, fontWeight: 700, letterSpacing: 0.5,
      fontVariantNumeric: "tabular-nums",
    }}>
      Closes in {remaining}s
    </div>
  );
}
