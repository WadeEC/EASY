"use client";
import { useEffect, useState } from "react";

// Login screen — two tabs: Sign in (default) and Create account. Auto-flips to
// Create on a fresh install (no users yet) so the bootstrap admin is obvious.
// Successful auth sets the session cookie server-side and we redirect back to
// wherever the user was trying to reach (?next=/something).
export default function LoginPage() {
  const [mode, setMode] = useState("signin"); // "signin" | "create"
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [isFirstRun, setIsFirstRun] = useState(false);

  // Probe state on mount: are we already signed in? Is this a fresh install
  // (no users yet)? On first-run we flip the default tab to Create so the
  // bootstrap admin is obvious.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store" });
        const d = await r.json().catch(() => ({}));
        if (cancel) return;
        if (d?.user) { window.location.href = nextTarget(); return; }
        const fresh = !!d?.first_run;
        setIsFirstRun(fresh);
        setMode(fresh ? "create" : "signin");
      } catch {}
    })();
    return () => { cancel = true; };
  }, []);

  function nextTarget() {
    try {
      const sp = new URLSearchParams(window.location.search);
      const n = sp.get("next");
      return n && n.startsWith("/") ? n : "/";
    } catch { return "/"; }
  }

  async function doSignIn() {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) { setErr(d.error || "Wrong username or password."); return; }
      window.location.href = nextTarget();
    } finally { setBusy(false); }
  }

  async function doCreate() {
    if (!displayName.trim()) { setErr("Display name is required."); return; }
    setBusy(true); setErr("");
    try {
      const c = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", username, password, display_name: displayName, role: "admin" }),
      });
      const cd = await c.json().catch(() => ({}));
      if (cd.error) {
        if (/admin only/i.test(cd.error)) {
          setErr("New accounts can only be added by an existing admin. Sign in instead.");
          setMode("signin");
        } else setErr(cd.error);
        return;
      }
      // Account created — immediately log in to set the session cookie.
      const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) { setErr(d.error || "Account created, but sign-in failed."); return; }
      window.location.href = nextTarget();
    } finally { setBusy(false); }
  }

  function submit(e) {
    e?.preventDefault?.();
    if (busy) return;
    if (!username.trim() || !password) { setErr("Username and password are required."); return; }
    if (mode === "signin") doSignIn(); else doCreate();
  }

  const tabBtn = (id, label) => (
    <button
      type="button"
      onClick={() => { setMode(id); setErr(""); }}
      style={{
        flex: 1, padding: "10px 12px", border: "none", cursor: "pointer",
        background: mode === id ? "var(--brand, #c8102e)" : "transparent",
        color: mode === id ? "#fff" : "#0b1535",
        fontWeight: 700, fontSize: 14, letterSpacing: 0.3,
      }}
    >{label}</button>
  );

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, background: "linear-gradient(180deg, #0b1535 0%, #1a2858 100%)" }}>
      <form onSubmit={submit} style={{ background: "#fff", borderRadius: 16, width: 400, boxShadow: "0 20px 60px rgba(0,0,0,0.35)", overflow: "hidden" }}>
        <div style={{ padding: "26px 30px 6px" }}>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: 1 }}>
            <span style={{ color: "var(--brand, #c8102e)" }}>Flag</span> Football
          </div>
          <div className="muted" style={{ marginTop: 2 }}>
            {mode === "signin" ? "Sign in to continue" : isFirstRun ? "Create the first admin account" : "Create a new account"}
          </div>
        </div>

        <div style={{ display: "flex", borderBottom: "1px solid var(--line, #e5e7eb)", marginTop: 14 }}>
          {tabBtn("signin", "Sign in")}
          {tabBtn("create", "Create account")}
        </div>

        <div style={{ padding: "18px 30px 24px" }}>
          {mode === "create" && (
            <>
              <label className="fld">Display name</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Shown on the Change log"
                autoFocus={mode === "create"}
              />
            </>
          )}

          <label className="fld">Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            autoComplete="username"
            autoFocus={mode === "signin"}
            spellCheck={false}
            placeholder="email or handle"
          />

          <label className="fld">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "create" ? "new-password" : "current-password"}
            placeholder={mode === "create" ? "At least 6 characters" : ""}
          />

          {err && <div className="note warn" style={{ marginTop: 12 }}>{err}</div>}

          <button
            type="submit"
            className="btn primary"
            style={{ width: "100%", marginTop: 14, padding: 12, fontSize: 16 }}
            disabled={busy || !username || !password || (mode === "create" && !displayName.trim())}
          >
            {busy ? "Working…" : mode === "signin" ? "Sign in" : "Create account"}
          </button>

          <div className="muted small" style={{ marginTop: 12, textAlign: "center" }}>
            {mode === "signin" ? (
              <>Don't have an account? <a onClick={() => { setMode("create"); setErr(""); }} style={{ cursor: "pointer", textDecoration: "underline" }}>Create one</a></>
            ) : (
              <>Already have an account? <a onClick={() => { setMode("signin"); setErr(""); }} style={{ cursor: "pointer", textDecoration: "underline" }}>Sign in</a></>
            )}
          </div>

          <div className="muted small" style={{ marginTop: 8, textAlign: "center", fontSize: 11 }}>Local app · sessions live 30 days</div>
        </div>
      </form>
    </div>
  );
}
