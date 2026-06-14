"use client";
import { useEffect, useState } from "react";
import { promptsFor, currentPageId } from "@/lib/page-prompts.js";

// Reusable input bar used by every inline "Or ask S-Dot" card. Renders the
// page-aware quick-chip row above the input so the user can tap a tight prompt
// instead of staring at a blank text field. Calls onSend(text) with whatever
// they pick / type — caller is responsible for routing that to the AI seed.
//
// pageId is optional; if omitted we read it from the URL.
export default function AiPromptBar({ value, onChange, onSend, placeholder, sendLabel = "Ask S-Dot", busy = false, pageId, hint }) {
  const [pid, setPid] = useState(() => pageId || currentPageId());
  useEffect(() => { if (pageId) setPid(pageId); }, [pageId]);
  const list = promptsFor(pid);
  return (
    <>
      <div className="ai-chips" style={{ margin: "4px 0 6px" }}>
        {list.map((p) => (
          <button key={p} type="button" className="ai-chip" disabled={busy} onClick={() => onSend(p)}>{p}</button>
        ))}
      </div>
      {hint && <div className="muted small" style={{ marginBottom: 6 }}>{hint}</div>}
      <div className="aibar">
        <input
          value={value || ""}
          placeholder={placeholder || "Type your own request…"}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (value || "").trim()) onSend((value || "").trim()); }}
          disabled={busy}
        />
        <button className="btn primary" disabled={busy || !(value || "").trim()} onClick={() => onSend((value || "").trim())}>
          {busy ? "…" : sendLabel}
        </button>
      </div>
    </>
  );
}
