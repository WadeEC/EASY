"use client";
// Tiny global toast system — one stack, used everywhere.
//
// Two ways to fire a toast:
//   1. Call toast.success("Saved") / toast.error("…") from anywhere.
//   2. Don't — the api layer (lib/api.js) auto-fires a toast on every write
//      so adds/saves/assignments confirm without per-component plumbing.
//
// ToastHost mounts the stack. Render it once at the app root.
import { useEffect, useState } from "react";

const EVENT = "ff:toast";

// Module singleton so any file can `import { toast } from "@/lib/toast.jsx"`
// and fire from outside React (api.js, helpers, etc.).
export const toast = {
  show(text, kind = "info", ms = 3000) {
    if (typeof window === "undefined" || !text) return;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { text: String(text), kind, ms } }));
  },
  success(text, ms) { this.show(text, "success", ms); },
  error(text, ms) { this.show(text, "error", ms || 5000); },
  info(text, ms) { this.show(text, "info", ms); },
  // Cancel any toast that's about to fire from a queued api call. Used when a
  // component wants to show its own bespoke message instead of the default.
  silenceNext() {
    if (typeof window === "undefined") return;
    window.__ffToastSilenceUntil = Date.now() + 250;
  },
};

// True when silenceNext() was called in the last 250ms — api.js checks this
// before auto-firing so a component's custom message can win.
export function isSilenced() {
  if (typeof window === "undefined") return false;
  return (window.__ffToastSilenceUntil || 0) > Date.now();
}

export default function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const onToast = (e) => {
      const d = e.detail || {};
      const id = Math.random().toString(36).slice(2) + Date.now();
      const ms = Math.max(800, Number(d.ms) || 3000);
      setItems((prev) => {
        // Coalesce a fast burst of identical toasts (e.g. multi-row saves) so
        // the user sees one chip, not a wall.
        const last = prev[prev.length - 1];
        if (last && last.text === d.text && last.kind === d.kind) {
          last.count = (last.count || 1) + 1;
          last.id = id;     // reset timer
          return [...prev.slice(0, -1), { ...last }];
        }
        return [...prev, { id, text: d.text, kind: d.kind || "info", count: 1 }];
      });
      const dropId = id;
      setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== dropId)), ms);
    };
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);

  if (!items.length) return null;
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={"toast toast-" + t.kind} onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}>
          <span className="toast-dot" aria-hidden="true" />
          <span className="toast-text">{t.text}{t.count > 1 ? ` (×${t.count})` : ""}</span>
        </div>
      ))}
    </div>
  );
}
