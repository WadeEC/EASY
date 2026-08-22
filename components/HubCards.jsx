"use client";

// A hub page: one sidebar button opens a page of destination cards.
//
// Used by Season and Settings. Both replaced a collapsed dropdown of bare
// names, which told you nothing about which item you wanted — a card with a
// sentence on it does, and there's room for one on a page.
export default function HubCards({ title, blurb, items, go }) {
  return (
    <div>
      <div className="page-head">
        <h1>{title}</h1>
        {blurb && <div className="muted">{blurb}</div>}
      </div>

      <div className="grid cols-2">
        {items.map((it) => (
          <button
            key={it.title}
            className="card"
            onClick={() => go(it.view)}
            style={{
              textAlign: "left", cursor: "pointer", width: "100%",
              display: "block", border: "1px solid var(--line, #e3e3e8)",
            }}
          >
            <h3 style={{ margin: "0 0 4px" }}>{it.title} <span className="muted" aria-hidden>→</span></h3>
            <p className="muted small" style={{ margin: 0 }}>{it.blurb}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
