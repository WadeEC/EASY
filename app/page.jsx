"use client";
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api.js";
import { plural } from "@/lib/ui.js";
import Dashboard from "@/components/Dashboard.jsx";
import RefHome from "@/components/RefHome.jsx";
import Section from "@/components/Section.jsx";
import People from "@/components/People.jsx";
import Leagues from "@/components/Leagues.jsx";
import TeamsPage from "@/components/TeamsPage.jsx";
import Schedule from "@/components/Schedule.jsx";
import TournamentsPage from "@/components/TournamentsPage.jsx";
import ChangeLog from "@/components/ChangeLog.jsx";
import TimeMachine from "@/components/TimeMachine.jsx";
import RafflePage from "@/components/RafflePage.jsx";
import RankingsPage from "@/components/RankingsPage.jsx";
import RefAssign from "@/components/RefAssign.jsx";
import RefCoverage from "@/components/RefCoverage.jsx";
import ScanIn from "@/components/ScanIn.jsx";
import Board from "@/components/Board.jsx";
import Attendance from "@/components/Attendance.jsx";
import Advanced from "@/components/Advanced.jsx";
import MasterSpreadsheet from "@/components/MasterSpreadsheet.jsx";
import Unassigned from "@/components/Unassigned.jsx";
import SettingsPage from "@/components/SettingsPage.jsx";
import SeasonPage from "@/components/SeasonPage.jsx";
import StationsPage from "@/components/StationsPage.jsx";
import Standings from "@/components/Standings.jsx";
import AssistantWidget from "@/components/AssistantWidget.jsx";
import UsersPage from "@/components/UsersPage.jsx";
import RefScanIn from "@/components/RefScanIn.jsx";
// ToastHost is mounted in app/layout.jsx so every page (login, scanin, print, …)
// gets confirmation toasts, not just the main shell.

const PAGES = ["home", "people", "section", "teambuilder", "board", "schedule", "attendance", "scanin", "refscanin", "leagues", "advanced", "assigned", "coverage", "tournaments", "changelog", "timemachine", "raffle", "rankings", "master", "standings", "users"];
const viewToParam = (v) => {
  if (v.page === "section" && v.type) return `section:${v.type}`;
  if (v.page === "people" && v.tab) return `people:${v.tab}`;
  if (v.page === "teambuilder" && v.tab) return `teambuilder:${v.tab}`;
  return v.page;
};
function paramToView(param) {
  if (!param) return { page: "home" };
  const [page, sub] = String(param).split(":");
  if (page === "leagueview") return { page: "people" }; // old Rosters link → combined Players & Coaches page
  if (!PAGES.includes(page)) return { page: "home" };
  if (page === "section" && sub) return { page: "section", type: sub };
  if (page === "people" && sub) return { page: "people", tab: sub };
  if (page === "teambuilder" && sub) return { page: "teambuilder", tab: sub };
  return { page };
}
const readView = () => (typeof window === "undefined" ? { page: "home" } : paramToView(new URLSearchParams(window.location.search).get("v")));

