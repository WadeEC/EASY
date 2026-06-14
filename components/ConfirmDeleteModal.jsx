"use client";
import { useEffect, useRef, useState } from "react";

// Hefty confirmation dialog for destructive actions across the app.
//
// Forces the user to type a phrase (default: the target's name in upper case)
// before the Delete button enables. Shows what's being removed, the side
// effects, and whether the action is undoable. Use anywhere we delete or wipe
// data — clearing a saved schedule, removing a player, dropping a section,
// emptying the master spreadsheet, etc.
//
// Props:
//   open        — boolean. Render only when true.
//   title       — short, action-oriented heading ("Clear Saturday Limerick schedule").
//   targetName  — what's being deleted; also the default phrase to type.
//   itemSummary — short description ("768 games across 8 weeks").
//   consequences— optional array of bullet points the user should know.
//   undoNote    — optional note about whether undo is possible ("Undo: not available — saved games are removed permanently.").
//   phrase      — optional phrase override (defaults to upper-case targetName).
//   confirmLabel— button label, default "Delete".
//   busy        — boolean; while truthy the confirm button shows a spinner.
//   onConfirm   — async () => void. Called only after the phrase matches.
//   onCancel    — () => void.
export default function ConfirmDeleteModal({
  open,
  title,
  targetName = "",
  itemSummary = "",
  consequences = [],
  undoNote = "",
  phrase = null,
  confirmLabel = "Delete",
  busy = false,
  onConfirm,
  onCancel,
}) {
  const expected = (phrase || targetName || "DELETE").toString();
  const [typed, setTyped] = useState("");
  const ref = useRef(null);

  // Reset typed value every time the dialog (re)opens for a different target.
  useEffect(() => { if (open) setTyped(""); }, [open, expected]);
  // Auto-focus the phrase input.
  useEffect(() => { if (open) setTimeout(() => ref.current?.focus(), 30); }, [open]);

  if (!open) return null;

  const ready = typed.trim() === expected.trim();

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onCancel?.(); }
    if (e.key === "Enter" && ready && !busy) { e.preventDefault(); onConfirm?.(); }
  }

  return (
    <div className="overlay" onClick={onCancel} onKeyDown={onKey}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540, borderTop: "4px solid var(--danger)" }}>
        <h2 style={{ marginBottom: 6, color: "var(--danger)" }}>{title}</h2>
        {itemSummary && <div className="muted small" style={{ marginBottom: 10 }}>{itemSummary}</div>}

        {consequences.length > 0 && (
          <div className="card" style={{ background: "var(--danger-soft, #fdecef)", padding: "10px 14px", marginBottom: 12 }}>
            <div className="small" style={{ fontWeight: 700, color: "var(--danger)", marginBottom: 4 }}>This will:</div>
            <ul className="small" style={{ margin: "0 0 0 18px", padding: 0 }}>
              {consequences.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
          </div>
        )}

        <label className="fld">
          To confirm, type <code style={{ background: "rgba(0,0,0,0.06)", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>{expected}</code> below.
        </label>
        <input
          ref={ref}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={onKey}
          placeholder={expected}
          autoComplete="off"
          spellCheck={false}
          style={{ fontFamily: "monospace", letterSpacing: 0.5 }}
        />
        {undoNote && <div className="muted small" style={{ marginTop: 6 }}>{undoNote}</div>}

        <div className="btn-row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn danger"
            disabled={!ready || busy}
            onClick={() => ready && !busy && onConfirm?.()}
            title={ready ? "" : "Type the phrase exactly to enable"}
          >
            {busy ? "Deleting…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
