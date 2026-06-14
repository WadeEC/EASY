"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import RefAiBox from "./RefAiBox.jsx";

const weekStartISO = (iso) => {
  const d = new Date((String(iso || "")).length <= 10 ? iso + "T00:00:00" : iso);
  if (isNaN(d.getTime())) return "";
  d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
};

// Home for the black-and-white Referee view — officials check in and see their field schedule.
export default function RefHome({ go, onAsk }) {
  const [refs, setRefs] = useState([]);
  const [games, setGames] = useState([]);
  // Canonical league list from the player schema, so the metric reflects the league
  // setup — not just which leagues already have games on the board.
  const [leagueOpts, setLeagueOpts] = useState([]);
  useEffect(() => {
    (async () => {
      try { await api.ensureReferees(); } catch {}
      try { const r = await api.records("referee"); setRefs(r.records || []); } catch {}
      try { const g = await api.scheduleList(null); setGames(g.games || []); } catch {}
      try {
        const s = await api.schema("player");
        const lf = (s.fields || []).find((f) => f.name === "league");
        let opts = []; try { opts = lf && lf.options ? JSON.parse(lf.options) : []; } catch {}
        setLeagueOpts(opts.filter(Boolean));
      } catch {}
    })();
  }, []);

  const today = new Date(); today.setHours(0, 0, 0, 0); today.setDate(today.getDate() - today.getDay());
  const thisSun = today.toISOString().slice(0, 10);
  const fields = [...new Set(games.map((g) => g.location).filter(Boolean))];
  const leagues = [...new Set([...(leagueOpts || []), ...games.map((g) => g.league).filter(Boolean)])];
  const weekGames = games.filter((g) => weekStartISO(g.date) === thisSun).length;

  const metrics = [
    { label: "Referees", value: refs.length, on: () => go({ page: "section", type: "referee" }) },
    { label: "Fields", value: fields.length, on: () => go({ page: "schedule" }) },
    { label: "Games this week", value: weekGames, on: () => go({ page: "schedule" }) },
    { label: "Leagues", value: leagues.length, on: () => go({ page: "schedule" }) },
  ];

  return (
    <div>
      <div className="page-head"><h1>Referee hub</h1><div className="muted">Game-day for officials — check in and see your field schedule.</div></div>

      <RefAiBox onAsk={onAsk} />

      <h2 style={{ margin: "4px 0 10px" }}>At a glance</h2>
      <div className="grid cols-4">
        {metrics.map((m) => (
          <div className="metric clickable" key={m.label} onClick={m.on}>
            <div className="label">{m.label}</div>
            <div className="value">{m.value}</div>
          </div>
        ))}
      </div>

      <h2 style={{ margin: "26px 0 10px" }}>What would you like to do?</h2>
      <div className="grid cols-3">
        <button className="bigtile" onClick={() => go({ page: "schedule" })}>
          <div className="t">Field schedule</div>
          <div className="d">See games by field for the week</div>
        </button>
        <button className="bigtile" onClick={() => go({ page: "section", type: "referee" })}>
          <div className="t">Referees</div>
          <div className="d">Add or edit the officials roster</div>
        </button>
        <button className="bigtile" onClick={() => go({ page: "schedule" })}>
          <div className="t">Check in</div>
          <div className="d">Scan in to pull up your fields for the day</div>
        </button>
      </div>

      {!refs.length && (
        <div className="card" style={{ marginTop: 16 }}>
          <p className="muted" style={{ margin: 0 }}>No referees yet. Add them on the <a onClick={() => go({ page: "section", type: "referee" })}>Referees</a> page and they will show up here.</p>
        </div>
      )}
    </div>
  );
}
