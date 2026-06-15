"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api.js";

// Full-screen referee kiosk — the ref-side twin of components/ScanIn.jsx.
// Officials scan their key tag or type their name, the app calls api.refShift()
// to clock them in for the day and shows them the games they're assigned to.
// No sidebar, no assistant. Runs on a shared tablet at the field.

const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date((String(iso || "")).length <= 10 ? iso + "T00:00:00" : iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
};
const fmtTime12 = (t) => {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(t || ""));
  if (!m) return t || "";
  let h = +m[1]; const mn = +m[2]; const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0;
  const h12 = h % 12 || 12;
  return `${h12}:${String(mn).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
const refsOf = (g) => String(g.referee || "").split(",").map((s) => s.trim()).filter(Boolean);
const toISO = (d) => d.toISOString().slice(0, 10);
function weekStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }

export default function RefScanIn() {
  const [refs, setRefs] = useState([]);        // [{ name, key_tag, phone, league, field }]
  const [games, setGames] = useState([]);
  const [q, setQ] = useState("");
  const [match, setMatch] = useState(null);    // the referee we're showing — null = scan view
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [connected, setConnected] = useState(true);
  const [worked, setWorked] = useState({});    // game_id -> true once they've tapped Mark done
  const inputRef = useRef(null);
  const successTimer = useRef(null);

  // Load referee roster + saved schedule once on mount. We keep them in memory
  // so a scan resolves instantly without any extra round-trip.
  async function loadAll() {
    try { await api.ensureReferees(); } catch {}
    try {
      const r = await api.records("referee");
      const list = (r.records || []).map((x) => {
        let d = {}; try { d = JSON.parse(x.data || "{}"); } catch {}
        return {
          name: x.name || d.full_name || "",
          key_tag: (d.key_tag || "").trim(),
          phone: d.phone || "",
          league: d.league || "",
          field: d.field || "",
        };
      }).filter((x) => x.name);
      setRefs(list);
      setConnected(true);
    } catch { setConnected(false); }
    try {
      const r = await api.scheduleList(null);
      setGames(r.games || []);
    } catch {}
  }
  useEffect(() => { loadAll(); }, []);

  // Refresh the schedule in the background every 60s so a fresh assignment
  // shows up the next time someone scans, without re-mounting the kiosk.
  useEffect(() => {
    const id = setInterval(async () => {
      try { const r = await api.scheduleList(null); setGames(r.games || []); setConnected(true); }
      catch { setConnected(false); }
    }, 60000);
    return () => clearInterval(id);
  }, []);

  // Light health ping so the connection chip reflects reality.
  useEffect(() => {
    let on = true;
    const ping = async () => { try { await api.state(); if (on) setConnected(true); } catch { if (on) setConnected(false); } };
    ping();
    const t = setInterval(ping, 8000);
    return () => { on = false; clearInterval(t); };
  }, []);

  // After a check-in, give the ref ~25s to look at their games, then bounce
  // back to the scan input for the next person.
  useEffect(() => {
    if (!match) { inputRef.current?.focus(); return; }
    clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => goBack(), 25000);
    return () => clearTimeout(successTimer.current);
  }, [match]);

  function findRef(value) {
    const v = String(value || "").trim();
    if (!v) return null;
    const vl = v.toLowerCase();
    return refs.find((x) => x.key_tag && x.key_tag.toLowerCase() === vl)
        || refs.find((x) => x.name.toLowerCase() === vl)
        || refs.find((x) => x.name.toLowerCase().startsWith(vl) && vl.length >= 2)
        || null;
  }

  async function submit() {
    setErr("");
    if (q.trim().length < 2) return;
    const found = findRef(q.trim());
    if (!found) {
      setErr(`No referee found for "${q.trim()}". Check the spelling or your key tag, or ask the league admin to add you on the Referees page.`);
      return;
    }
    setBusy(true);
    try {
      try { await api.refShift(found.name, "in"); setConnected(true); } catch { setConnected(false); }
      setMatch(found);
      setQ("");
    } finally { setBusy(false); }
  }

  function goBack() {
    setMatch(null); setQ(""); setErr(""); setWorked({});
    setTimeout(() => inputRef.current?.focus(), 30);
  }

  async function checkOut() {
    if (!match) return;
    setBusy(true);
    try {
      try { await api.refShift(match.name, "out"); } catch {}
      goBack();
    } finally { setBusy(false); }
  }

  async function markWorked(g) {
    if (!match) return;
    try {
      await api.gameMarkWorked(g.id, match.name);
      setWorked((w) => ({ ...w, [g.id]: true }));
    } catch {}
  }

  // ---------------- VIEWS ----------------

  // The default "Welcome — scan to check in" view.
  if (!match) {
    return (
      <div className="kiosk ref-mode">
        <div className="kiosk-head">
          <div>
            <div className="kiosk-title">Referee check-in</div>
            <div className="muted small">Scan your key tag or type your name to check in for the day.</div>
          </div>
          <span className={"conn" + (connected ? "" : " off")} title={connected ? "Connected" : "Not connected"}>
            <span className="dot" />{connected ? "Connected" : "Offline"}
          </span>
        </div>

        <div className="kiosk-card">
          <div className="scan-bar">
            <input
              ref={inputRef}
              autoFocus
              placeholder="Scan key tag or type your name…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setErr(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
            {q
              ? <button className="btn" onClick={() => { setQ(""); setErr(""); inputRef.current?.focus(); }} disabled={busy}>Clear</button>
              : <button className="btn primary" onClick={submit} disabled={busy}>Check in</button>}
          </div>
          {err && <div className="note warn" style={{ marginTop: 12 }}>{err}</div>}
          <div className="muted small" style={{ marginTop: 10 }}>
            Two ways to check in: <b>scan</b> your key tag (the same one issued by the league office), or <b>type</b> your full name. A match logs your shift and shows the games you're assigned to today.
          </div>
        </div>

        <div className="kiosk-card" style={{ marginTop: 16 }}>
          <div className="muted small" style={{ fontWeight: 700, marginBottom: 6 }}>{refs.length} referee{refs.length !== 1 ? "s" : ""} on the roster</div>
          <div className="muted small">
            Not on the list? Ask the league admin to add you on the Referees page — it takes 30 seconds. Once added you can check in here.
          </div>
        </div>
      </div>
    );
  }

  // Post-scan view: show this ref's games today + their info.
  // Today = the calendar week containing today's date, then narrowed to today
  // first; if there's nothing on today we fall back to the rest of the week.
  const today = toISO(new Date());
  const thisWeekStart = toISO(weekStart(new Date()));
  const mine = games.filter((g) => refsOf(g).some((r) => r.toLowerCase() === match.name.toLowerCase()));
  const mineToday = mine.filter((g) => g.date === today);
  const mineThisWeek = mine.filter((g) => {
    if (!g.date) return false;
    const d = weekStart(new Date(g.date + "T00:00:00"));
    return toISO(d) === thisWeekStart;
  });
  const shown = mineToday.length ? mineToday : mineThisWeek;
  shown.sort((a, b) => (a.date || "").localeCompare(b.date || "") || String(a.time || "").localeCompare(String(b.time || "")));

  return (
    <div className="kiosk ref-mode">
      <div className="kiosk-head">
        <div>
          <div className="kiosk-title">Referee check-in</div>
          <div className="muted small">On duty — your games for {mineToday.length ? "today" : "this week"}.</div>
        </div>
        <span className={"conn" + (connected ? "" : " off")} title={connected ? "Connected" : "Not connected"}>
          <span className="dot" />{connected ? "Connected" : "Offline"}
        </span>
      </div>

      <div className="kiosk-card">
        <div className="between" style={{ alignItems: "flex-start", gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div className="r-name" style={{ fontSize: 32, fontWeight: 800 }}>{match.name}</div>
            <div className="r-sub" style={{ marginTop: 4 }}>
              ✓ On duty
              {match.league ? <span className="muted"> · {match.league}</span> : null}
              {match.field ? <span className="muted"> · home field {match.field}</span> : null}
            </div>
          </div>
          <div className="btn-row" style={{ flex: "0 0 auto" }}>
            <button className="btn ghost" onClick={goBack} disabled={busy}>Done</button>
            <button className="btn" onClick={checkOut} disabled={busy}>Check out</button>
          </div>
        </div>
      </div>

      <div className="kiosk-card" style={{ marginTop: 16 }}>
        <div className="hh-label">Your games {mineToday.length ? `· ${fmtDate(today)}` : "this week"}</div>
        {shown.length === 0 ? (
          <div className="muted" style={{ marginTop: 8 }}>
            No games assigned to you {mineToday.length === 0 ? "today" : "this week"} yet. Ask the league admin to assign you on the Assigned page, then scan again.
          </div>
        ) : (
          <div className="stack" style={{ gap: 14, marginTop: 10 }}>
            {shown.map((g) => {
              const done = !!worked[g.id] || (g.worked_by && String(g.worked_by).toLowerCase().includes(match.name.toLowerCase()));
              return (
                <div key={g.id} className={"kresult" + (done ? " checked" : "")}>
                  <div className="between" style={{ marginBottom: 8 }}>
                    <div className="kr-name" style={{ marginBottom: 0 }}>
                      {g.home} <span className="muted">vs</span> {g.away}
                    </div>
                    {done
                      ? <span className="good-chip">✓ Marked done</span>
                      : <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={() => markWorked(g)}>Mark done</button>}
                  </div>
                  <div className="kr-grid">
                    <div className="kr-cell"><div className="kr-label">Field</div><div className="kr-val">{g.location || "TBD"}</div></div>
                    <div className="kr-cell"><div className="kr-label">Time</div><div className="kr-val">{g.time ? fmtTime12(g.time) : "TBD"}</div></div>
                    <div className="kr-cell"><div className="kr-label">Date</div><div className="kr-val">{g.date ? fmtDate(g.date) : "TBD"}</div></div>
                  </div>
                  {refsOf(g).length > 1 && (
                    <div className="muted small" style={{ marginTop: 8 }}>
                      Working with: {refsOf(g).filter((n) => n.toLowerCase() !== match.name.toLowerCase()).join(", ") || "—"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="muted small" style={{ textAlign: "center", marginTop: 16 }}>
        This screen returns to scan automatically in 25 seconds — or tap <b>Done</b> now.
      </div>
    </div>
  );
}