export default function Home() {
  const [state, setState] = useState({ types: [], recent: [] });
  const [view, setView] = useState({ page: "home" });
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantSeed, setAssistantSeed] = useState(null);
  const [contentKey, setContentKey] = useState(0);
  const [navOpen, setNavOpen] = useState(true);
  const [openNav, setOpenNav] = useState({ main: true, sections: true });
  const [appMode, setAppMode] = useState("league");   // "league" (admin) or "ref" (mirrored referee view)

  const refresh = useCallback(async () => {
    try { const s = await api.state(); if (s && Array.isArray(s.types)) setState(s); } catch {}
  }, []);
  // After the assistant applies a change, re-fetch nav state AND remount the current
  // view so the change shows right away. The assistant panel + Undo stay (they're outside main).
  const applied = useCallback(async () => { await refresh(); setContentKey((k) => k + 1); }, [refresh]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (typeof window !== "undefined" && localStorage.getItem("ff_mode") === "ref") setAppMode("ref"); }, []);

  // URL routing: each view is a real route (e.g. /?v=scanin), so links, refresh and back/forward work.
  const navigate = useCallback((v) => {
    setView(v);
    const param = viewToParam(v);
    const url = param === "home" ? window.location.pathname : `${window.location.pathname}?v=${encodeURIComponent(param)}`;
    window.history.pushState({ v: param }, "", url);
  }, []);
  useEffect(() => {
    setView(readView());
    const onPop = () => setView(readView());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Site-wide mode: flip the whole app into a black-and-white referee workspace.
  async function switchMode(m) {
    setAppMode(m);
    if (typeof window !== "undefined") localStorage.setItem("ff_mode", m);
    if (m === "ref") { try { await api.ensureReferees(); } catch {} await refresh(); navigate({ page: "schedule" }); }
    else navigate({ page: "home" });
  }

  const NavBtn = ({ id, children }) => (
    <button className={"nav-item" + (sameView(view, id) ? " active" : "")} onClick={() => navigate(id)}>{children}</button>
  );
  const groupHdr = (id, label) => (
    <button className="nav-grouphdr" onClick={() => setOpenNav((o) => ({ ...o, [id]: !o[id] }))} aria-expanded={openNav[id]}>
      <span>{label}</span>
      <svg className={"nav-chev" + (openNav[id] ? " open" : "")} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
    </button>
  );

  const types = Array.isArray(state.types) ? state.types : [];
  const sectionLabel = types.find((t) => t.name === view.type)?.label;

  // These render full-screen, with no sidebar or assistant — they're kiosks,
  // pointed at a parent, not at an admin.
  //
  // The check-in board is NOT one of them any more. It's a staff screen, and
  // every filter on it is season-scoped, so running it without the sidebar
  // meant working a Saturday with no way to see — or change — which season you
  // were checking people into.
  if (view.page === "scanin") return <ScanIn go={navigate} />;
  if (view.page === "refscanin") return <RefScanIn />;

  // When an admin resets your password, the must_change_password flag forces
  // a one-time change before any other page renders. The gate calls /api/auth/me
  // itself so it's independent of the rest of the page load.
  return <PasswordGate><MainShell {...{ navOpen, setNavOpen, appMode, view, navigate, sameView, openNav, setOpenNav, types, sectionLabel, contentKey, state, refresh, setAssistantSeed, assistantOpen, setAssistantOpen, assistantSeed, applied, switchMode, NavBtn, groupHdr }} /></PasswordGate>;
}

// Wrapper that probes /api/auth/me once and, if the user has a temporary
// password, blocks the entire app behind a "set a new password" form. Once
// they update it, the wrapper reloads the page so the rest of the app boots
// with the fresh session.
function PasswordGate({ children }) {
  const [me, setMe] = useState(undefined);
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store" });
        const d = await r.json().catch(() => ({}));
        if (!cancel) setMe(d?.user || null);
      } catch { if (!cancel) setMe(null); }
    })();
    return () => { cancel = true; };
  }, []);
  if (me === undefined) return null;
  if (me && me.must_change_password) return <ForcedPasswordChange username={me.username} />;
  return children;
}

function ForcedPasswordChange({ username }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e) {
    e?.preventDefault?.();
    setErr("");
    if (next !== confirm) { setErr("New password and confirmation don't match."); return; }
    if (!next || next.length < 6) { setErr("New password must be at least 6 characters."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.error) { setErr(d.error); return; }
      // Session was wiped — bounce to login so they re-auth with the new password.
      window.location.href = "/login";
    } finally { setBusy(false); }
  }
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "linear-gradient(180deg, #0b1535 0%, #1a2858 100%)" }}>
      <form onSubmit={submit} style={{ background: "#fff", borderRadius: 16, width: 420, padding: "26px 30px", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}>
        <h2 style={{ marginTop: 0 }}>Set a new password</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Welcome, <b>{username}</b>. You signed in with a temporary password — pick a new one to continue.
        </p>
        <label className="fld">Temporary password</label>
        <input type="password" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        <label className="fld">New password</label>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="6+ characters" autoComplete="new-password" />
        <label className="fld">Confirm new password</label>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        {err && <div className="note warn" style={{ marginTop: 12 }}>{err}</div>}
        <button type="submit" className="btn primary" style={{ width: "100%", marginTop: 14, padding: 12, fontSize: 16 }} disabled={busy || !current || !next || !confirm}>
          {busy ? "Updating…" : "Set new password"}
        </button>
      </form>
    </div>
  );
}

