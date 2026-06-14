"use client";
import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api.js";
import { UI_APPLIER_SOURCE } from "@/lib/ui-applier.js";
import { promptsFor, currentPageId, PAGE_LABEL } from "@/lib/page-prompts.js";

function ProviderBadge() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      const h = await api.health();
      if (!cancel) setInfo(h?.llm || null);
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => { cancel = true; clearInterval(id); };
  }, []);
  if (!info) return null;
  const next = info.next_order?.[0] || "—";
  const color = next === "groq" ? "#10b981" : next === "ollama" ? "#6366f1" : "#9ca3af";
  const label = next === "groq" ? "Online · Groq" : next === "ollama" ? "Offline · Local" : next;
  return (
    <span title={`Last: ${info.last_provider || "—"}\nGroq key: ${info.has_groq ? "yes" : "no"}`}
          style={{ marginLeft: 8, fontSize: 11, padding: "2px 7px", borderRadius: 999, background: color, color: "#fff" }}>
      {label}
    </span>
  );
}

const strip = (s) => String(s || "").replace(/\*\*/g, "");

// Inject the client-side UI applier + DOM-snapshot script exactly once.
// It exposes window.__easyApply(op) and window.__easyContext.snapshot().
function useUiApplier() {
  useEffect(() => {
    if (typeof window === "undefined" || window.__easyApplyInstalled) return;
    const s = document.createElement("script");
    s.textContent = UI_APPLIER_SOURCE;
    document.head.appendChild(s);
  }, []);
}

// Floating assistant available on every page. Handles:
//   - Backend data changes via plan + Undo (legacy flow)
//   - Live UI changes via ui_ops (applied immediately)
//   - Warnings, suggestions, the AI's own plan
//   - Pending code-edit approvals with diff view
// localStorage key for per-page conversation history.
const memKey = (pid) => `sdot.history.${pid || "home"}`;
// Keep the last N messages per page — enough for context, not enough to bloat
// localStorage. Older messages drop off the front.
const HISTORY_CAP = 30;

function loadHistory(pid) {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(memKey(pid));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-HISTORY_CAP) : [];
  } catch { return []; }
}
function saveHistory(pid, messages) {
  if (typeof window === "undefined") return;
  try {
    const trimmed = (messages || []).slice(-HISTORY_CAP);
    // Strip transient bits we don't want to persist (UI hooks, code-edit
    // payloads can be huge). Keep the readable bubble + plan + clarify.
    const slim = trimmed.map((m) => ({
      role: m.role,
      content: m.content,
      plan_steps: m.plan_steps,
      warnings: m.warnings,
      suggestions: m.suggestions,
      clarify: m.clarify,
    }));
    localStorage.setItem(memKey(pid), JSON.stringify(slim));
  } catch {}
}

