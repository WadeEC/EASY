"use client";
import { useState, useEffect } from "react";
import Section from "./Section.jsx";

// Players and Coaches on one page, with a toggle between them.
// Each list now splits by league (and division for players) — the old Rosters view, built in.
// Tab in URL is tolerant of singular or plural ("coach" or "coaches", "player" or "players").
const normalizeTab = (t) => {
  const v = String(t || "").toLowerCase();
  if (v === "players" || v === "player") return "player";
  if (v === "coaches" || v === "coach") return "coach";
  return v;
};
export default function People({ state, refresh, onAsk, tab }) {
  // Always show both — even when the section is empty or hasn't been seeded — so admins
  // can navigate to it and set it up from the empty state.
  const opts = [["player", "Players"], ["coach", "Coaches"]];
  const want = normalizeTab(tab);
  const initial = opts.some(([n]) => n === want) ? want : opts[0][0];
  const [sel, setSel] = useState(initial);
  // Honor the URL tab once it (or the available types) become known — otherwise a direct
  // link to ?v=people:coaches would always default to Players because state.types arrives async.
  useEffect(() => {
    if (want && opts.some(([n]) => n === want) && want !== sel) setSel(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, state.types.length]);
  const label = state.types.find((t) => t.name === sel)?.label;

  return (
    <div>
      <div className="btn-row" style={{ marginBottom: 16 }}>
        {opts.map(([n, lbl]) => (
          <button key={n} className={"pill" + (sel === n ? " active" : "")} onClick={() => setSel(n)}>{lbl}</button>
        ))}
      </div>
      <Section key={sel} type={sel} label={label} refresh={refresh} onAsk={onAsk} />
    </div>
  );
}
