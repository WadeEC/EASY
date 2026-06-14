"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api.js";

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
function fmtFullDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length <= 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

export default function PacketPage() {
  const sp = useSearchParams();
  const date = sp.get("date") || "";
  const field = sp.get("field") || "";
  const leagueFilter = sp.get("league") || "";
  const [games, setGames] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await api.scheduleList(leagueFilter || null);
      const all = r.games || [];
      const filtered = all
        .filter((g) => g.date === date && (g.location || "Field TBD") === field)
        .sort((a, b) => {
          const ta = to24(a.time); const tb = to24(b.time);
          const va = ta ? ta.h * 60 + ta.m : 99999;
          const vb = tb ? tb.h * 60 + tb.m : 99999;
          return va - vb;
        });
      setGames(filtered);
    })();
  }, [date, field, leagueFilter]);

  if (games == null) return <div style={{ padding: 40 }}>Loading…</div>;

  const leagueNames = [...new Set(games.map((g) => g.league).filter(Boolean))];

  return (
    <>
      <style>{`
        @page { size: letter portrait; margin: 0.5in; }
        body { font-family: Arial, "Helvetica Neue", sans-serif; color: #000; background: #fff; }
        .packet { max-width: 7.5in; margin: 0 auto; padding: 20px; }
        @media print {
          .no-print { display: none !important; }
          .page-break { page-break-after: always; }
          .packet { padding: 0; }
        }
        .page-break { page-break-after: always; }
        .cover h1 { font-size: 36pt; margin: 0; letter-spacing: 0.5px; }
        .cover .date { font-size: 16pt; margin: 4pt 0; }
        .cover .meta { color: #555; margin-bottom: 24pt; }
        .sched { width: 100%; border-collapse: collapse; margin-top: 12pt; }
        .sched th, .sched td { border: 1px solid #000; padding: 6pt 8pt; text-align: left; vertical-align: middle; }
        .sched th { background: #f0f0f0; font-size: 10pt; }
        .sched td.time { font-weight: bold; white-space: nowrap; }
        .notes-block { margin-top: 28pt; }
        .notes-block h3 { margin: 0 0 8pt; font-size: 12pt; }
        .blank-line { border-bottom: 1px solid #000; height: 14pt; margin-bottom: 10pt; }
        .blank-line.short { width: 60%; }

        .card-sc { padding: 0; }
        .sc-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #000; padding-bottom: 5pt; margin-bottom: 10pt; }
        .sc-head .title { font-weight: 900; font-size: 18pt; letter-spacing: 1px; }
        .sc-head .meta { font-size: 10pt; color: #333; }
        .matchup { display: flex; justify-content: space-around; align-items: center; gap: 12pt; padding: 10pt 0; border-top: 1px solid #000; border-bottom: 1px solid #000; }
        .matchup .team-block { flex: 1; text-align: center; }
        .matchup .team { font-size: 24pt; font-weight: 800; line-height: 1.1; margin-top: 2pt; }
        .matchup .vs { font-size: 13pt; color: #555; flex: 0 0 auto; }
        .ha-tag { display: inline-block; background: #000; color: #fff; font-size: 9pt; font-weight: 800; letter-spacing: 1.2px; padding: 2pt 8pt; border-radius: 2pt; }
        .ha-tag.away { background: #fff; color: #000; border: 1.5px solid #000; }
        .ha-tag.mini { font-size: 7.5pt; padding: 1pt 5pt; }
        .box { border: 1.2px solid #000; padding: 8pt 10pt; margin-top: 8pt; }
        .box h4 { margin: 0 0 5pt; font-size: 10.5pt; letter-spacing: 1px; text-transform: uppercase; }
        .row-line { display: flex; gap: 18pt; align-items: center; }
        .check { display: inline-block; width: 13pt; height: 13pt; border: 1.5px solid #000; vertical-align: middle; margin-right: 4pt; }
        .grid-score { width: 100%; border-collapse: collapse; margin-top: 4pt; }
        .grid-score th, .grid-score td { border: 1px solid #000; padding: 7pt 8pt; text-align: center; }
        .grid-score th { background: #f0f0f0; }
        .grid-score td.team-name { text-align: left; font-weight: 700; width: 25%; }
        /* Cross-off score tracker — refs slash through numbers as points score.
           Last slashed number = current score. Grouped in tens with a small gap
           so the eye finds the right zone fast on the field. */
        .score-track { margin-top: 4pt; }
        .score-row { display: flex; align-items: stretch; gap: 8pt; margin-top: 6pt; }
        .score-row .team-label { width: 100pt; font-weight: 800; font-size: 10pt; flex: 0 0 auto; display: flex; flex-direction: column; gap: 2pt; justify-content: center; }
        .score-row .team-label .tname { line-height: 1.15; }
        .score-row .nums { display: flex; flex-wrap: wrap; gap: 1pt; flex: 1; align-content: center; }
        .score-row .cell { width: 14pt; height: 14pt; border: 1px solid #000; display: inline-flex; align-items: center; justify-content: center; font-size: 8pt; font-weight: 600; }
        .score-row .cell.sep { margin-right: 3pt; }
        .score-row .final-box { width: 78pt; height: 40pt; border: 2.5px solid #000; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 22pt; font-weight: 900; flex: 0 0 auto; line-height: 1; position: relative; }
        .score-row .final-box::before { content: "FINAL"; position: absolute; top: 2pt; left: 0; right: 0; text-align: center; font-size: 7pt; font-weight: 700; color: #555; letter-spacing: 1px; }
        .score-help { font-size: 8.5pt; color: #555; margin-top: 4pt; }
        .sig-row { margin-top: 16pt; display: flex; gap: 18pt; }
        .sig-row .sig { flex: 1; border-bottom: 1px solid #000; height: 22pt; }
        .sig-row .label { font-size: 9pt; color: #555; margin-top: 2pt; }
      `}</style>

      <div className="packet">
        <div className="no-print" style={{ marginBottom: 20, display: "flex", gap: 8 }}>
          <button onClick={() => window.print()} style={{ padding: "8px 16px", fontSize: 14, border: "1px solid #000", background: "#000", color: "#fff", cursor: "pointer" }}>Print this packet</button>
          <button onClick={() => window.close()} style={{ padding: "8px 16px", fontSize: 14, border: "1px solid #000", background: "#fff", color: "#000", cursor: "pointer" }}>Close</button>
        </div>

        {/* Cover sheet */}
        <div className="cover page-break">
          <h1>{field}</h1>
          <div className="date">{fmtFullDate(date)}</div>
          <div className="meta">{games.length} game{games.length !== 1 ? "s" : ""}{leagueNames.length ? ` · ${leagueNames.join(", ")}` : ""}</div>

          <h3 style={{ margin: "20pt 0 6pt", fontSize: 13 }}>Today's Schedule <span style={{ color: "#666", fontWeight: 400, fontSize: 10 }}>· HOME bold · away regular</span></h3>
          <table className="sched">
            <thead><tr><th>Time</th><th>League</th><th>Home</th><th>Away</th><th>Referee</th></tr></thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.id}>
                  <td className="time">{fmt12(g.time)}</td>
                  <td>{g.league || ""}</td>
                  <td style={{ fontWeight: 800 }}>{g.home_team || g.home}</td>
                  <td>@ {g.away_team || g.away}</td>
                  <td>{g.referee || "—"}</td>
                </tr>
              ))}
              {!games.length && <tr><td colSpan={5} style={{ color: "#666" }}>No games scheduled.</td></tr>}
            </tbody>
          </table>

        </div>

        {/* Scorecards */}
        {games.map((g, i) => (
          <div key={`sc-${g.id}`} className={i < games.length - 1 ? "card-sc page-break" : "card-sc"}>
            <div className="sc-head">
              <div className="title">SCORECARD</div>
              <div className="meta">{fmtFullDate(date).replace(/^(\w+),\s/, "$1 · ")} · {fmt12(g.time)} · {field} · {g.league || ""}</div>
            </div>
            <div className="matchup">
              <div className="team-block">
                <div className="ha-tag">HOME</div>
                <div className="team">{g.home_team || g.home}</div>
              </div>
              <div className="vs">vs.</div>
              <div className="team-block">
                <div className="ha-tag away">AWAY</div>
                <div className="team">{g.away_team || g.away}</div>
              </div>
            </div>

            <div className="box">
              <h4>Coin Toss</h4>
              <div className="row-line"><span><span className="check"></span>{g.home_team || g.home}</span><span><span className="check"></span>{g.away_team || g.away}</span></div>
              <div className="row-line" style={{ marginTop: 6 }}>
                <span><span className="check"></span>Receive</span>
                <span><span className="check"></span>Defer</span>
                <span>Side: __________</span>
              </div>
            </div>

            <div className="box">
              <h4>Score — cross off as points are scored</h4>
              <div className="score-track">
                <ScoreRow label={g.home_team || g.home} prefix="HOME" />
                <ScoreRow label={g.away_team || g.away} prefix="AWAY" />
              </div>
              <div className="score-help">Slash through each number as the running total. The last slashed number is the current score — transfer it into the Final box at the end.</div>
            </div>

            <div className="box">
              <h4>Timeouts <span style={{ fontWeight: 400, fontSize: 9, color: "#555" }}>· 2 per half</span></h4>
              <div className="row-line"><span style={{ width: "120pt", fontWeight: 700 }}>{g.home_team || g.home}</span><span>1H: <span className="check"></span><span className="check"></span></span><span>2H: <span className="check"></span><span className="check"></span></span></div>
              <div className="row-line" style={{ marginTop: 6 }}><span style={{ width: "120pt", fontWeight: 700 }}>{g.away_team || g.away}</span><span>1H: <span className="check"></span><span className="check"></span></span><span>2H: <span className="check"></span><span className="check"></span></span></div>
            </div>

            <div className="sig-row">
              <div style={{ flex: 1 }}>
                <div className="sig" />
                <div className="label">Referee — print</div>
              </div>
              <div style={{ flex: 1 }}>
                <div className="sig" />
                <div className="label">Referee — signature</div>
              </div>
            </div>
          </div>
        ))}

        {games.length === 0 && (
          <div style={{ padding: 40, textAlign: "center", color: "#666" }}>
            No games match this packet. Check the date and field.
          </div>
        )}
      </div>
    </>
  );
}

// One team's score-tracker row: name + numbered cells 1–60 (grouped in fives
// with a tiny gap) + a final-score box. Refs slash a number when that team's
// running total reaches it. The number you slashed last is the live score.
function ScoreRow({ label, prefix = "", max = 90, groupSize = 10 }) {
  const cells = [];
  for (let i = 1; i <= max; i++) {
    const cls = "cell" + (i % groupSize === 0 && i !== max ? " sep" : "");
    cells.push(<span key={i} className={cls}>{i}</span>);
  }
  return (
    <div className="score-row">
      <div className="team-label">
        {prefix && <div className={"ha-tag mini" + (prefix === "AWAY" ? " away" : "")}>{prefix}</div>}
        <div className="tname">{label}</div>
      </div>
      <div className="nums">{cells}</div>
      <div className="final-box" title="Final score">&nbsp;</div>
    </div>
  );
}