export default function AssistantWidget({ open, setOpen, seed, onApplied }) {
  useUiApplier();
  const [pageId, setPageId] = useState(() => currentPageId());
  // Restore last conversation on mount — so reopening the panel (or coming
  // back to the page later) shows what you were just talking about.
  const [messages, setMessages] = useState(() => loadHistory(currentPageId()));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(null);
  const [pendingCode, setPendingCode] = useState([]);
  const endRef = useRef(null);
  const seedKey = useRef(null);

  // Persist on every change.
  useEffect(() => { saveHistory(pageId, messages); }, [pageId, messages]);
  // Switching pages → swap to that page's saved thread.
  useEffect(() => { setMessages(loadHistory(pageId)); /* eslint-disable-next-line */ }, [pageId]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => setPageId(currentPageId());
    window.addEventListener("popstate", sync);
    // Also react to single-page nav (router uses history.pushState).
    const origPush = window.history.pushState;
    window.history.pushState = function (...args) { origPush.apply(this, args); sync(); };
    return () => {
      window.removeEventListener("popstate", sync);
      window.history.pushState = origPush;
    };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy, open]);

  useEffect(() => {
    if (seed && seed.text && seed.key !== seedKey.current) {
      seedKey.current = seed.key;
      setOpen(true);
      doSend(seed.text);
    }
    // eslint-disable-next-line
  }, [seed]);

  async function doSend(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    setToken(null);
    const next = [...messages, { role: "user", content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const ctx = typeof window !== "undefined" ? window.__easyContext?.snapshot() : null;
      const res = await api.agent(next, ctx);

      // 1. Apply UI ops immediately
      if (res.ui_ops?.length && typeof window !== "undefined") {
        for (const op of res.ui_ops) window.__easyApply?.(op);
      }

      // 2. Apply backend data plan (existing flow)
      let tok = null;
      if (res.plan && res.plan.length) {
        const ap = await api.apply(res.plan);
        tok = ap.token;
      }

      // 3. Track pending code approvals
      if (res.pendingCode?.length) {
        setPendingCode((p) => [...p, ...res.pendingCode]);
      }

      // 4. Build the assistant message bubble with extras
      setMessages((m) => [...m, {
        role: "assistant",
        content: res.reply,
        plan_steps: res.planSteps,
        warnings: res.warnings,
        suggestions: res.suggestions,
        clarify: res.clarify,
        pending_code: res.pendingCode,
        provider: res.provider,
      }]);

      if (tok) { setToken(tok); onApplied && onApplied(); }
      if (res.ui_ops?.length) onApplied && onApplied();
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: "Something went wrong reaching S-Dot." }]);
    }
    setBusy(false);
  }

  function send() { const t = input.trim(); setInput(""); doSend(t); }

  async function undoBackend() {
    const res = await api.undo(token);
    setToken(null);
    setMessages((m) => [...m, { role: "assistant", content: res.message || "Undone." }]);
    onApplied && onApplied();
  }

  async function approveCode(id) {
    const r = await api.codeApprove(id);
    setPendingCode((p) => p.filter((c) => c.id !== id));
    setMessages((m) => [...m, { role: "assistant", content: r.ok ? `Applied code change to ${r.target}.` : `Couldn't apply: ${r.error}` }]);
  }
  async function rejectCode(id) {
    await api.codeReject(id);
    setPendingCode((p) => p.filter((c) => c.id !== id));
    setMessages((m) => [...m, { role: "assistant", content: "Rejected code change." }]);
  }
  function pickSuggestion(s) { setInput(s); }

  return (
    <>
      <button className="fab" title="Ask S-Dot" onClick={() => setOpen(!open)}>{open ? "×" : "S-Dot"}</button>

      {open && (
        <div className="assistant-panel">
          <div className="assistant-head">
            <span>S-Dot<ProviderBadge /></span>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {messages.length > 0 && (
                <button
                  className="btn ghost sm"
                  style={{ fontSize: 12 }}
                  title="Clear this page's conversation history"
                  onClick={() => {
                    setMessages([]);
                    setToken(null);
                    setPendingCode([]);
                    try { localStorage.removeItem(memKey(pageId)); } catch {}
                  }}
                >Clear</button>
              )}
              <button className="btn ghost sm" onClick={() => setOpen(false)}>×</button>
            </div>
          </div>
          <div className="assistant-body">
            {messages.length === 0 && (() => {
              const list = promptsFor(pageId);
              const where = PAGE_LABEL[pageId] || "this page";
              return (
                <div className="note info" style={{ paddingBottom: 14 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>What can I do on {where}?</div>
                  <div className="muted small" style={{ marginBottom: 8 }}>Tap one to get started — or type your own request below.</div>
                  <div className="ai-chips">
                    {list.map((p) => (
                      <button key={p} className="ai-chip" disabled={busy} onClick={() => doSend(p)}>{p}</button>
                    ))}
                  </div>
                </div>
              );
            })()}
            {messages.map((m, i) => (
              <div key={i} className={"msg " + (m.role === "user" ? "user" : "ai")}>
                <div className="bubble" style={{ whiteSpace: "pre-wrap" }}>{strip(m.content)}</div>
                {m.plan_steps?.length > 0 && (
                  <div className="ai-plan">
                    <div className="ai-plan-title">Plan</div>
                    <ol>{m.plan_steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
                  </div>
                )}
                {m.warnings?.length > 0 && m.warnings.map((w, j) => (
                  <div key={j} className={"ai-warn " + (w.severity || "warn")}>
                    ⚠️ {w.message}{w.affected_count != null && <span className="ai-warn-count"> ({w.affected_count} affected)</span>}
                  </div>
                ))}
                {m.clarify && (
                  <div className="ai-clarify">
                    <div className="ai-clarify-q">{m.clarify.question}</div>
                    {m.clarify.options?.map((o, j) => (
                      <button key={j} className="btn sm" onClick={() => doSend(o)}>{o}</button>
                    ))}
                  </div>
                )}
                {m.pending_code?.length > 0 && m.pending_code.map((c) => (
                  <CodeApprovalCard key={c.id} change={c} onApprove={approveCode} onReject={rejectCode} />
                ))}
                {m.suggestions?.length > 0 && (
                  <div className="ai-suggest">
                    {m.suggestions.map((s, j) => (
                      <button key={j} className="ai-suggest-chip" onClick={() => pickSuggestion(s)}>💡 {s}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <div className="msg ai"><div className="bubble"><span className="spinner" /> Working…</div></div>}
            {token && <button className="btn sm" onClick={undoBackend}>Undo these changes</button>}
            <div ref={endRef} />
          </div>
          <div className="assistant-foot">
            {/* Page-aware quick chips kept under the input even mid-conversation
                so the next short follow-up is one click away. Suppressed when
                the panel is empty (the intro card already shows them). */}
            {messages.length > 0 && (() => {
              const list = promptsFor(pageId);
              return (
                <div className="ai-chips" style={{ padding: "0 8px 6px" }}>
                  {list.map((p) => (
                    <button key={p} className="ai-chip" disabled={busy} onClick={() => doSend(p)}>{p}</button>
                  ))}
                </div>
              );
            })()}
            {/* Multi-line auto-growing input — Enter sends, Shift+Enter inserts
                a newline so long requests stay visible while the user types. */}
            <div className="addbar" style={{ alignItems: "stretch" }}>
              <GrowTextarea
                value={input}
                onChange={setInput}
                onSend={send}
                disabled={busy}
                placeholder="Ask… (Shift+Enter for new line)"
              />
              <button className="btn primary" onClick={send} disabled={busy} style={{ alignSelf: "stretch" }}>{busy ? "…" : "Send"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Textarea that auto-grows with content (single line until you wrap or paste
// something long). Enter submits; Shift+Enter adds a newline so multi-line
// prompts stay readable.
function GrowTextarea({ value, onChange, onSend, disabled, placeholder }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.style.height = "auto";
    // Cap at ~6 lines so the textarea doesn't take over the whole panel.
    const max = 6 * 22 + 16; // line-height 22 + padding
    el.style.height = Math.min(el.scrollHeight, max) + "px";
  }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSend?.();
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      style={{
        flex: 1,
        border: "none",
        outline: "none",
        resize: "none",
        padding: "10px 12px",
        fontSize: 15,
        lineHeight: "22px",
        fontFamily: "inherit",
        background: "transparent",
        minWidth: 0,
        overflow: "auto",
      }}
    />
  );
}

function CodeApprovalCard({ change, onApprove, onReject }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-codecard">
      <div className="ai-codecard-head">
        <span>📝 <b>{change.target}</b></span>
        <button className="btn ghost sm" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} diff</button>
      </div>
      <div className="ai-codecard-reason">{change.reason}</div>
      {open && <pre className="ai-diff">{change.diff}</pre>}
      <div className="ai-codecard-actions">
        <button className="btn primary sm" onClick={() => onApprove(change.id)}>Apply</button>
        <button className="btn ghost sm" onClick={() => onReject(change.id)}>Reject</button>
      </div>
    </div>
  );
}