const BUILT_IN_TYPES = ["division", "game", "attendance", "player", "coach", "team", "teams", "referee", "tournament"];

// Icons for the two hub buttons. They inherit currentColor, so they follow the
// nav's active/inactive colours without any extra CSS.
const NavIcon = ({ children }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ flex: "0 0 17px" }} aria-hidden>{children}</svg>
);
// Season — a trophy: standings, tournaments, rankings.
const SeasonIcon = () => (
  <NavIcon>
    <path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z" />
    <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
  </NavIcon>
);
// Stations — a scan viewfinder: the kiosk, the board, the register.
const StationsIcon = () => (
  <NavIcon>
    <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M3 12h18" />
  </NavIcon>
);
// Settings — a gear.
const SettingsIcon = () => (
  <NavIcon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </NavIcon>
);
// A nav label with an icon in front of it.
const IconLabel = ({ icon, children }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>{icon}{children}</span>
);

function MainShell({ navOpen, setNavOpen, appMode, view, navigate, sameView, openNav, setOpenNav, types, sectionLabel, contentKey, state, refresh, setAssistantSeed, assistantOpen, setAssistantOpen, assistantSeed, applied, switchMode, NavBtn, groupHdr }) {
  const customTypes = (types || []).filter((t) => !BUILT_IN_TYPES.includes(t.name));

  return (
    <div className={"app" + (navOpen ? "" : " nav-collapsed") + (appMode === "ref" ? " ref-mode" : "")}>
      {!navOpen && (
        <button className="nav-toggle" title="Show menu" aria-label="Show menu" onClick={() => setNavOpen(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
        </button>
      )}
      <aside className="side">
        <div className="side-top">
          <div>
            <div className="brand">E.A.S.Y</div>
            <div className="brand-sub">Your league, organized.</div>
          </div>
          <button className="side-collapse" title="Hide menu" aria-label="Hide menu" onClick={() => setNavOpen(false)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
        </div>

        <div className="mode-toggle">
          <button className={"mode-pill" + (appMode === "league" ? " active" : "")} onClick={() => switchMode("league")}>League</button>
          <button className={"mode-pill" + (appMode === "ref" ? " active" : "")} onClick={() => switchMode("ref")}>Referees</button>
        </div>

        <SeasonPicker reloadKey={contentKey} onChanged={applied} />

        {appMode === "ref" ? (
          <>
            <NavBtn id={{ page: "home" }}>Home</NavBtn>
            <NavBtn id={{ page: "schedule" }}>Field schedule</NavBtn>
            <NavBtn id={{ page: "assigned" }}>Assigned</NavBtn>
            <NavBtn id={{ page: "coverage" }}>Coverage</NavBtn>
            <NavBtn id={{ page: "refscanin" }}>Kiosk</NavBtn>
            <NavBtn id={{ page: "section", type: "referee" }}>Referees</NavBtn>
          </>
        ) : (
          <>
            <NavBtn id={{ page: "home" }}>Home</NavBtn>

            {/* Main — the three pages the job actually runs on, first and open by
                default. Everything else stays grouped below by how often you need it. */}
            {groupHdr("main", "Main")}
            {openNav.main && (
              <>
                <NavBtn id={{ page: "people" }}>Players &amp; Coaches</NavBtn>
                <NavBtn id={{ page: "teambuilder" }}>Teams</NavBtn>
                <NavBtn id={{ page: "unassigned" }}>Unassigned</NavBtn>
                <NavBtn id={{ page: "schedule" }}>Schedule</NavBtn>
                <NavBtn id={{ page: "leagues" }}>Leagues &amp; Assignment</NavBtn>
              </>
            )}

            {/* Sections now holds only the custom sections an admin has added —
                the built-in ones live in Main or Season. Hidden entirely when
                there are none, rather than showing an empty header. */}
            {customTypes.length > 0 && groupHdr("sections", "Sections")}
            {customTypes.length > 0 && openNav.sections && (
              <>
                {customTypes.map((t) => (
                  <NavBtn key={t.name} id={{ page: "section", type: t.name }}>{plural(t.label || t.name)}</NavBtn>
                ))}
              </>
            )}

            {/* Stations, Season and Settings are single buttons, not
                dropdowns. Each opens a page of cards that says what every
                destination is for — a collapsed list of bare names couldn't. */}
            <NavBtn id={{ page: "stations" }}><IconLabel icon={<StationsIcon />}>Stations</IconLabel></NavBtn>
            <NavBtn id={{ page: "season" }}><IconLabel icon={<SeasonIcon />}>Season</IconLabel></NavBtn>
            <NavBtn id={{ page: "settings" }}><IconLabel icon={<SettingsIcon />}>Settings</IconLabel></NavBtn>
          </>
        )}

        <AccountChip />
        <div className="side-foot">Local &amp; private · runs on your computer</div>
      </aside>

      <main className="main">
        {view.page === "home" && appMode === "ref" && <RefHome key={`refhome-${contentKey}`} go={navigate} onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "home" && appMode !== "ref" && <Dashboard key={`home-${contentKey}`} state={state} go={navigate} refresh={refresh}
          onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "people" && <People key={`ppl-${view.tab || "default"}-${contentKey}`} state={state} go={navigate} tab={view.tab} refresh={refresh}
          onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "section" && <Section key={`${view.type}-${contentKey}`} type={view.type} label={sectionLabel} refresh={refresh}
          onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "teambuilder" && <TeamsPage key={`tb-${contentKey}`} go={navigate} tab={view.tab} onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "schedule" && <Schedule key={`sch-${contentKey}-${appMode}`} go={navigate} startRef={appMode === "ref"} onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "attendance" && <Attendance key={`att-${contentKey}`} go={navigate} />}
        {view.page === "board" && <Board key={`board-${contentKey}`} go={navigate} />}
        {view.page === "leagues" && <Leagues key={`lg-${contentKey}`} refresh={refresh} onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "stations" && <StationsPage key={`sta-${contentKey}`} go={navigate} />}
        {view.page === "season" && <SeasonPage key={`ssn-${contentKey}`} go={navigate} />}
        {view.page === "settings" && <SettingsPage key={`set-${contentKey}`} go={navigate} />}
        {view.page === "advanced" && <Advanced key={`adv-${contentKey}`} refresh={refresh} />}
        {view.page === "master" && <MasterSpreadsheet key={`mst-${contentKey}`} />}
        {view.page === "unassigned" && <Unassigned key={`una-${contentKey}`} go={navigate} refresh={refresh}
          onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "standings" && <Standings key={`std-${contentKey}`} onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "assigned" && <RefAssign key={`asg-${contentKey}`} onAsk={(text) => setAssistantSeed({ text, key: Date.now() })} />}
        {view.page === "coverage" && <RefCoverage key={`cov-${contentKey}`} />}
        {view.page === "tournaments" && <TournamentsPage key={`trn-${contentKey}`} />}
        {view.page === "changelog" && <ChangeLog key={`log-${contentKey}`} />}
        {view.page === "timemachine" && <TimeMachine key={`tm-${contentKey}`} refresh={refresh} />}
        {view.page === "users" && <UsersPage key={`users-${contentKey}`} />}
        {view.page === "raffle" && <RafflePage key={`raf-${contentKey}`} />}
        {view.page === "rankings" && <RankingsPage key={`rnk-${contentKey}`} go={navigate} />}
      </main>

      <AssistantWidget open={assistantOpen} setOpen={setAssistantOpen} seed={assistantSeed} onApplied={applied} />
    </div>
  );
}

function sameView(a, b) {
  if (a.page !== b.page) return false;
  if (a.page === "section") return a.type === b.type;
  return true;
}

// Sidebar footer chip — who's signed in + sign-out. Polls /api/auth/me once so
// the navbar reflects display name. Sign Out clears the session cookie and
// returns to the login screen.
function AccountChip() {
  const [me, setMe] = useState(null);
  useEffect(() => {
    let cancel = false;
    (async () => {
      try { const r = await fetch("/api/auth/me", { cache: "no-store" }); const d = await r.json(); if (!cancel) setMe(d?.user || null); } catch {}
    })();
    return () => { cancel = true; };
  }, []);
  async function signOut() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    window.location.href = "/login";
  }
  if (!me) return null;
  return (
    <div style={{ padding: "8px 10px", marginTop: 8, fontSize: 12, color: "#cdd6ec", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <div style={{ fontWeight: 700, color: "#fff" }}>{me.display_name || me.username}</div>
          <div style={{ color: "#8fa0c4" }}>{me.role}{me.role === "admin" ? "" : " · view-only"}</div>
        </div>
        <button onClick={signOut} title="Sign out"
          style={{ background: "rgba(255,255,255,0.08)", color: "#cdd6ec", border: "1px solid rgba(255,255,255,0.16)", borderRadius: 6, padding: "4px 8px", fontSize: 11, cursor: "pointer" }}>Sign out</button>
      </div>
    </div>
  );
}


// Global season picker — one control that scopes EVERY page. The choice is kept
// in localStorage (ff_season) and sent to the server with every request as the
// x-ff-season header; changing it remounts the current view. Defaults to the
// current (most recently made) season.
function SeasonPicker({ reloadKey, onChanged }) {
  const [detail, setDetail] = useState([]);
  const [untagged, setUntagged] = useState(0);
  const [sel, setSel] = useState("");
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const s = await api.seasonsList();
        if (dead || s.error) return;
        setDetail(s.detail || (s.seasons || []).map((n) => ({ name: n })));
        setUntagged(Number(s.untagged) || 0);
        let cur = null;
        try { cur = localStorage.getItem("ff_season"); } catch {}
        if (cur == null) {
          cur = s.active || "";
          try { localStorage.setItem("ff_season", cur); } catch {}
        }
        setSel(cur || "");
      } catch {}
    })();
    return () => { dead = true; };
  }, [reloadKey]);
  if (!detail.length) return null;
  const cur = detail.find((d) => d.name === sel);
  return (
    <div style={{ padding: "0 12px", marginBottom: 10 }}>
      <select
        value={sel}
        onChange={(e) => {
          const v = e.target.value;
          setSel(v);
          try { localStorage.setItem("ff_season", v); } catch {}
          onChanged && onChanged();
        }}
        title="Season — scopes every page, every number and every export"
        style={{ width: "100%" }}
      >
        <option value="">All seasons</option>
        {detail.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}{d.locked ? " 🔒" : ""}{typeof d.players === "number" ? ` · ${d.players}` : ""}
          </option>
        ))}
        {untagged > 0 && <option value="(no season)">No season (legacy · {untagged})</option>}
      </select>
      {/* Say out loud what the numbers on screen cover. The old picker let
          "All seasons" look identical to a single season once you scrolled. */}
      <div className="muted small" style={{ marginTop: 4 }}>
        {!sel
          ? "Showing every season combined"
          : sel === "(no season)"
            ? "Legacy records with no season"
            : cur?.locked
              ? "Locked — read only"
              : `${cur?.players ?? 0} players in this season`}
      </div>
    </div>
  );
}
