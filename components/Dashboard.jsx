"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api.js";
import ImportPlayers from "./ImportPlayers.jsx";
import Chat from "./Chat.jsx";

export default function Dashboard({ state, go, refresh, onAsk }) {
  const [flags, setFlags] = useState([]);
  const [seeding, setSeeding] = useState(false);
  const [tool, setTool] = useState(null); // null | "import" | "teams"

  useEffect(() => {
    let on = true;
    (async () => {
      const res = await api.flags();
      if (on) setFlags(res.flags || []);
    })();
    return () => { on = false; };
  }, [state.types]);

  if (!state.types.length) {
    return (
      <div>
        <div className="page-head"><h1>Welcome</h1></div>
        <div className="card">
          <h2>Let’s set up your league</h2>
          <p className="muted">Create a standard Players section (five townships + two leagues) so you can upload
            rosters right away — or ask S-Dot to build whatever you want.</p>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn primary" disabled={seeding}
              onClick={async () => { setSeeding(true); await api.seed(); await refresh(); setSeeding(false); }}>
              {seeding ? "Setting up…" : "Set up standard Players"}
            </button>
            <button className="btn" onClick={() => onAsk && onAsk("Help me set up my league for the season")}>Ask S-Dot</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head"><h1>Home</h1></div>

      <h2 style={{ margin: "4px 0 10px" }}>At a glance</h2>
      {flags.some((f) => f.active) ? (
        <div className="grid cols-4">
          {flags.filter((f) => f.active).map((f) => (
            <div className="metric clickable" key={f.id} onClick={() => go({ page: "section", type: f.record_type })}>
              <div className="label">{f.label}</div>
              <div className={"value" + (f.count ? " warn" : "")}>{f.count}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>No flags yet. Set them up in <a onClick={() => go({ page: "leagues" })}>Leagues &amp; Assignment → Home flags</a> to watch for things like players with no league or a missing jersey size.</p>
        </div>
      )}

      <h2 style={{ margin: "26px 0 10px" }}>What would you like to do?</h2>
      <div className="grid cols-3">
        <button className={"bigtile" + (tool === "import" ? " active" : "")} onClick={() => setTool(tool === "import" ? null : "import")}>
          <div className="t">Add &amp; Import Players</div>
          <div className="d">Upload a CSV or Excel roster from a township</div>
        </button>
        <button className="bigtile" onClick={() => go({ page: "teambuilder", tab: "build" })}>
          <div className="t">Build Teams</div>
          <div className="d">Make balanced teams automatically</div>
        </button>
        <button className="bigtile" onClick={() => go({ page: "people" })}>
          <div className="t">View Leagues</div>
          <div className="d">See players by league and division</div>
        </button>
      </div>

      {tool === "import" && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="between" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Add &amp; Import Players</h2>
            <button className="btn ghost sm" onClick={() => setTool(null)}>Close</button>
          </div>
          <ImportPlayers onDone={refresh} go={go} />
          <div className="muted small" style={{ marginTop: 10 }}>
            Prefer to type players in one at a time? <a onClick={() => go({ page: "section", type: "player" })}>Open the Players page</a>.
          </div>
        </div>
      )}

      <h2 style={{ margin: "26px 0 10px" }}>Build &amp; Ask</h2>
      <p className="muted small" style={{ margin: "-4px 0 10px" }}>Ask about your data or tell S-Dot to build/change something — you review every change before it’s applied.</p>
      <Chat embedded onApplied={refresh} />

      <div className="card" style={{ marginTop: 20 }}>
        <b>Settings</b>
        <div className="muted" style={{ marginTop: 4 }}>
          Set up leagues, townships, divisions &amp; rules in <a onClick={() => go({ page: "leagues" })}>Leagues &amp; Assignment</a>,
          or schema and history in <a onClick={() => go({ page: "advanced" })}>Advanced</a>.
        </div>
      </div>
    </div>
  );
}
