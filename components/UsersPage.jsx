"use client";
import { useEffect, useState } from "react";
import { toast } from "@/lib/toast.jsx";

// Settings → Users. Admin-only. Add new users, reset passwords (the "forgot
// password" workflow ends here), rename, disable. Anyone with a pending
// "I forgot my password" request shows with a red "needs reset" chip.
export default function UsersPage() {
  const [users, setUsers] = useState(null);
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ username: "", display_name: "", password: "" });
  const [resetFor, setResetFor] = useState(null);   // user object whose password we're resetting
  const [newPwd, setNewPwd] = useState("");

  async function load() {
    setErr("");
    try {
      const m = await fetch("/api/auth/me", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
      setMe(m?.user || null);
      const r = await fetch("/api/auth/users", { cache: "no-store" });
      const d = await r.json().catch(() => ({}));
      if (d.error) { setErr(d.error); setUsers([]); return; }
      setUsers(d.users || []);
    } catch (e) { setErr(String(e?.message || e)); setUsers([]); }
  }
  useEffect(() => { load(); }, []);

  async function addUser() {
    if (!draft.username.trim() || !draft.password) { setErr("Username and password required."); return; }
    if (draft.password.length < 6) { setErr("Password must be 6+ characters."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          username: draft.username.trim(),
          password: draft.password,
          display_name: (draft.display_name || draft.username).trim(),
          role: "admin",
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.error) { setErr(d.error); return; }
      toast.success("User added");
      setAdding(false); setDraft({ username: "", display_name: "", password: "" });
      load();
    } finally { setBusy(false); }
  }

  async function resetPassword(user) {
    if (!newPwd || newPwd.length < 6) { setErr("Temporary password must be 6+ characters."); return; }
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_password",
          id: user.id,
          password: newPwd,
          force_change: true,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.error) { setErr(d.error); return; }
      toast.success(`Reset ${user.username} — share the temp password securely.`);
      setResetFor(null); setNewPwd("");
      load();
    } finally { setBusy(false); }
  }

  async function disableUser(user, on) {
    setBusy(true);
    try {
      await fetch("/api/auth/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disable", id: user.id, on }),
      });
      toast.success(on ? `${user.username} disabled` : `${user.username} re-enabled`);
      load();
    } finally { setBusy(false); }
  }

  if (users === null) return <div className="muted">Loading…</div>;

  const youAreAdmin = me && me.role === "admin";
  if (!youAreAdmin) {
    return (
      <div>
        <div className="page-head"><h1>Users</h1></div>
        <div className="card"><p className="muted" style={{ margin: 0 }}>Admins only.</p></div>
      </div>
    );
  }

  const pending = users.filter((u) => u.password_reset_requested);

  return (
    <div>
      <div className="page-head">
        <h1>Users</h1>
        <div className="muted">Add admins, reset passwords, disable accounts. Every login is tracked under the user's name.</div>
      </div>
      {err && <div className="note warn">{err}</div>}

      {pending.length > 0 && (
        <div className="card" style={{ borderColor: "var(--danger)", background: "var(--danger-soft)" }}>
          <h3 style={{ margin: "0 0 6px" }}>{pending.length} password reset{pending.length !== 1 ? "s" : ""} pending</h3>
          <div className="muted small">These users clicked "Forgot password?" — set a temporary password and share it with them. They'll be asked to pick a new one on next sign-in.</div>
        </div>
      )}

      <div className="card">
        <div className="between" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Accounts</h3>
          {!adding && <button className="btn primary" onClick={() => { setAdding(true); setErr(""); }}>Add user</button>}
        </div>

        {adding && (
          <div className="card" style={{ background: "var(--line-soft)" }}>
            <h4 style={{ marginTop: 0 }}>New account</h4>
            <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
              <div style={{ flex: "1 1 180px" }}>
                <label className="fld">Username</label>
                <input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value.toLowerCase() })} placeholder="email or handle" />
              </div>
              <div style={{ flex: "1 1 180px" }}>
                <label className="fld">Display name</label>
                <input value={draft.display_name} onChange={(e) => setDraft({ ...draft, display_name: e.target.value })} placeholder="What shows on the Change Log" />
              </div>
              <div style={{ flex: "1 1 180px" }}>
                <label className="fld">Initial password</label>
                <input type="text" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} placeholder="6+ chars — share this securely" />
              </div>
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn primary" disabled={busy} onClick={addUser}>{busy ? "Adding…" : "Add user"}</button>
              <button className="btn ghost" disabled={busy} onClick={() => { setAdding(false); setErr(""); setDraft({ username: "", display_name: "", password: "" }); }}>Cancel</button>
            </div>
          </div>
        )}

        <div className="stack" style={{ marginTop: 12 }}>
          {users.map((u) => (
            <div key={u.id} className="drag-item" style={{ cursor: "default", flexWrap: "wrap", gap: 8 }}>
              <span style={{ flex: "1 1 220px" }}>
                <b>{u.display_name || u.username}</b>
                <span className="muted small"> · @{u.username}</span>
                {u.role === "admin" ? <span className="chip" style={{ marginLeft: 6 }}>admin</span> : null}
                {u.password_reset_requested
                  ? <span className="chip" style={{ marginLeft: 6, background: "var(--danger-soft)", color: "var(--danger)" }}>Needs reset</span>
                  : null}
                {u.disabled_at
                  ? <span className="chip" style={{ marginLeft: 6, background: "var(--line-soft)" }}>disabled</span>
                  : null}
                {u.must_change_password
                  ? <span className="chip" style={{ marginLeft: 6, background: "var(--accent-soft)", color: "var(--accent)" }}>temp pwd</span>
                  : null}
              </span>
              <div className="btn-row" style={{ flex: "0 0 auto" }}>
                <button className="btn ghost sm" onClick={() => { setResetFor(u); setNewPwd(""); setErr(""); }}>Reset password</button>
                {!u.disabled_at && u.id !== me?.id && (
                  <button className="btn ghost sm" onClick={() => disableUser(u, true)} disabled={busy}>Disable</button>
                )}
                {u.disabled_at && (
                  <button className="btn ghost sm" onClick={() => disableUser(u, false)} disabled={busy}>Re-enable</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {resetFor && (
        <div className="card" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
          <h3 style={{ marginTop: 0 }}>Reset password for <b>{resetFor.display_name || resetFor.username}</b></h3>
          <p className="muted small" style={{ marginTop: 0 }}>
            Pick a temporary password and share it with them through a secure channel (text, in person, etc.).
            They'll sign in with it once and be asked to pick a new one. All their existing sessions will be signed out.
          </p>
          <div className="row" style={{ gap: 10 }}>
            <div style={{ flex: "1 1 240px" }}>
              <label className="fld">Temporary password</label>
              <input type="text" autoFocus value={newPwd} onChange={(e) => setNewPwd(e.target.value)} placeholder="6+ chars" />
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={busy} onClick={() => resetPassword(resetFor)}>{busy ? "Resetting…" : "Reset password"}</button>
            <button className="btn ghost" disabled={busy} onClick={() => { setResetFor(null); setNewPwd(""); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
