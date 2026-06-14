"use client";
import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api.js";

const strip = (s) => String(s || "").replace(/\*\*/g, "");

export default function Chat({ onApplied, embedded }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(null);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);

  async function send(textArg) {
    const text = (typeof textArg === "string" ? textArg : input).trim();
    if (!text || busy) return;
    setInput(""); setToken(null);
    const next = [...messages, { role: "user", content: text }];
    setMessages(next); setBusy(true);
    try {
      const res = await api.agent(next);
      // Apply changes directly — no separate review/confirm step.
      let tok = null;
      if (res.plan && res.plan.length) { const ap = await api.apply(res.plan); tok = ap.token; }
      setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
      if (tok) { setToken(tok); onApplied && onApplied(); }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: "Something went wrong reaching S-Dot." }]);
    }
    setBusy(false);
  }

  async function undo() {
    const res = await api.undo(token);
    setToken(null);
    setMessages((m) => [...m, { role: "assistant", content: res.message }]);
    onApplied && onApplied();
  }

  return (
    <div>
      {!embedded && (
        <div className="page-head">
          <h1>Build &amp; Ask</h1>
          <div className="muted">Describe what you want and S-Dot does it — you can undo any change afterward.</div>
        </div>
      )}

      <div className="chat-wrap">
        {messages.length === 0 && (
          <div className="note info">Ask a question about your data, or tell me to build or change something — it happens right away and you can undo it.</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"msg " + (m.role === "user" ? "user" : "ai")}>
            <div className="bubble" style={{ whiteSpace: "pre-wrap" }}>{strip(m.content)}</div>
          </div>
        ))}
        {busy && <div className="msg ai"><div className="bubble"><span className="spinner" /> Working…</div></div>}
        {token && (
          <div><button className="btn sm" onClick={undo}>Undo these changes</button></div>
        )}
        <div ref={endRef} />
      </div>

      <div className={"chat-input" + (embedded ? " static" : "")}>
        <div className="addbar">
          <input value={input} placeholder="Tell S-Dot what to build…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
          <button className="btn primary" onClick={send} disabled={busy}>{busy ? "Working…" : "Send"}</button>
        </div>
      </div>
    </div>
  );
}
