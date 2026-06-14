"use client";
import { useState } from "react";

// Add a referee in plain English. Seeds the assistant with an explicit
// create-record instruction so the AI adds an official to the roster.
export default function RefAiBox({ onAsk }) {
  const [text, setText] = useState("");
  if (!onAsk) return null;
  function submit() {
    const t = text.trim();
    if (!t) return;
    onAsk(`Add a new referee to the "referee" record type with these details: ${t}. The referee fields are full_name, phone, league and field — fill in whatever is given and leave the rest blank.`);
    setText("");
  }
  return (
    <div className="aibox">
      <div className="aibox-head"><span className="ai-badge">S-Dot</span> Add a referee</div>
      <p className="muted small">Describe an official in plain English — e.g. “add Jordan Lee, phone 555-0101, works Field 2 in the Junior league”. S-Dot adds them to your roster.</p>
      <div className="aibar">
        <input placeholder="Add a referee — name, phone, field, league…"
          value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        <button className="btn primary" onClick={submit}>Ask S-Dot</button>
      </div>
    </div>
  );
}
