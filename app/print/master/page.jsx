"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api.js";

// Master season schedule — print-friendly, grouped by Division → Field → Time.
// Designed for a wall print or PDF export (browser "Save as PDF" from the
// print dialog). Each division gets its own page section so coaches can take
// just their division's pages and post them at the field.
//
// Query params:
//   ?league=Saturday Limerick     scope to one league (omit for all leagues)
//   ?division=Ages 11-12          scope to one division
//   ?field=Field 1                scope to one field
function to24(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(t || ""));
  if (!m) return null;
  let h = +m[1]; const mn = +m[2]; const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return { h, m: mn };
}
function fmt12(t) {
  const p = to24(t);
  if (!p) return t || "";
  const h12 = p.h % 12 || 12;
  const ap = p.h < 12 ? "AM" : "PM";
  return `${h12}:${String(p.m).padStart(2, "0")} ${ap}`;
}
function fmtShortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function divisionOf(g) {
  const split = (s) => { const i = String(s || "").indexOf(" / "); return i > 0 ? s.slice(0, i) : ""; };
  return split(g.home_team || g.home || "") || split(g.away_team || g.away || "") || "(no division)";
}
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

// Next.js 14 requires useSearchParams() to live inside a <Suspense> at static
// build time. Wrap the real page in one.
export default function MasterPrintPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40 }}>Loading…</div>}>
      <MasterPrintPageInner />
    </Suspense>
  );
}

function MasterPrintPageInner() {
  const sp = useSearchParams();
  const league = sp.get("league") || "";
  const division = sp.get("division") || "";
  const field = sp.get("field") || "";
  const [games, setGames] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await api.scheduleList(league || null);
      setGames(r.games || []);
    })();
  }, [league]);

  const filtered = useMemo(() => {
    if (!games) return null;
    return games.filter((g) => {
      if (division && divisionOf(g) !== division) return false;
      if (field && (g.location || "") !== field) return false;
      return true;
    });
  }, [games, division, field]);

  // Group: Division → Field → time-sorted games. Each division renders as its
  // own page section so users can detach a single division for posting.
  const grouped = useMemo(() => {
    if (!filtered) return [];
    const byDiv = new Map();
    for (const g of filtered) {
      const dv = divisionOf(g);
      if (!byDiv.has(dv)) byDiv.set(dv, new Map());
      const byField = byDiv.get(dv);
      const f = g.location || "(no field)";
      if (!byField.has(f)) byField.set(f, []);
      byField.get(f).push(g);
    }
    const divs = [...byDiv.keys()].sort(natural);
    return divs.map((dv) => {
      const fields = [...byDiv.get(dv).keys()].sort(natural);
      return {
        division: dv,
        fields: fields.map((f) => ({
          field: f,
          games: byDiv.get(dv).get(f).slice().sort((a, b) => {
            const ta = to24(a.time); const tb = to24(b.time);
            const va = ta ? ta.h * 60 + ta.m : 99999;
            const vb = tb ? tb.h * 60 + tb.m : 99999;
            if (va !== vb) return va - vb;
            return String(a.date).localeCompare(String(b.date));
          }),
        })),
      };
    });
  }, [filtered]);

  if (filtered == null) return <div style={{ padding: 40 }}>Loading…</div>;

  const total = filtered.length;
  const scopeLine = [
    league || "All leagues",
    division ? `Division: ${division}` : null,
    field ? `Field: ${field}` : null,
    `${total} game${total === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");

  return (
    <>
      <style>{`
        @page { size: letter portrait; margin: 0.5in; }
        body { font-family: Arial, "Helvetica Neue", sans-serif; color: #000; background: #fff; }
        .wrap { max-width: 7.5in; margin: 0 auto; padding: 20px; }
        @media print { .no-print { display: none !important; } .wrap { padding: 0; } .div-block { page-break-after: always; } .div-block:last-of-type { page-break-after: auto; } }
        h1 { margin: 0 0 4pt; font-size: 22pt; }
        .scope { color: #555; margin-bottom: 16pt; font-size: 11pt; }
        /* Each division gets a clear chapter heading + breathing room above
           and below so it reads as a distinct section, even when many
           divisions print onto the same page. */
        .div-block { margin-top: 22pt; margin-bottom: 28pt; }
        .div-block:first-of-type { margin-top: 0; }
        .div-head { margin: 0 0 14pt; padding: 6pt 10pt 8pt; font-size: 18pt; line-height: 1.15; border: 2px solid #000; border-left: 8px solid #c8102e; background: #fafafa; }
        .div-head .div-sub { display: block; color: #666; font-size: 11pt; font-weight: 400; margin-top: 3pt; letter-spacing: .3px; }
        .field-block { margin-bottom: 14pt; }
        .field-head { background: #f0f0f0; padding: 5pt 9pt; font-weight: 700; font-size: 12pt; border: 1px solid #000; border-bottom: none; }
        table { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
        th, td { border: 1px solid #000; padding: 5pt 8pt; text-align: left; vertical-align: middle; }
        th { background: #fafafa; font-size: 10pt; }
        td.time { white-space: nowrap; font-weight: 700; font-variant-numeric: tabular-nums; }
        td.date { white-space: nowrap; color: #444; }
        .toolbar { margin-bottom: 16pt; display: flex; gap: 8px; }
        .toolbar button { padding: 8px 16px; font-size: 14px; cursor: pointer; }
      `}</style>

      <div className="wrap">
        <div className="no-print toolbar">
          <button onClick={() => window.print()} style={{ background: "#000", color: "#fff", border: "1px solid #000" }}>Print / Save as PDF</button>
          <button onClick={() => window.close()} style={{ background: "#fff", color: "#000", border: "1px solid #000" }}>Close</button>
        </div>

        <h1>Master schedule</h1>
        <div className="scope">{scopeLine} · <span style={{ color: "#444" }}>HOME team is bold · "@" prefix marks the away team</span></div>

        {grouped.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "#666" }}>No games match this scope.</div>
        )}

        {grouped.map((g) => (
          <section className="div-block" key={g.division}>
            <h2 className="div-head">
              {g.division}
              <span className="div-sub">
                {g.fields.reduce((n, f) => n + f.games.length, 0)} games · {g.fields.length} field{g.fields.length === 1 ? "" : "s"}
              </span>
            </h2>
            {g.fields.map((f) => (
              <div className="field-block" key={f.field}>
                <div className="field-head">{f.field} <span style={{ float: "right", color: "#666", fontWeight: 400 }}>{f.games.length} game{f.games.length === 1 ? "" : "s"}</span></div>
                <table>
                  <thead><tr><th style={{ width: "70pt" }}>Date</th><th style={{ width: "60pt" }}>Time</th><th>Home</th><th>Away</th><th style={{ width: "110pt" }}>League</th><th style={{ width: "110pt" }}>Referee</th></tr></thead>
                  <tbody>
                    {f.games.map((gm) => (
                      <tr key={gm.id}>
                        <td className="date">{fmtShortDate(gm.date)}</td>
                        <td className="time">{fmt12(gm.time)}</td>
                        <td style={{ fontWeight: 800 }}>{gm.home_team || gm.home || ""}</td>
                        <td>@ {gm.away_team || gm.away || ""}</td>
                        <td>{gm.league || ""}</td>
                        <td>{gm.referee || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
